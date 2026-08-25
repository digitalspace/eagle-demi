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
    const mixed = [
      { operationType: 'Upsert', partitionKey: 'p', resource: { id: 'u1' } },
      { operationType: 'Patch', partitionKey: 'p', id: 'p1', resourceBody: {} }
    ];
    const res = await bulkVerified('documents', mixed, {
      maxAttempts: 1,
      bulkFn: async (pending) => pending.map(() => ({ statusCode: 429 }))
    });
    assert.deepStrictEqual(res.failedIds, ['u1', 'p1']);
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
