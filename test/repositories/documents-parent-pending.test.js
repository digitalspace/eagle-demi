'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const documents = require('../../src/repositories/documents');

/**
 * The "this document's chunks are stale" flag, on the rows where losing it costs most.
 *
 * The container holds three kinds of partition key and they are not interchangeable: a project id,
 * `''` for a document linked to no project, and JSON `null`. Only the last two carry documents
 * nobody browses by project, so a flag write that misses them fails where nothing else would
 * notice. These assertions read the partition key that reaches the data layer, because a key that
 * is the right SHAPE but the wrong VALUE — `'null'` for `null` — answers 404 and the flag is simply
 * never written.
 */

const DOC_ID = '5d0d212c7d50161b92a80eed';

/** Record every patch instead of issuing one; there is no Cosmos to issue it against. */
function recordPatches(t, fail) {
  const calls = [];
  t.mock.method(cosmos, 'patch', async (container, id, partitionKey, operations, condition, etag) => {
    calls.push({ container, id, partitionKey, operations, condition, etag });
    if (fail) throw Object.assign(new Error(`cosmos ${fail}`), { code: fail });
    return {};
  });
  return calls;
}

/** The row the null-partition lookup finds, and the row a raise reads its current token off. */
function stubRow(t, row) {
  t.mock.method(cosmos, 'queryFirst', async () => row);
  t.mock.method(cosmos, 'readItem', async () => row);
}

const valueOf = (calls, path) => calls[0].operations.find(op => op.path === path).value;

test('setParentFieldsPending addresses the partition the document actually lives in', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a JSON-null projectId reaches Cosmos as null, not the string "null"', async () => {
    stubRow(t, { id: DOC_ID, projectId: null, read: ['public'] });
    const calls = recordPatches(t);

    await documents.setParentFieldsPending(DOC_ID, null, true);

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].partitionKey, null,
      'String(null) is "null", a partition no document lives in, so the patch 404s');
    assert.strictEqual(calls[0].id, DOC_ID);
    assert.strictEqual(valueOf(calls, '/parentFieldsPending'), true);
  });

  await t.test('clearing the flag on a null-partition document reaches the same partition', async () => {
    stubRow(t, { id: DOC_ID, projectId: null, read: ['public'] });
    const calls = recordPatches(t);

    const result = await documents.setParentFieldsPending(DOC_ID, null, false);

    assert.deepStrictEqual(result, { status: 'cleared', pendingAt: null });
    assert.strictEqual(calls[0].partitionKey, null);
    assert.strictEqual(valueOf(calls, '/parentFieldsPending'), false);
    assert.strictEqual(valueOf(calls, '/parentFieldsPendingAt'), null,
      'the timestamp goes with the flag it dates');
  });

  await t.test('the null partition is pinned directly, with no lookup', async () => {
    // JSON null is a partition Cosmos addresses like any other (`[null]` on the wire). Only an
    // UNKNOWN project needs the cross-partition lookup, and folding null into that spent a drain of
    // up to 50 pages on every flag write for a document nobody browses by project.
    let queried = false;
    t.mock.method(cosmos, 'queryFirst', async () => { queried = true; return null; });
    const reads = [];
    t.mock.method(cosmos, 'readItem', async (container, id, partitionKey) => {
      reads.push({ id, partitionKey });
      return { id, projectId: null, read: ['public'] };
    });
    const calls = recordPatches(t);

    await documents.setParentFieldsPending(DOC_ID, null, true);

    assert.strictEqual(queried, false, 'null is a partition, not an absent one');
    assert.deepStrictEqual(reads, [{ id: DOC_ID, partitionKey: null }]);
    assert.strictEqual(calls[0].partitionKey, null);
  });

  await t.test('a document purged before the flag lands is not patched', async () => {
    // No project at all, so there is a lookup to fail — the row is gone before anything is written.
    t.mock.method(cosmos, 'queryFirst', async () => null);
    const calls = recordPatches(t);

    assert.deepStrictEqual(await documents.setParentFieldsPending(DOC_ID, undefined, true),
      { status: 'missing', reason: 'lookup' });
    assert.deepStrictEqual(calls, []);
  });

  await t.test('a row that disappears between the lookup and the write says so', async () => {
    // Distinct from the case above: the caller knows the patch was attempted, so a document that
    // vanished mid-run is not confused with one that was never there.
    stubRow(t, { id: DOC_ID, projectId: '207', read: ['public'] });
    recordPatches(t, 404);

    assert.deepStrictEqual(await documents.setParentFieldsPending(DOC_ID, '207', false),
      { status: 'missing', reason: 'patch' });
  });

  await t.test('the empty-string partition is pinned directly, with no lookup', async () => {
    let queried = false;
    t.mock.method(cosmos, 'queryFirst', async () => { queried = true; return null; });
    t.mock.method(cosmos, 'readItem', async () => null);
    const calls = recordPatches(t);

    await documents.setParentFieldsPending(DOC_ID, '', true);

    assert.strictEqual(calls[0].partitionKey, '', "'' is a real partition, not an absent one");
    assert.strictEqual(queried, false, 'a known partition costs no cross-partition lookup');
  });

  await t.test('a guard that is not an object throws, rather than being read as an etag', async () => {
    const calls = recordPatches(t);

    await assert.rejects(
      () => documents.setParentFieldsPending(DOC_ID, '207', false, '"0x8DC1"'),
      TypeError);
    assert.deepStrictEqual(calls, [], 'nothing is written on a refused guard');
  });
});

/**
 * The token form of the guard.
 *
 * An etag says "this row has not been written since I read it", which an extraction patch or a
 * display-name push from Eagle also answers no to — so the clear 412'd on writes that had nothing
 * to do with the flag, and the flag stayed raised for good. The token says "the flag is still the
 * one I was raised for", which is the only question a clear needs answered.
 */
test('setParentFieldsPending clears against the pending token', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const TOKEN = '2026-09-10T17:04:05.123Z';

  await t.test('the token becomes a patch condition on the stored timestamp', async () => {
    const calls = recordPatches(t);

    const result = await documents.setParentFieldsPending(DOC_ID, '207', false, { pendingAt: TOKEN });

    assert.strictEqual(calls[0].condition,
      `FROM c WHERE c.parentFieldsPendingAt = "${TOKEN}"`);
    assert.strictEqual(calls[0].etag, undefined,
      'an unrelated write must not fail this clear, which is what the etag did');
    assert.deepStrictEqual(result, { status: 'cleared', pendingAt: null });
  });

  await t.test('a 412 is a conflict the caller reads, not a throw it must catch', async () => {
    recordPatches(t, 412);

    assert.deepStrictEqual(
      await documents.setParentFieldsPending(DOC_ID, '207', false, { pendingAt: TOKEN }),
      { status: 'conflict', pendingAt: TOKEN });
  });

  await t.test('a token that is not an ISO instant never reaches the condition', async () => {
    // The SDK's patch condition is a raw string with no parameter binding, so the only safe value
    // is one this repository minted. Anything else is refused rather than interpolated.
    const calls = recordPatches(t);

    for (const bad of ["2026-09-10T17:04:05.123Z' OR 1=1 --", '2026-09-10', 'null', '']) {
      await assert.rejects(
        () => documents.setParentFieldsPending(DOC_ID, '207', false, { pendingAt: bad }),
        /not an ISO instant/);
    }
    assert.deepStrictEqual(calls, [], 'nothing is written on a refused token');
  });

  await t.test('a raise ignores the caller guard and uses its own condition', async () => {
    // A caller does not get to name the token a raise writes: the only safe one is minted from what
    // is stored. The guard is the CLEAR's argument.
    stubRow(t, { id: DOC_ID, projectId: '207', parentFieldsPendingAt: TOKEN });
    const calls = recordPatches(t);

    const result = await documents.setParentFieldsPending(DOC_ID, '207', true, { pendingAt: TOKEN });

    assert.ok(!calls[0].condition.includes(`= "${TOKEN}"`),
      'the guard must not become an equality condition on a raise');
    assert.strictEqual(calls[0].etag, undefined);
    assert.strictEqual(result.status, 'raised');
  });

  await t.test('the raised token is the one written, and it beats the value on the row', async () => {
    // A caller clears on the token it was handed back, so a token that does not match what landed
    // clears nothing, and one that repeats the previous value lets an older run clear a newer flag.
    const future = new Date(Date.now() + 60000).toISOString();
    stubRow(t, { id: DOC_ID, projectId: '207', parentFieldsPendingAt: future });
    const calls = recordPatches(t);

    const result = await documents.setParentFieldsPending(DOC_ID, '207', true);

    assert.strictEqual(result.pendingAt, valueOf(calls, '/parentFieldsPendingAt'));
    assert.ok(result.pendingAt > future, `${result.pendingAt} must be later than ${future}`);
  });
});

/**
 * Two raisers on one row.
 *
 * `freshPendingAt` mints from the value the raiser READ, so two raisers that read the same row mint
 * the same token. Written unconditionally, both raises land the same value — and then the first
 * one's clear, guarded on that token, takes the second one's flag down and the drift it recorded is
 * never re-stamped. The raise has to be a test-and-set: write this token only while nothing that
 * already beats it is stored.
 */
test('setParentFieldsPending raises conditionally', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const TOKEN = '2026-09-10T17:04:05.123Z';

  await t.test('the condition refuses a token the stored one already beats', async () => {
    stubRow(t, { id: DOC_ID, projectId: '207', parentFieldsPendingAt: TOKEN });
    const calls = recordPatches(t);

    const result = await documents.setParentFieldsPending(DOC_ID, '207', true);

    assert.strictEqual(calls[0].condition,
      'FROM c WHERE NOT IS_STRING(c.parentFieldsPendingAt) ' +
      `OR c.parentFieldsPendingAt < "${result.pendingAt}"`);
    assert.ok(result.pendingAt > TOKEN, 'and the token it writes beats the stored one');
  });

  await t.test('a cleared row, whose token is JSON null, still raises', async () => {
    // The clear writes `parentFieldsPendingAt: null` rather than removing the path, and in Cosmos
    // SQL `null < "2026-…"` is undefined, not true. An IS_DEFINED-only condition would therefore
    // 412 every raise after the first clear — that is, every raise the system ever makes.
    stubRow(t, { id: DOC_ID, projectId: '207', parentFieldsPending: false, parentFieldsPendingAt: null });
    const calls = recordPatches(t);

    await documents.setParentFieldsPending(DOC_ID, '207', true);

    assert.match(calls[0].condition, /NOT IS_STRING\(c\.parentFieldsPendingAt\)/,
      'the disjunct that admits null and absent alike');
  });

  await t.test('a 412 re-reads and re-mints off the token that actually landed', async () => {
    const WINNER = '2026-09-10T18:00:00.000Z';
    let read = 0;
    // First read sees the stale row; the raiser that beat us wrote WINNER before our patch.
    t.mock.method(cosmos, 'readItem', async () => (++read === 1
      ? { id: DOC_ID, projectId: '207', parentFieldsPendingAt: TOKEN }
      : { id: DOC_ID, projectId: '207', parentFieldsPendingAt: WINNER }));

    const calls = [];
    t.mock.method(cosmos, 'patch', async (container, id, partitionKey, operations, condition) => {
      calls.push({ operations, condition });
      if (calls.length === 1) throw Object.assign(new Error('cosmos 412'), { code: 412 });
      return {};
    });

    const result = await documents.setParentFieldsPending(DOC_ID, '207', true);

    assert.strictEqual(read, 2, 'the retry re-reads rather than re-sending a token already beaten');
    assert.strictEqual(result.status, 'raised');
    assert.ok(result.pendingAt > WINNER,
      `${result.pendingAt} must beat the winner's ${WINNER}, not the stale ${TOKEN}`);
    assert.strictEqual(result.pendingAt,
      calls[1].operations.find(op => op.path === '/parentFieldsPendingAt').value);
  });

  await t.test('losing every race throws rather than reporting a token nobody owns', async () => {
    // The caller clears on the token it was handed. Returning one that is not stored would clear
    // nothing, and the flag would stand until an operator ran the backfill.
    stubRow(t, { id: DOC_ID, projectId: '207', parentFieldsPendingAt: TOKEN });
    const calls = recordPatches(t, 412);

    await assert.rejects(() => documents.setParentFieldsPending(DOC_ID, '207', true),
      /lost 3 races/);
    assert.strictEqual(calls.length, documents.RAISE_MAX_TRIES, 'bounded, not a spin');
  });

  await t.test('a 404 on the raise is still a missing row, not a lost race', async () => {
    stubRow(t, null);
    recordPatches(t, 404);

    assert.deepStrictEqual(await documents.setParentFieldsPending(DOC_ID, '207', true),
      { status: 'missing', reason: 'patch' });
  });
});

/**
 * The same raise for a writer that sets the flag INLINE on a row it is already upserting.
 *
 * An upsert replaces the whole item, so it cannot carry the patch condition above. The etag is the
 * only guard left, which is why `documents.upsert` takes one.
 */
test('pendingRaiseOps is the raise an upsert writer inlines', async (t) => {
  await t.test('it mints the same token setParentFieldsPending would', async () => {
    const stored = '2026-09-10T17:04:05.123Z';
    const ops = documents.pendingRaiseOps(stored);

    assert.strictEqual(ops.parentFieldsPending, true);
    assert.ok(ops.parentFieldsPendingAt > stored,
      'a repeated token lets an older run clear a newer flag');
    assert.deepStrictEqual(Object.keys(ops).sort(),
      ['parentFieldsPending', 'parentFieldsPendingAt']);
  });

  await t.test('a row that carries no token yet still gets one', async () => {
    const ops = documents.pendingRaiseOps(undefined);
    assert.ok(!Number.isNaN(Date.parse(ops.parentFieldsPendingAt)));
  });
});

test('documents.upsert can be guarded on the row revision', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('the etag travels to the data layer', async () => {
    const calls = [];
    t.mock.method(cosmos, 'upsert', async (container, item, options) => {
      calls.push({ container, item, options });
      return item;
    });

    await documents.upsert({ id: DOC_ID, projectId: '207' }, { etag: '"0x8DC1"' });

    assert.deepStrictEqual(calls[0].options, { etag: '"0x8DC1"' });
  });

  await t.test('an unguarded upsert is unchanged, as every existing caller expects', async () => {
    const calls = [];
    t.mock.method(cosmos, 'upsert', async (container, item, options) => {
      calls.push({ item, options });
      return item;
    });

    await documents.upsert({ id: DOC_ID, projectId: '207' });

    assert.deepStrictEqual(calls[0].options, { etag: undefined });
  });

  await t.test('a lost race surfaces as code 412, whichever field the SDK put it on', async () => {
    for (const thrown of [{ code: 412 }, { statusCode: 412 }]) {
      t.mock.method(cosmos, 'upsert', async () => {
        throw Object.assign(new Error('cosmos said no'), thrown);
      });

      await assert.rejects(
        () => documents.upsert({ id: DOC_ID, projectId: '207' }, { etag: '"0x8DC1"' }),
        (err) => err.code === 412 && /lost its etag race/.test(err.message));
      t.mock.restoreAll();
    }
  });

  await t.test('any other failure is passed through untouched', async () => {
    t.mock.method(cosmos, 'upsert', async () => {
      throw Object.assign(new Error('cosmos 429'), { code: 429 });
    });

    await assert.rejects(() => documents.upsert({ id: DOC_ID }, { etag: '"0x8DC1"' }),
      (err) => err.code === 429);
  });
});

test('freshPendingAt mints a token no earlier run can own', async (t) => {
  await t.test('a first raise takes the clock', () => {
    const before = Date.now();
    const minted = documents.freshPendingAt(undefined);
    assert.ok(Date.parse(minted) >= before && Date.parse(minted) <= Date.now());
  });

  await t.test('never repeats the value already on the row', () => {
    // Two raises inside one millisecond otherwise mint the same token, and the first one's clear
    // takes the second one's flag down — the drift is then invisible to the reconcile.
    const now = new Date().toISOString();
    assert.ok(documents.freshPendingAt(now) > now);
  });

  await t.test('a clock that went backwards still moves the token forward', () => {
    const ahead = new Date(Date.now() + 3600000).toISOString();
    assert.strictEqual(documents.freshPendingAt(ahead),
      new Date(Date.parse(ahead) + 1).toISOString());
  });

  await t.test('an unparseable stored value is ignored, not propagated', () => {
    assert.ok(!Number.isNaN(Date.parse(documents.freshPendingAt('not a date'))));
  });
});

test('getById reads the partition it was given, empty string included', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test("'' is a point read, not a cross-partition query", async () => {
    // A truthiness test sent `''` down the cross-partition branch, whose single page can come back
    // empty on a container this size — and the re-stamp reads that as "document no longer exists"
    // and drops the message.
    let queried = false;
    t.mock.method(cosmos, 'queryFirst', async () => { queried = true; return null; });
    const reads = [];
    t.mock.method(cosmos, 'readItem', async (container, id, partitionKey) => {
      reads.push({ id, partitionKey });
      return { id, projectId: '', read: ['public'] };
    });

    const doc = await documents.getById({ tier: 'public', roles: ['public'] }, DOC_ID, '');

    assert.deepStrictEqual(reads, [{ id: DOC_ID, partitionKey: '' }]);
    assert.strictEqual(queried, false, 'the unlinked partition is a partition, not an absent one');
    assert.ok(doc, 'the document in it must come back');
  });

  await t.test('no project at all still goes cross-partition', async () => {
    let queried = false;
    t.mock.method(cosmos, 'queryFirst', async () => { queried = true; return null; });
    t.mock.method(cosmos, 'readItem', async () => {
      throw new Error('a point read needs a partition key, and there is none');
    });

    assert.strictEqual(
      await documents.getById({ tier: 'public', roles: ['public'] }, DOC_ID), null);
    assert.strictEqual(queried, true);
  });

  await t.test('the cross-partition read drains pages rather than sampling one', async () => {
    // The bug this pins is silent: one page of a cross-partition lookup can come back empty while
    // the row exists, so a single fetchNext reports a live document as deleted. The draining is
    // `queryFirst`'s (test/db/cosmos-nosql.test.js); what matters here is that the lookup uses it.
    let paged = false;
    t.mock.method(cosmos, 'query', async () => { paged = true; return { items: [] }; });
    t.mock.method(cosmos, 'queryFirst', async () =>
      ({ id: DOC_ID, projectId: '207', read: ['public'] }));
    t.mock.method(cosmos, 'readItem', async () => null);

    const doc = await documents.getById({ tier: 'public', roles: ['public'] }, DOC_ID);

    assert.strictEqual(doc.id, DOC_ID);
    assert.strictEqual(paged, false, 'a single page is not an answer about an id');
  });
});
