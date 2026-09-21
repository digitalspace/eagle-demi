'use strict';

/**
 * A re-post of chunks already stored must not upsert them again: every upsert is billed on the
 * serverless account, and one client retried the same document 553 times. Driven through the
 * controller, so each post carries the fresh `parentStampedAt` a real ingest stamps.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');

const chunks = require('../../src/repositories/chunks');
const documents = require('../../src/repositories/documents');
const cosmos = require('../../src/db/cosmos-nosql');
const aiSearch = require('../../src/search/ai-search');
const { logger } = require('../../src/utils/logger');
const documentController = require('../../src/controllers/nosql/document');
const { systemAccess } = require('../../src/helpers/access-sql');
const {
  mockRes, STAFF, storedDocument, DOCUMENT_EAGLE_ID: DOC
} = require('../helpers/eagle-mirror-fixtures');

const START = Date.parse('2026-09-21T00:00:00.000Z');
const section = (topic) => `Sentence about ${topic} water quality. `.repeat(60);
// Three chunks, and the closing line lands in the last one only.
const MARKDOWN = ['# One', section('turbidity'), '# Two', section('flow'), '# Three',
  section('sediment'), 'Results follow.'].join('\n\n');

/**
 * A one-partition container in memory: queries answer the projection from what was written, every
 * bulk call is recorded and applied, and a guarded Patch is refused by a row stamped at least as new.
 */
function fakeContainer(t) {
  const rows = new Map();
  // Cosmos's own `_ts`, kept apart so a row read back as an item is not hashed with it.
  const writtenAt = new Map();
  const calls = [];
  t.mock.method(cosmos, 'query', async (container, spec, options) => {
    cosmos.assertQuerySpec(spec, container);
    assert.strictEqual(options.partitionKey, DOC, 'reads stay inside the document partition');
    const named = spec.parameters.filter(p => p.name.startsWith('@id')).map(p => p.value);
    const ids = (named.length > 0 ? named : [...rows.keys()]).filter(id => rows.has(id));
    const items = spec.query.includes('VALUE c.id')
      ? ids
      : ids.map(id => ({
        id, itemHash: rows.get(id).itemHash, parentStampedAt: rows.get(id).parentStampedAt,
        _ts: writtenAt.get(id)
      }));
    return { items, continuationToken: undefined };
  });
  const apply = async (container, operations) => {
    calls.push(operations);
    const skippedIds = [];
    for (const op of operations) {
      if (op.operationType === 'Upsert') {
        rows.set(op.resourceBody.id, op.resourceBody);
        writtenAt.set(op.resourceBody.id, Math.floor(Date.now() / 1000));
      }
      if (op.operationType === 'Delete') rows.delete(op.id);
      if (op.operationType === 'Patch') {
        const row = rows.get(op.id);
        const set = Object.fromEntries(op.resourceBody.operations.map(o => [o.path.slice(1), o.value]));
        if (op.resourceBody.condition && row.parentStampedAt >= set.parentStampedAt) {
          skippedIds.push(op.id);
        } else {
          Object.assign(row, set);
        }
      }
    }
    return { succeeded: operations.length - skippedIds.length, failed: 0, skippedIds,
      statusCounts: {}, requestCharge: 1 };
  };
  t.mock.method(cosmos, 'bulkVerified', apply);
  const upserts = () => calls.flat().filter(op => op.operationType === 'Upsert');
  return { rows, writtenAt, calls, upserts, apply };
}

function postJson(markdown) {
  const res = mockRes();
  return documentController.ingestChunks({
    params: { id: DOC }, query: {}, user: STAFF, body: { markdown }
  }, res).then(() => res);
}

function postNdjson(markdown) {
  const res = mockRes();
  const lines = [JSON.stringify({ extraction: { method: 'docling' } }), JSON.stringify(markdown)];
  return documentController.ingestChunks({
    params: { id: DOC }, query: {}, user: STAFF,
    is: (type) => type === 'application/x-ndjson',
    stream: Readable.from([lines.join('\n')])
  }, res).then(() => res);
}

/** The controller path with a live clock that moves a minute between posts, as a retry would. */
function ingestHarness(t, doc = storedDocument()) {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  t.mock.method(documents, 'getById', async () => doc);
  t.mock.method(documents, 'patchExtraction', async () => ({}));
  return fakeContainer(t);
}

for (const [name, post] of [['JSON ingest', postJson], ['NDJSON ingest', postNdjson]]) {
  test(`${name} skips chunks whose stored hash matches`, async (t) => {
    t.afterEach(() => t.mock.restoreAll());

    await t.test('an identical re-post issues no write', async (tt) => {
      const store = ingestHarness(tt);
      assert.strictEqual((await post(MARKDOWN)).statusCode, 200);
      const first = store.upserts().length;
      const stamps = [...store.rows.values()].map(r => r.parentStampedAt);
      store.calls.length = 0;

      tt.mock.timers.tick(60_000);
      assert.strictEqual((await post(MARKDOWN)).statusCode, 200);

      assert.ok(first > 1, 'the first post wrote nothing, so the case below is vacuous');
      assert.deepStrictEqual(store.calls.flat(), []);
      assert.deepStrictEqual([...store.rows.values()].map(r => r.parentStampedAt), stamps);
    });

    await t.test('one changed chunk is the only upsert', async (tt) => {
      const store = ingestHarness(tt);
      await post(MARKDOWN);
      store.calls.length = 0;

      tt.mock.timers.tick(60_000);
      await post(MARKDOWN.replace('Results follow.', 'Results follow, edited.'));

      assert.strictEqual(store.upserts().length, 1);
      assert.match(store.upserts()[0].resourceBody.content, /edited/);
      assert.strictEqual(store.upserts()[0].resourceBody.parentStampedAt,
        new Date(START + 60_000).toISOString());
    });

    await t.test('a moved parent field rewrites every chunk', async (tt) => {
      const doc = storedDocument();
      const store = ingestHarness(tt, doc);
      await post(MARKDOWN);
      const count = store.rows.size;
      store.calls.length = 0;

      doc.typeId = 'type-moved';
      tt.mock.timers.tick(60_000);
      await post(MARKDOWN);

      assert.strictEqual(store.upserts().length, count);
    });
  });
}

/**
 * A chunk a failed delete or purge took out of the index but left in Cosmos is never re-read by
 * the `_ts` high-water mark, so an identical re-post must rewrite it rather than skip it forever.
 */
for (const [name, post] of [['JSON ingest', postJson], ['NDJSON ingest', postNdjson]]) {
  test(`${name} heals an unchanged chunk the index lost`, async (t) => {
    t.afterEach(() => t.mock.restoreAll());
    const settled = 31 * 60_000;

    await t.test('only the chunk missing from the index is rewritten', async (tt) => {
      const store = ingestHarness(tt);
      await post(MARKDOWN);
      const [lost, ...held] = [...store.rows.keys()];
      tt.mock.method(aiSearch, 'indexedChunkIds', async () => new Set(held));
      store.calls.length = 0;

      tt.mock.timers.tick(settled);
      assert.strictEqual((await post(MARKDOWN)).statusCode, 200);

      assert.ok(held.length > 0, 'one chunk only, so "only the lost one" is vacuous');
      assert.deepStrictEqual(store.upserts().map(op => op.resourceBody.id), [lost]);
    });

    await t.test('chunks the index holds are still skipped', async (tt) => {
      const store = ingestHarness(tt);
      await post(MARKDOWN);
      tt.mock.method(aiSearch, 'indexedChunkIds', async (ids) => new Set(ids));
      store.calls.length = 0;

      tt.mock.timers.tick(settled);
      await post(MARKDOWN);

      assert.deepStrictEqual(store.calls.flat(), []);
    });

    await t.test('a chunk is looked up from 30 minutes after its write, not before', async (tt) => {
      const store = ingestHarness(tt);
      await post(MARKDOWN);
      const lookup = tt.mock.method(aiSearch, 'indexedChunkIds', async (ids) => new Set(ids));
      store.calls.length = 0;

      tt.mock.timers.tick(29 * 60_000);
      await post(MARKDOWN);
      assert.strictEqual(lookup.mock.callCount(), 0);

      tt.mock.timers.tick(60_000);
      await post(MARKDOWN);
      assert.strictEqual(lookup.mock.callCount(), 1);
      assert.deepStrictEqual(store.calls.flat(), []);
    });

    await t.test('a row with no _ts is not settled, so it is not looked up', async (tt) => {
      const store = ingestHarness(tt);
      await post(MARKDOWN);
      store.writtenAt.clear();
      const lookup = tt.mock.method(aiSearch, 'indexedChunkIds', async () => new Set());
      store.calls.length = 0;

      tt.mock.timers.tick(settled);
      await post(MARKDOWN);

      assert.strictEqual(lookup.mock.callCount(), 0);
      assert.deepStrictEqual(store.calls.flat(), []);
    });

    await t.test('an index that cannot answer keeps the skip', async (tt) => {
      const store = ingestHarness(tt);
      await post(MARKDOWN);
      tt.mock.method(aiSearch, 'indexedChunkIds', async () => null);
      store.calls.length = 0;

      tt.mock.timers.tick(settled);
      await post(MARKDOWN);

      assert.deepStrictEqual(store.calls.flat(), []);
    });
  });
}

/**
 * An index that lost most of a document reads as indexer lag, and a real gap heals a capped number
 * of chunks per ingest: either way a settled re-post never turns into a blind re-upsert.
 */
test('healing is capped', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const cap = chunks.MAX_HEALED_PER_INGEST;
  const MANY = Array.from({ length: 4 * cap }, (_, i) => `# Part ${i}\n\n${section(`p${i}`)}`)
    .join('\n\n');

  async function settledStore(tt) {
    const store = ingestHarness(tt);
    await postJson(MANY);
    store.calls.length = 0;
    tt.mock.timers.tick(31 * 60_000);
    return store;
  }

  await t.test('an index missing most chunks rewrites none', async (tt) => {
    const store = await settledStore(tt);
    const held = [...store.rows.keys()].slice(0, cap);
    tt.mock.method(aiSearch, 'indexedChunkIds', async () => new Set(held));
    const warned = tt.mock.method(logger, 'warn', () => {});

    assert.strictEqual((await postJson(MANY)).statusCode, 200);

    assert.ok(store.rows.size > 2 * (cap + 5), `only ${store.rows.size} chunks; vacuous`);
    assert.deepStrictEqual(store.calls.flat(), []);
    assert.ok(warned.mock.calls.some(c => /indexer lag/.test(c.arguments[0])));
  });

  await t.test('a gap under half heals at most the cap per ingest', async (tt) => {
    const store = await settledStore(tt);
    const ids = [...store.rows.keys()];
    const lost = ids.slice(0, cap + 5);
    tt.mock.method(aiSearch, 'indexedChunkIds', async () => new Set(ids.slice(cap + 5)));

    await postJson(MANY);

    assert.deepStrictEqual(store.upserts().map(op => op.resourceBody.id), lost.slice(0, cap));
  });

  // A streamed ingest writes in flushes of 200, and the cap is per ingest, not per flush.
  await t.test('a streamed ingest heals at most the cap across all its flushes', async (tt) => {
    const LONG = Array.from({ length: 600 }, (_, i) => `# Part ${i}\n\n${section(`p${i}`)}`)
      .join('\n\n');
    const store = ingestHarness(tt);
    await postNdjson(LONG);
    store.calls.length = 0;
    tt.mock.timers.tick(31 * 60_000);
    const ids = [...store.rows.keys()];
    // Every fifth chunk lost: under half of each flush, and over the cap in total.
    tt.mock.method(aiSearch, 'indexedChunkIds', async () => new Set(ids.filter((_, i) => i % 5)));
    const warned = tt.mock.method(logger, 'warn', () => {});

    assert.strictEqual((await postNdjson(LONG)).statusCode, 200);

    assert.ok(ids.length > 200 && ids.length / 5 > cap, `${ids.length} chunks; vacuous`);
    assert.strictEqual(store.upserts().length, cap);
    const healed = warned.mock.calls.map(c => /healed=(\d+)/.exec(c.arguments[0]))
      .filter(Boolean).reduce((sum, m) => sum + Number(m[1]), 0);
    assert.strictEqual(healed, cap);
  });
});

test('a skipped re-post keeps the stamp contract', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a walk older than the kept stamp still cannot overwrite the fields', async (tt) => {
    const doc = storedDocument();
    const store = ingestHarness(tt, doc);
    await postJson(MARKDOWN);
    tt.mock.timers.tick(60_000);
    await postJson(MARKDOWN);

    const stale = new Date(START - 60_000).toISOString();
    const walk = await chunks.setParentFieldsForDocument(systemAccess(), DOC,
      { ...doc, typeId: 'type-stale' }, { stampedAt: stale });

    assert.strictEqual(walk.skippedNewer, store.rows.size);
    for (const row of store.rows.values()) assert.strictEqual(row.typeId, doc.typeId);
  });

  await t.test('a row a walk patched is rewritten by the next re-post', async (tt) => {
    const doc = storedDocument();
    const store = ingestHarness(tt, doc);
    await postJson(MARKDOWN);
    tt.mock.timers.tick(60_000);
    await chunks.setParentFieldsForDocument(systemAccess(), DOC,
      { ...doc, typeId: 'type-walked' }, { stampedAt: new Date(Date.now()).toISOString() });
    store.calls.length = 0;

    tt.mock.timers.tick(60_000);
    await postJson(MARKDOWN);

    assert.strictEqual(store.upserts().length, store.rows.size);
    for (const row of store.rows.values()) assert.strictEqual(row.typeId, doc.typeId);
  });

  await t.test('a stored chunk with no stamp is rewritten', async (tt) => {
    const store = ingestHarness(tt);
    await postJson(MARKDOWN);
    for (const row of store.rows.values()) delete row.parentStampedAt;
    store.calls.length = 0;

    tt.mock.timers.tick(60_000);
    await postJson(MARKDOWN);

    assert.strictEqual(store.upserts().length, store.rows.size);
  });

  await t.test('a stored chunk with no hash is rewritten', async (tt) => {
    const store = ingestHarness(tt);
    await postJson(MARKDOWN);
    for (const row of store.rows.values()) delete row.itemHash;
    store.calls.length = 0;

    await postJson(MARKDOWN);

    assert.strictEqual(store.upserts().length, store.rows.size);
    for (const row of store.rows.values()) assert.ok(row.itemHash, 'the rewrite stores a hash');
  });
});

test('replaceForDocument still deletes the surplus when nothing else changed', async (t) => {
  const store = ingestHarness(t);
  await postJson(MARKDOWN);
  const kept = [...store.rows.keys()].slice(0, -1);
  const dropped = [...store.rows.keys()].at(-1);
  const items = kept.map(id => store.rows.get(id));
  store.calls.length = 0;

  await chunks.replaceForDocument(systemAccess(), DOC, items);

  assert.deepStrictEqual(store.calls.flat().map(op => [op.operationType, op.id]),
    [['Delete', dropped]]);
  t.mock.restoreAll();
});

test('upsertBatch reads only the ids of its own batch', async (t) => {
  const store = ingestHarness(t);
  await postJson(MARKDOWN);
  const [first, second] = [...store.rows.values()];
  store.calls.length = 0;

  await chunks.upsertBatch(systemAccess(), DOC, [{ ...second, content: 'changed' }]);

  const spec = cosmos.query.mock.calls.at(-1).arguments[1];
  assert.deepStrictEqual(spec.parameters.filter(p => p.name.startsWith('@id')).map(p => p.value),
    [second.id]);
  assert.notStrictEqual(first.id, second.id);
  assert.strictEqual(store.upserts().length, 1);
  t.mock.restoreAll();
});

// The chunks indexer tracks `_ts` only, so a chunk deleted from Cosmos stays searchable unless the
// ingest removes it from the index by name — and it must do so first, or a retry cannot find it.
const LONGER = [MARKDOWN, '# Four', section('salinity'), '# Five', section('oxygen')].join('\n\n');
const SHORTER = ['# One', section('turbidity')].join('\n\n');
const NONE_KEPT = { stillIndexed: [], indexUnconfigured: [] };

for (const [name, post] of [['JSON ingest', postJson], ['NDJSON ingest', postNdjson]]) {
  test(`${name} removes dropped chunks from the search index first`, async (t) => {
    t.afterEach(() => t.mock.restoreAll());

    /** A store holding LONGER's chunks, and the ids a post of SHORTER would drop. */
    async function seeded(tt) {
      const store = ingestHarness(tt);
      const unindex = tt.mock.method(aiSearch, 'deleteChunksByIds', async () => NONE_KEPT);
      await post(LONGER);
      const full = new Map(store.rows);
      await post(SHORTER);
      const dropped = [...full.keys()].filter(id => !store.rows.has(id)).sort();
      assert.ok(dropped.length > 1, `dropped ${dropped.length} of ${full.size}, so the case is vacuous`);

      store.rows.clear();
      for (const [id, row] of full) store.rows.set(id, row);
      unindex.mock.restore();
      return { store, dropped };
    }

    await t.test('the dropped ids leave the index while Cosmos still holds them', async (tt) => {
      const { store, dropped } = await seeded(tt);
      const heldAtUnindex = [];
      const unindex = tt.mock.method(aiSearch, 'deleteChunksByIds', async (ids) => {
        heldAtUnindex.push(...ids.filter(id => store.rows.has(id)));
        return NONE_KEPT;
      });

      const res = await post(SHORTER);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(unindex.mock.callCount(), 1);
      assert.deepStrictEqual([...unindex.mock.calls[0].arguments[0]].sort(), dropped);
      assert.deepStrictEqual(heldAtUnindex.sort(), dropped, 'Cosmos deleted before the index');
      assert.ok(dropped.every(id => !store.rows.has(id)));
    });

    await t.test('a re-post that drops nothing leaves the index alone', async (tt) => {
      ingestHarness(tt);
      const unindex = tt.mock.method(aiSearch, 'deleteChunksByIds', async () => NONE_KEPT);
      await post(MARKDOWN);
      await post(MARKDOWN);

      assert.strictEqual(unindex.mock.callCount(), 0);
    });

    /** Patches that counted this request toward the repeated-failure lockout. */
    const countedFailures = () => documents.patchExtraction.mock.calls
      .filter(c => 'chunkIngestFailures' in c.arguments[2]);

    for (const reason of ['stillIndexed', 'indexUnconfigured']) {
      await t.test(`ids kept for ${reason} stay in Cosmos: an uncounted 503`, async (tt) => {
        const { store, dropped } = await seeded(tt);
        const [kept, ...landed] = dropped;
        tt.mock.method(aiSearch, 'deleteChunksByIds', async () => ({ ...NONE_KEPT, [reason]: [kept] }));
        const logged = tt.mock.method(logger, 'error', () => {});
        const before = countedFailures().length;

        const res = await post(SHORTER);

        assert.strictEqual(res.statusCode, 503);
        assert.match(res.body.error, /search index delete failed, retry/);
        assert.match(res.body.error, new RegExp(reason));
        assert.strictEqual(countedFailures().length, before, 'a search failure counted toward lockout');
        assert.match(logged.mock.calls[0].arguments[0], /Chunk ingest failed/);
        assert.ok(store.rows.has(kept), 'a chunk still indexed left Cosmos, so no retry can find it');
        assert.ok(landed.every(id => !store.rows.has(id)), 'the unindexed chunks were not deleted');
      });
    }

    await t.test('a Cosmos write failure beside a kept id is still a counted 500', async (tt) => {
      const { dropped } = await seeded(tt);
      tt.mock.method(aiSearch, 'deleteChunksByIds', async () => ({ ...NONE_KEPT, stillIndexed: [dropped[0]] }));
      // Swapped on the harness's own mock: a second mock of the same method leaks past the test.
      // Only a write carrying a Delete fails: the JSON path's one write, the NDJSON path's surplus
      // delete once its batches have landed.
      cosmos.bulkVerified.mock.mockImplementation(async (container, operations) => {
        const failed = operations.some(op => op.operationType === 'Delete') ? 1 : 0;
        return { succeeded: operations.length - failed, failed, skippedIds: [],
          failedIds: operations.slice(0, failed).map(op => op.id),
          statusCounts: failed ? { 429: 1 } : {}, requestCharge: 1 };
      });
      tt.mock.method(logger, 'error', () => {});
      const before = countedFailures().length;

      const res = await post(SHORTER);

      assert.strictEqual(res.statusCode, 500);
      assert.strictEqual(countedFailures().length, before + 1);
    });

    await t.test('an unindexed chunk whose Cosmos delete failed is removed by the next post', async (tt) => {
      const { store, dropped } = await seeded(tt);
      const [stuck] = dropped;
      const unindex = tt.mock.method(aiSearch, 'deleteChunksByIds', async () => NONE_KEPT);
      tt.mock.method(logger, 'error', () => {});
      // The index let `stuck` go; Cosmos then refused its delete, once.
      const { apply } = store;
      let refused = false;
      cosmos.bulkVerified.mock.mockImplementation(async (container, operations) => {
        const refuse = !refused && operations.some(op => op.id === stuck && op.operationType === 'Delete');
        refused = refused || refuse;
        const sent = refuse ? operations.filter(op => op.id !== stuck) : operations;
        const result = await apply(container, sent);
        return refuse
          ? { ...result, failed: 1, failedIds: [stuck], statusCounts: { 429: 1 } }
          : result;
      });
      const before = countedFailures().length;

      assert.strictEqual((await post(SHORTER)).statusCode, 500, 'reported as a success');
      assert.strictEqual(countedFailures().length, before + 1);
      assert.ok(store.rows.has(stuck));

      assert.strictEqual((await post(SHORTER)).statusCode, 200);
      assert.deepStrictEqual(unindex.mock.calls[1].arguments[0], [stuck]);
      assert.ok(!store.rows.has(stuck), 'left in Cosmos unindexed, for an indexer reset to re-add');
    });

    await t.test('a retry after dying between the two deletes finds the surplus again', async (tt) => {
      const { store, dropped } = await seeded(tt);
      // The index delete lands, then the request dies before Cosmos is touched.
      tt.mock.method(aiSearch, 'deleteChunksByIds', async () => { throw new Error('recycled'); });
      tt.mock.method(logger, 'error', () => {});
      assert.strictEqual((await post(SHORTER)).statusCode, 500);

      const retry = tt.mock.method(aiSearch, 'deleteChunksByIds', async () => NONE_KEPT);
      const res = await post(SHORTER);

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual([...retry.mock.calls[0].arguments[0]].sort(), dropped);
      assert.ok(dropped.every(id => !store.rows.has(id)));
    });
  });
}

test('a Delete Cosmos answers 404 counts as deleted', async (t) => {
  t.mock.method(cosmos, 'query', async () => ({ items: ['keep', 'gone'], continuationToken: undefined }));
  const sent = [];
  t.mock.method(cosmos, 'bulk', async (container, operations) => {
    sent.push(...operations);
    return operations.map(() => ({ statusCode: 404, requestCharge: 1 }));
  });

  const result = await chunks.deleteSurplus(systemAccess(), DOC, ['keep']);

  assert.deepStrictEqual(sent.map(op => op.id), ['gone'], 'retried, or sent the kept id');
  assert.strictEqual(result.failed, 0);
  assert.strictEqual(result.succeeded, 1);
  t.mock.restoreAll();
});

// The 404 pass is for Delete only: a missing row is what a delete asked for, but an Upsert that
// finds no container or partition wrote nothing.
test('an Upsert Cosmos answers 404 is still a failure', async (t) => {
  t.mock.method(cosmos, 'query', async () => ({ items: [], continuationToken: undefined }));
  t.mock.method(cosmos, 'bulk', async (container, operations) =>
    operations.map(() => ({ statusCode: 404, requestCharge: 1 })));
  t.mock.method(logger, 'error', () => {});
  t.mock.method(logger, 'warn', () => {});
  const real = cosmos.bulkVerified;
  t.mock.method(cosmos, 'bulkVerified', (container, operations, opts) =>
    real(container, operations, { ...opts, sleepFn: async () => {} }));

  const result = await chunks.replaceForDocument(systemAccess(), DOC, [
    { id: 'new', documentId: DOC, content: 'text', read: ['staff'] }
  ]);

  assert.strictEqual(result.failed, 1);
  assert.strictEqual(result.succeeded, 0);
  t.mock.restoreAll();
});
