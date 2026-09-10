'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { bulk, bulkVerified } = require('../../src/db/cosmos-nosql');

// Cosmos rejects a whole bulk REQUEST — not individual operations — when serverless throughput
// runs out, and the SDK surfaces that as a thrown error with no per-operation statuses. Measured
// 2026-08-03: one 30 MB document streams ~60 bulk calls back to back, dev could not keep up, and
// the throw escaped the retry loop and failed the ingest. These tests are that path.
const RU = () => Object.assign(new Error(
  'Bulk request errored with: The request rate is too large.'), { code: 429 });

const ops = (n) => Array.from({ length: n }, (_, i) => ({ operationType: 'Upsert', id: `c${i}` }));
const ok = (list) => list.map(() => ({ statusCode: 200 }));
const fast = { maxAttempts: 4 };

test('bulkVerified retries a THROWN bulk failure', async (t) => {
  await t.test('a transient throw is retried and then succeeds', async () => {
    let calls = 0;
    const res = await bulkVerified('chunks', ops(5), {
      ...fast,
      bulkFn: async (pending) => {
        calls++;
        if (calls === 1) throw RU();
        return ok(pending);
      }
    });

    assert.strictEqual(calls, 2, 'the throw must be retried, not surfaced');
    assert.strictEqual(res.succeeded, 5);
    assert.strictEqual(res.failed, 0);
    assert.strictEqual(res.statusCounts.thrown, 1, 'and the throw must still be visible');
  });

  await t.test('the SAME operations are retried — nothing is dropped on a throw', async () => {
    // If `pending` were cleared on a throw, the retry would write nothing and report success,
    // which is the silent-under-write failure this whole function exists to prevent.
    const seen = [];
    let calls = 0;
    await bulkVerified('chunks', ops(3), {
      ...fast,
      bulkFn: async (pending) => {
        calls++;
        seen.push(pending.map(o => o.id));
        if (calls === 1) throw RU();
        return ok(pending);
      }
    });

    assert.deepStrictEqual(seen[0], seen[1], 'the retry must resend the same operations');
    assert.deepStrictEqual(seen[1], ['c0', 'c1', 'c2']);
  });

  await t.test('a throw on EVERY attempt surfaces the error rather than a bare count', async () => {
    // The caller has no per-operation detail to act on, so a silent {failed: n} would strip the
    // one piece of information that says what to do about it.
    await assert.rejects(
      () => bulkVerified('chunks', ops(2), {
        maxAttempts: 2, bulkFn: async () => { throw RU(); }
      }),
      /request rate is too large/i
    );
  });

  await t.test('partial success across a throw is still reported, not thrown', async () => {
    // Once anything has landed, the caller CAN act on the count, and throwing away the succeeded
    // tally would make a retry look like it had done nothing.
    let calls = 0;
    const res = await bulkVerified('chunks', ops(4), {
      maxAttempts: 3,
      bulkFn: async (pending) => {
        calls++;
        if (calls === 1) return pending.map((_, i) => ({ statusCode: i < 2 ? 200 : 429 }));
        throw RU();
      }
    });

    assert.strictEqual(res.succeeded, 2);
    assert.strictEqual(res.failed, 2);
    assert.ok(res.statusCounts.thrown >= 1);
  });

  await t.test('failedIds names the rows still unwritten, for Upsert and Patch shapes alike', async () => {
    // `resourceBody` is the Upsert shape every caller in this repo builds — documents
    // `bulkUpsertForProject`, chunks `upsertBatch` and `replaceForDocument` all use it. An earlier
    // version of this fixture used `resource`, which nothing emits, so `failedIds` came back as a
    // row of `undefined` in production while this stayed green. The seed and the List-id backfill
    // both filter their chunk re-stamp on these ids, so undefined there re-stamps the chunks of
    // documents whose row never landed.
    const mixed = [
      { operationType: 'Upsert', partitionKey: 'p', resourceBody: { id: 'u1' } },
      { operationType: 'Patch', partitionKey: 'p', id: 'p1', resourceBody: {} },
      { operationType: 'Upsert', partitionKey: 'p', resource: { id: 'u2' } }
    ];
    const res = await bulkVerified('documents', mixed, {
      maxAttempts: 1,
      bulkFn: async (pending) => pending.map(() => ({ statusCode: 429 }))
    });
    assert.deepStrictEqual(res.failedIds, ['u1', 'p1', 'u2']);
  });

  await t.test('per-operation failures still retry exactly as before', async () => {
    let calls = 0;
    const res = await bulkVerified('chunks', ops(3), {
      ...fast,
      bulkFn: async (pending) => {
        calls++;
        return calls === 1
          ? pending.map((_, i) => ({ statusCode: i === 0 ? 200 : 429 }))
          : ok(pending);
      }
    });

    assert.strictEqual(res.succeeded, 3);
    assert.strictEqual(res.failed, 0);
    assert.strictEqual(res.statusCounts.thrown, undefined, 'nothing threw, so nothing to record');
  });
});

/**
 * A bulk response SHORTER than the request.
 *
 * The SDK builds its result array by sparse index assignment from what the service answered
 * (@azure/cosmos 4.10.0, dist/commonjs/client/Item/Items.js:504-506) and never reconciles it
 * against the operations sent, so a truncated or empty response is structurally possible — and with
 * `continueOnError: false` it is what a rejected batch produces. Iterating the RESPONSE dropped the
 * tail: those operations were never counted, never retried and never named in `failedIds`, so the
 * caller was told the batch landed.
 */
test('bulkVerified treats an unanswered operation as failed, not as written', async (t) => {
  await t.test('a truncated response retries the tail rather than losing it', async () => {
    let calls = 0;
    const res = await bulkVerified('chunks', ops(5), {
      ...fast,
      bulkFn: async (pending) => {
        calls++;
        // Two of five answered on the first attempt; the rest simply are not there.
        return calls === 1 ? ok(pending).slice(0, 2) : ok(pending);
      }
    });

    assert.strictEqual(calls, 2, 'the unanswered tail must come back for another attempt');
    assert.strictEqual(res.succeeded, 5);
    assert.strictEqual(res.failed, 0);
    assert.strictEqual(res.statusCounts.unanswered, 3, 'and the silence must still be visible');
  });

  await t.test('an empty response never reads as a clean batch', async () => {
    const res = await bulkVerified('chunks', ops(3), {
      maxAttempts: 1,
      bulkFn: async () => []
    });

    assert.strictEqual(res.succeeded, 0);
    assert.strictEqual(res.failed, 3);
    assert.deepStrictEqual(res.failedIds, ['c0', 'c1', 'c2'],
      'a caller acting on the subset that landed must be told nothing did');
  });

  await t.test('an unanswered operation is named in failedIds when the attempts run out', async () => {
    const res = await bulkVerified('chunks', ops(4), {
      maxAttempts: 1,
      bulkFn: async (pending) => ok(pending).slice(0, 1)
    });

    assert.strictEqual(res.succeeded, 1);
    assert.deepStrictEqual(res.failedIds, ['c1', 'c2', 'c3']);
  });
});

// RU is the variable cost on a serverless account. The figure has to include what was paid for
// REJECTED work, or the number understates the bill in exactly the case worth watching — a
// throttled ingest, where the same operations are billed on every attempt.
test('bulkVerified reports the RU actually billed', async (t) => {
  await t.test('charges from a retried attempt are added, not replaced', async () => {
    let calls = 0;
    const res = await bulkVerified('chunks', ops(3), {
      ...fast,
      bulkFn: async (pending) => {
        calls++;
        return calls === 1
          // First attempt: one write lands, two are throttled — and all three are charged.
          ? pending.map((_, i) => ({ statusCode: i === 0 ? 200 : 429, requestCharge: 5 }))
          : pending.map(() => ({ statusCode: 200, requestCharge: 5 }));
      }
    });

    assert.strictEqual(res.succeeded, 3);
    // 3 charged on attempt one (including the two rejects) + 2 charged again on the retry.
    assert.strictEqual(res.requestCharge, 25);
  });

  await t.test('a thrown attempt contributes nothing, because no charges came back', async () => {
    let calls = 0;
    const res = await bulkVerified('chunks', ops(2), {
      ...fast,
      bulkFn: async (pending) => {
        calls++;
        if (calls === 1) throw RU();
        return pending.map(() => ({ statusCode: 200, requestCharge: 4 }));
      }
    });

    assert.strictEqual(res.requestCharge, 8);
  });

  await t.test('a driver that omits requestCharge yields 0, never NaN', async () => {
    const res = await bulkVerified('chunks', ops(2), { ...fast, bulkFn: async (p) => ok(p) });

    assert.strictEqual(res.requestCharge, 0, 'a missing charge must not poison the sum');
  });
});

// Cosmos rejects a bulk REQUEST carrying more than 100 operations. `bulk()` splits for that, and
// the split only ever matters on a large partition — the seeder's 8,000-document projects — so a
// regression here would surface in production and nowhere else.
test('bulk splits requests at the 100-operation ceiling', async (t) => {
  // Records what each request received. `bulk()` reads `container.items.bulk`, so the fake only
  // has to satisfy that one path.
  const spyContainer = (respond) => {
    const sent = [];
    const containerFn = () => ({ items: { bulk: async (chunk) => { sent.push(chunk); return respond(chunk, sent.length); } } });
    return { sent, containerFn };
  };

  await t.test('250 operations go out as 100 / 100 / 50', async () => {
    const { sent, containerFn } = spyContainer((chunk) => chunk.map(() => ({ statusCode: 200 })));

    const res = await bulk('chunks', ops(250), { containerFn });

    assert.deepStrictEqual(sent.map(c => c.length), [100, 100, 50]);
    assert.strictEqual(res.length, 250, 'one result per input operation, not per request');
  });

  await t.test('an exact multiple of 100 does not emit a trailing empty request', async () => {
    // `i += 100` over a length-200 array stops at 200, but an off-by-one here would send a third,
    // empty request that Cosmos rejects outright.
    const { sent, containerFn } = spyContainer((chunk) => chunk.map(() => ({ statusCode: 200 })));

    await bulk('chunks', ops(200), { containerFn });

    assert.deepStrictEqual(sent.map(c => c.length), [100, 100]);
  });

  await t.test('results come back in INPUT order, not request-completion order', async () => {
    // The concatenation is what lets `bulkVerified` line result[i] up with operations[i]. If the
    // order slipped, it would retry the wrong operations and report success for ones that failed.
    const { containerFn } = spyContainer((chunk) => chunk.map(op => ({ statusCode: 200, id: op.id })));

    const res = await bulk('chunks', ops(250), { containerFn });

    assert.deepStrictEqual(res.map(r => r.id).slice(0, 3), ['c0', 'c1', 'c2']);
    assert.strictEqual(res[249].id, 'c249', 'the last operation must land last');
  });

  await t.test('a throw mid-way discards the earlier results rather than returning a short array', async () => {
    // The dangerous failure is a SILENT one: returning the first 100 results after the second
    // request died would tell `bulkVerified` that 100 operations succeeded and the other 150 were
    // never attempted — indistinguishable from a partition that only had 100 rows.
    const { sent, containerFn } = spyContainer((chunk, n) => {
      if (n === 2) throw Object.assign(new Error('Bulk request errored with: The request rate is too large.'), { code: 429 });
      return chunk.map(() => ({ statusCode: 200 }));
    });

    await assert.rejects(
      () => bulk('chunks', ops(250), { containerFn }),
      /request rate is too large/,
      'the throw must reach the caller, which is what makes bulkVerified retry the whole batch'
    );
    assert.strictEqual(sent.length, 2, 'and the third request must never be sent');
  });

  await t.test('no operations means no request at all', async () => {
    const { sent, containerFn } = spyContainer((chunk) => chunk.map(() => ({ statusCode: 200 })));

    assert.deepStrictEqual(await bulk('chunks', [], { containerFn }), []);
    assert.strictEqual(sent.length, 0);
  });

  await t.test('without a container it returns [] rather than throwing', async () => {
    // This is the no-Cosmos-client case the seam exists to work around, and it must stay harmless:
    // the scripts import this module long before they connect.
    assert.deepStrictEqual(await bulk('chunks', ops(5), { containerFn: () => null }), []);
  });
});

/**
 * A SUSTAINED throttle, not a transient one.
 *
 * Measured 2026-09 on the serverless test account: a full chunk-parent walk of ~1M PATCH operations
 * came back {200: 1004569, 412: 12248, 429: 523144, thrown: 291} and left 70 documents part-stamped
 * with 99,633 operations rejected. Four attempts of 1s/2s/3s spend the whole budget inside the same
 * overload, so the budget, the doubling, the 20s ceiling and Cosmos's own hint are pinned here.
 */
test('bulkVerified sits out a sustained throttle', async (t) => {
  // Records the wait instead of spending it: a full eight-attempt backoff is over a minute of real
  // time, which no unit test can afford to sleep through.
  const recorder = () => {
    const waits = [];
    return { waits, sleepFn: async (ms) => { waits.push(ms); } };
  };
  const withinJitter = (waited, floor, label) => assert.ok(
    waited >= floor && waited <= floor + 250,
    `${label}: waited ${waited}, expected ${floor} plus at most 250ms of jitter`
  );

  await t.test("a thrown 429 waits at least the SDK's retryAfterInMs", async () => {
    // `retryAfterInMs` on the ErrorResponse is the only figure that knows when the partition has
    // budget again; the first exponential step is 1s, which would resend into the same overload.
    const { waits, sleepFn } = recorder();
    let calls = 0;
    const res = await bulkVerified('chunks', ops(2), {
      sleepFn,
      bulkFn: async (pending) => {
        calls++;
        if (calls === 1) throw Object.assign(RU(), { retryAfterInMs: 5000 });
        return ok(pending);
      }
    });

    assert.strictEqual(waits.length, 1);
    withinJitter(waits[0], 5000, 'the server hint must win over the first step');
    assert.strictEqual(res.succeeded, 2);
  });

  await t.test('a per-operation retry hint is honoured the same way', async () => {
    const { waits, sleepFn } = recorder();
    let calls = 0;
    await bulkVerified('chunks', ops(2), {
      sleepFn,
      bulkFn: async (pending) => {
        calls++;
        return calls === 1
          ? pending.map(() => ({ statusCode: 429, retryAfterMilliseconds: 6000 }))
          : ok(pending);
      }
    });

    assert.strictEqual(waits.length, 1);
    withinJitter(waits[0], 6000, 'the operation result hint must win over the first step');
  });

  await t.test('per-operation 429s get eight attempts, doubling to a 20s ceiling', async () => {
    const { waits, sleepFn } = recorder();
    let calls = 0;
    const res = await bulkVerified('chunks', ops(3), {
      sleepFn,
      bulkFn: async (pending) => { calls++; return pending.map(() => ({ statusCode: 429 })); }
    });

    assert.strictEqual(calls, 8, 'four attempts is the budget the corpus walk ran out of');
    [1000, 2000, 4000, 8000, 16000, 20000, 20000].forEach((floor, i) =>
      withinJitter(waits[i], floor, `wait ${i + 1}`));
    assert.strictEqual(waits.length, 7, 'no wait after the last attempt');
    assert.strictEqual(res.succeeded, 0);
    assert.strictEqual(res.failed, 3);
    assert.strictEqual(res.statusCounts[429], 24, 'every attempt is still counted, as before');
    assert.deepStrictEqual(res.failedIds, ['c0', 'c1', 'c2']);
  });

  await t.test('a 412 is answered once and never retried, however long the 429s go on', async () => {
    // A precondition that did not hold is Cosmos's answer, not a throttle. Widening the budget for
    // 429 must not start paying eight requests for a decision already made.
    const { sleepFn } = recorder();
    const sent = [];
    const res = await bulkVerified('chunks', ops(2), {
      sleepFn,
      bulkFn: async (pending) => {
        sent.push(pending.map(o => o.id));
        return pending.map(op => ({ statusCode: op.id === 'c0' ? 412 : 429 }));
      }
    });

    assert.strictEqual(sent.length, 8, 'the 429 keeps its full budget');
    assert.deepStrictEqual(sent[0], ['c0', 'c1']);
    assert.ok(sent.slice(1).every(ids => ids.join() === 'c1'), 'the 412 must not be resent');
    assert.strictEqual(res.statusCounts[412], 1, 'counted once, not once per attempt');
    assert.deepStrictEqual(res.skippedIds, ['c0']);
    assert.deepStrictEqual(res.failedIds, ['c1']);
  });
});
