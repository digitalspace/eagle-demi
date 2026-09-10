'use strict';

/**
 * A chunk carries a copy of its document's filter metadata, and the two write halves of that are
 * asserted here: the ingest paths stamp it on every new chunk, and a document write that moves a
 * value re-stamps the chunks that already exist.
 *
 * Both are silent when they break — the request still answers 200, the Cosmos row is still correct,
 * and the only symptom is a chunk search filter that matches fewer rows than it should.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const documents = require('../../../src/repositories/documents');
const projects = require('../../../src/repositories/projects');
const chunks = require('../../../src/repositories/chunks');
const aiSearch = require('../../../src/search/ai-search');
const documentController = require('../../../src/controllers/nosql/document');
const restampChunks = require('../../../src/jobs/restamp-chunks');
const config = require('../../../src/config');
const { logger } = require('../../../src/utils/logger');
const {
  mockRes, STAFF, PROJECT_EAGLE_ID, storedProject: storedProjectRow,
  storedDocument, DOCUMENT_EAGLE_ID, TYPE_ID, MILESTONE_ID
} = require('../../helpers/eagle-mirror-fixtures');

const DOC_EAGLE_ID = DOCUMENT_EAGLE_ID;

/** A raw Eagle document, as eagle-api pushes it. */
function eagleDocument(overrides = {}) {
  return {
    _id: DOC_EAGLE_ID,
    project: PROJECT_EAGLE_ID,
    displayName: 'Application',
    documentFileName: 'application.pdf',
    read: ['public', 'sysadmin'],
    type: TYPE_ID,
    milestone: MILESTONE_ID,
    ...overrides
  };
}

/** The shared project row, published — the document mirror reads `isPublished` off its parent. */
function storedProject() {
  return { ...storedProjectRow(), isPublished: true };
}

test('chunk ingest stamps the parent fields on every chunk', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('POST /documents/:id/chunks writes every parent field onto each chunk', async () => {
    const doc = storedDocument();
    t.mock.method(documents, 'getById', async () => doc);
    t.mock.method(documents, 'patchExtraction', async () => ({}));
    let written = null;
    t.mock.method(chunks, 'replaceForDocument', async (access, id, items) => {
      written = items;
      return { succeeded: items.length, failed: 0, statusCounts: {}, requestCharge: 1 };
    });

    const res = mockRes();
    await documentController.ingestChunks({
      params: { id: DOC_EAGLE_ID }, query: {}, user: STAFF,
      body: { markdown: '# Water quality\n\nTurbidity was monitored.\n\nResults follow.' }
    }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.ok(written.length > 0, 'no chunk was written, so the case below is vacuous');
    for (const item of written) {
      assert.deepStrictEqual(chunks.CHUNK_PARENT_FIELDS.map(f => item[f]),
        ['207', TYPE_ID, MILESTONE_ID, null, null]);
    }
  });

  await t.test('the NDJSON path writes the same fields', async () => {
    // Two ingest doors, one shape: a large document arrives here instead and nothing else would
    // notice its chunks came out unfilterable.
    const { Readable } = require('node:stream');
    const doc = storedDocument();
    t.mock.method(documents, 'getById', async () => doc);
    t.mock.method(documents, 'patchExtraction', async () => ({}));
    let written = [];
    t.mock.method(chunks, 'upsertBatch', async (access, id, items) => {
      written = written.concat(items);
      return { succeeded: items.length, failed: 0, statusCounts: {}, requestCharge: 1 };
    });
    t.mock.method(chunks, 'deleteSurplus', async () =>
      ({ succeeded: 0, failed: 0, statusCounts: {}, requestCharge: 0 }));

    const lines = [
      JSON.stringify({ extraction: { method: 'docling' } }),
      JSON.stringify('# Water quality\n\nTurbidity was monitored.')
    ].join('\n');

    const res = mockRes();
    await documentController.ingestChunks({
      params: { id: DOC_EAGLE_ID }, query: {}, user: STAFF,
      is: (type) => type === 'application/x-ndjson',
      stream: Readable.from([lines])
    }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.ok(written.length > 0, 'no chunk was streamed, so the case below is vacuous');
    for (const item of written) {
      assert.deepStrictEqual(chunks.CHUNK_PARENT_FIELDS.map(f => item[f]),
        ['207', TYPE_ID, MILESTONE_ID, null, null]);
    }
  });

  await t.test('a new chunk is born with the stamp that says how new its values are', async () => {
    // A chunk with no `parentStampedAt` is older than every walk, so a re-stamp that set out
    // before this ingest — carrying the values this document has just moved away from — overwrites
    // the fresh copy and the chunks answer the old filter again with nothing left flagged.
    const doc = storedDocument();
    t.mock.method(documents, 'getById', async () => doc);
    t.mock.method(documents, 'patchExtraction', async () => ({}));
    let written = null;
    t.mock.method(chunks, 'replaceForDocument', async (access, id, items) => {
      written = items;
      return { succeeded: items.length, failed: 0, statusCounts: {}, requestCharge: 1 };
    });

    const before = new Date().toISOString();
    await documentController.ingestChunks({
      params: { id: DOC_EAGLE_ID }, query: {}, user: STAFF,
      body: { markdown: '# Water quality\n\nTurbidity was monitored.' }
    }, mockRes());

    assert.ok(written.length > 0, 'no chunk was written, so the case below is vacuous');
    for (const item of written) {
      assert.ok(item.parentStampedAt >= before,
        `a chunk born unstamped is overwritable by any walk: ${item.parentStampedAt}`);
    }
  });

  await t.test('a row that already owes a re-stamp lends the ingest its token', async () => {
    // The values came off that row, so the walk serving that token has nothing to add: stamping
    // the new chunks with it keeps the walk from paying to write what is already there.
    const token = '2026-09-01T00:00:00.000Z';
    const doc = storedDocument({ parentFieldsPending: true, parentFieldsPendingAt: token });
    t.mock.method(documents, 'getById', async () => doc);
    t.mock.method(documents, 'patchExtraction', async () => ({}));
    let written = null;
    t.mock.method(chunks, 'replaceForDocument', async (access, id, items) => {
      written = items;
      return { succeeded: items.length, failed: 0, statusCounts: {}, requestCharge: 1 };
    });
    t.mock.method(documents, 'setParentFieldsPending', async () =>
      ({ status: 'raised', pendingAt: token }));

    await documentController.ingestChunks({
      params: { id: DOC_EAGLE_ID }, query: {}, user: STAFF,
      body: { markdown: '# Water quality\n\nTurbidity was monitored.' }
    }, mockRes());

    assert.ok(written.length > 0, 'no chunk was written, so the case below is vacuous');
    for (const item of written) assert.strictEqual(item.parentStampedAt, token);
  });

  await t.test('the NDJSON path stamps the same token', async () => {
    const { Readable } = require('node:stream');
    const token = '2026-09-01T00:00:00.000Z';
    const doc = storedDocument({ parentFieldsPending: true, parentFieldsPendingAt: token });
    t.mock.method(documents, 'getById', async () => doc);
    t.mock.method(documents, 'patchExtraction', async () => ({}));
    let written = [];
    t.mock.method(chunks, 'upsertBatch', async (access, id, items) => {
      written = written.concat(items);
      return { succeeded: items.length, failed: 0, statusCounts: {}, requestCharge: 1 };
    });
    t.mock.method(chunks, 'deleteSurplus', async () =>
      ({ succeeded: 0, failed: 0, statusCounts: {}, requestCharge: 0 }));
    t.mock.method(documents, 'setParentFieldsPending', async () =>
      ({ status: 'raised', pendingAt: token }));

    const lines = [
      JSON.stringify({ extraction: { method: 'docling' } }),
      JSON.stringify('# Water quality\n\nTurbidity was monitored.')
    ].join('\n');

    await documentController.ingestChunks({
      params: { id: DOC_EAGLE_ID }, query: {}, user: STAFF,
      is: (type) => type === 'application/x-ndjson',
      stream: Readable.from([lines])
    }, mockRes());

    assert.ok(written.length > 0, 'no chunk was streamed, so the case below is vacuous');
    for (const item of written) assert.strictEqual(item.parentStampedAt, token);
  });
});

test('a document write re-stamps its chunks only when a parent field moved', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  // WHICH writes move the copy, not where the walk runs. With no queue name and no opt-in the
  // write skips the re-stamp altogether and there is nothing here to observe, so these cases ask
  // for the inline path; test/controllers/nosql/restamp-dispatch.test.js owns the choice itself.
  const inlineBefore = config.chunkRestampInline;
  config.chunkRestampInline = true;
  t.after(() => { config.chunkRestampInline = inlineBefore; });

  /**
   * Records every parent-field patch the handler under test issues. The flag write goes with it:
   * a landed inline walk clears the flag the write raised, and unmocked that is a Cosmos call.
   * `test/controllers/nosql/restamp-dispatch.test.js` owns what the flag does.
   */
  function watchChunks() {
    const calls = [];
    t.mock.method(chunks, 'setParentFieldsForDocument', async (access, id, document) => {
      calls.push({ id, document });
      return { succeeded: 1, failed: 0, statusCounts: {}, requestCharge: 1, chunks: 1 };
    });
    t.mock.method(documents, 'setParentFieldsPending', async () => ({}));
    return calls;
  }

  await t.test('a re-typed document pushed from eagle patches its chunks', async () => {
    t.mock.method(projects, 'getByEagleId', async () => storedProject());
    t.mock.method(documents, 'getById', async () => storedDocument());
    t.mock.method(documents, 'upsert', async (item) => item);
    const patched = watchChunks();

    const res = mockRes();
    await documentController.upsertFromEagle({
      params: { eagleId: DOC_EAGLE_ID }, query: {}, user: STAFF,
      body: { doc: eagleDocument({ type: 'aaaaaaaaaaaaaaaaaaaaaaaa' }) }
    }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(patched.length, 1);
    assert.strictEqual(patched[0].id, DOC_EAGLE_ID);
    assert.strictEqual(patched[0].document.typeId, 'aaaaaaaaaaaaaaaaaaaaaaaa');
  });

  await t.test('a document MOVED to another project has its chunks re-stamped', async () => {
    // `projectId` is a parent field too, and not only for filtering: every chunk read scopes access
    // on it (`access-sql.visibilityFor`). A move that stopped at the document row left the chunks
    // answering the OLD project's roles, and no other write ever touches them — chunks are
    // partitioned by documentId, so they do not move with the row.
    t.mock.method(projects, 'getByEagleId', async () => ({ ...storedProject(), id: '208' }));
    t.mock.method(documents, 'getById', async () => storedDocument());
    t.mock.method(documents, 'upsert', async (item) => item);
    t.mock.method(documents, 'deleteById', async () => ({}));
    const patched = watchChunks();

    const res = mockRes();
    await documentController.upsertFromEagle({
      params: { eagleId: DOC_EAGLE_ID }, query: {}, user: STAFF,
      body: { doc: eagleDocument() }
    }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(patched.length, 1, 'the move left the chunks in the old project');
    assert.strictEqual(patched[0].document.projectId, '208');
    assert.strictEqual(chunks.parentFieldsOf(patched[0].document).projectId, '208');
  });

  await t.test('a pending flag survives a push that has nothing to do with it', async () => {
    // A Cosmos upsert REPLACES the row and the push builds it from Eagle's record, so DEMI's own
    // "these chunks never got their new values" flag would be cleared by the next unrelated push —
    // and the repair would never find the document again.
    t.mock.method(projects, 'getByEagleId', async () => storedProject());
    t.mock.method(documents, 'getById', async () =>
      storedDocument({ parentFieldsPending: true, parentFieldsPendingAt: '2026-09-01T00:00:00Z' }));
    const upserted = [];
    t.mock.method(documents, 'upsert', async (item) => { upserted.push(item); return item; });
    watchChunks();

    await documentController.upsertFromEagle({
      params: { eagleId: DOC_EAGLE_ID }, query: {}, user: STAFF,
      body: { doc: eagleDocument({ displayName: 'Application (revised)' }) }
    }, mockRes());

    assert.strictEqual(upserted.length, 1);
    assert.strictEqual(upserted[0].parentFieldsPending, true);
    assert.strictEqual(upserted[0].parentFieldsPendingAt, '2026-09-01T00:00:00Z');
  });

  await t.test('a push that only renames the document patches nothing', async () => {
    // The push fires on EVERY eagle-api write, so patching unconditionally would walk every chunk
    // of the document on every unrelated edit — ~19 rows each, against 1.1M in the container.
    t.mock.method(projects, 'getByEagleId', async () => storedProject());
    t.mock.method(documents, 'getById', async () => storedDocument());
    t.mock.method(documents, 'upsert', async (item) => item);
    const patched = watchChunks();

    await documentController.upsertFromEagle({
      params: { eagleId: DOC_EAGLE_ID }, query: {}, user: STAFF,
      body: { doc: eagleDocument({ displayName: 'Application (revised)' }) }
    }, mockRes());

    assert.deepStrictEqual(patched, []);
  });

  await t.test('a document DEMI has never seen patches nothing', async () => {
    // It has no chunks yet, and the ingest that creates them stamps the fields itself.
    t.mock.method(projects, 'getByEagleId', async () => storedProject());
    t.mock.method(documents, 'getById', async () => null);
    t.mock.method(documents, 'upsert', async (item) => item);
    const patched = watchChunks();

    await documentController.upsertFromEagle({
      params: { eagleId: DOC_EAGLE_ID }, query: {}, user: STAFF,
      body: { doc: eagleDocument() }
    }, mockRes());

    assert.deepStrictEqual(patched, []);
  });

  await t.test('a failed patch is not allowed to fail the document write', async () => {
    // The Cosmos document write is authoritative and has already landed. A stale copy makes a
    // filter MISS chunks; it never shows text to a caller who may not see it, so this is not the
    // ACL patch and must not 500 a write that succeeded.
    t.mock.method(projects, 'getByEagleId', async () => storedProject());
    t.mock.method(documents, 'getById', async () => storedDocument());
    t.mock.method(documents, 'upsert', async (item) => item);
    t.mock.method(chunks, 'setParentFieldsForDocument', async () => {
      throw new Error('cosmos unavailable');
    });

    const res = mockRes();
    await documentController.upsertFromEagle({
      params: { eagleId: DOC_EAGLE_ID }, query: {}, user: STAFF,
      body: { doc: eagleDocument({ type: 'aaaaaaaaaaaaaaaaaaaaaaaa' }) }
    }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.action, 'upsert');
  });

  await t.test('a staff edit that re-types a document patches its chunks', async () => {
    // PUT /documents/:id can move these too — all four are catalogued at level 4, so they are
    // writable — and that route never went near the chunks before.
    t.mock.method(documents, 'getById', async () => storedDocument());
    t.mock.method(documents, 'upsert', async (item) => item);
    t.mock.method(aiSearch, 'writeAcls', async () => 0);
    const patched = watchChunks();

    const res = mockRes();
    await documentController.updateDocument({
      params: { id: DOC_EAGLE_ID }, query: {}, user: STAFF,
      body: { typeId: 'bbbbbbbbbbbbbbbbbbbbbbbb' }
    }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(patched.length, 1);
    assert.strictEqual(patched[0].document.typeId, 'bbbbbbbbbbbbbbbbbbbbbbbb');
  });

  await t.test('a non-string parent field is refused, not stored beside a coerced copy', async () => {
    // `chunks.parentFieldsOf` String-coerces (`Edm.String` is what the index declares, and an
    // unstringified ObjectId indexes as null) while this route stores the raw body value. Accept
    // `{typeId: 12}` and the document row holds the number while every chunk holds "12" — so
    // `parentFieldsChanged` sees no further movement and the two ends disagree for good.
    t.mock.method(documents, 'getById', async () => storedDocument());
    let upserted = 0;
    t.mock.method(documents, 'upsert', async (item) => { upserted += 1; return item; });
    const patched = watchChunks();

    const res = mockRes();
    await documentController.updateDocument({
      params: { id: DOC_EAGLE_ID }, query: {}, user: STAFF,
      body: { typeId: 12 }
    }, res);

    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /typeId/);
    assert.strictEqual(upserted, 0, 'the row must not be written at all');
    assert.deepStrictEqual(patched, []);
  });

  await t.test('null still clears a parent field', async () => {
    // The other end of the same rule: clearing a document's type is an ordinary edit, and refusing
    // `null` would make it unsettable through the API.
    t.mock.method(documents, 'getById', async () => storedDocument());
    t.mock.method(documents, 'upsert', async (item) => item);
    t.mock.method(aiSearch, 'writeAcls', async () => 0);
    const patched = watchChunks();

    const res = mockRes();
    await documentController.updateDocument({
      params: { id: DOC_EAGLE_ID }, query: {}, user: STAFF,
      body: { typeId: null }
    }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(patched.length, 1);
    assert.strictEqual(patched[0].document.typeId, null);
  });

  await t.test('a staff edit that leaves them alone patches nothing', async () => {
    t.mock.method(documents, 'getById', async () => storedDocument());
    t.mock.method(documents, 'upsert', async (item) => item);
    t.mock.method(aiSearch, 'writeAcls', async () => 0);
    const patched = watchChunks();

    await documentController.updateDocument({
      params: { id: DOC_EAGLE_ID }, query: {}, user: STAFF,
      body: { displayName: 'Application (revised)' }
    }, mockRes());

    assert.deepStrictEqual(patched, []);
  });

  await t.test('the opt-in walk runs on the request and says nothing about it', async () => {
    // `func start` with no storage account. It has to stay working, and it must not warn: the
    // warning is reserved for the environment that asked for neither target, where the chunks are
    // left stale and somebody has to run the backfill.
    t.mock.method(documents, 'getById', async () => storedDocument());
    t.mock.method(documents, 'upsert', async (item) => item);
    t.mock.method(aiSearch, 'writeAcls', async () => 0);
    const patched = watchChunks();
    const warnings = [];
    t.mock.method(logger, 'warn', (message, meta) => { warnings.push({ message, meta }); });

    assert.strictEqual(restampChunks.enabled(), false, 'the suite sets no queue name');

    await documentController.updateDocument({
      params: { id: DOC_EAGLE_ID }, query: {}, user: STAFF,
      body: { typeId: 'cccccccccccccccccccccccc' }
    }, mockRes());

    assert.strictEqual(patched.length, 1);
    assert.strictEqual(patched[0].document.typeId, 'cccccccccccccccccccccccc');
    assert.deepStrictEqual(warnings, []);
  });
});

test('with a queue configured the write enqueues instead of walking the chunks', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  /** The queue named, and both ends of it recorded. */
  function watchQueue(enqueue) {
    t.mock.method(restampChunks, 'enabled', () => true);
    const messages = [];
    t.mock.method(restampChunks, 'enqueue', async (message) => {
      messages.push(message);
      if (enqueue) return enqueue(message);
    });
    const patched = [];
    t.mock.method(chunks, 'setParentFieldsForDocument', async (access, id, document) => {
      patched.push({ id, document });
      return { succeeded: 1, failed: 0, statusCounts: {}, requestCharge: 1 };
    });
    return { messages, patched };
  }

  await t.test('a re-typed push queues the document and returns without patching', async () => {
    // The whole point: ~6k chunks is ~60 serial Cosmos bulk calls plus 429 backoff, and
    // eagle-api's pushClient.js aborts the push at 10 s and pushes again — the same walk twice.
    t.mock.method(projects, 'getByEagleId', async () => storedProject());
    t.mock.method(documents, 'getById', async () => storedDocument());
    t.mock.method(documents, 'upsert', async (item) => item);
    const { messages, patched } = watchQueue();

    const res = mockRes();
    await documentController.upsertFromEagle({
      params: { eagleId: DOC_EAGLE_ID }, query: {}, user: STAFF,
      body: { doc: eagleDocument({ type: 'aaaaaaaaaaaaaaaaaaaaaaaa' }) }
    }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(patched, [], 'the walk must not be on the request path any more');
    assert.deepStrictEqual(messages, [{ documentId: DOC_EAGLE_ID, projectId: '207' }],
      'ids only, and the project id because it is the document container partition key');
  });

  await t.test('a staff edit that re-types a document queues it too', async () => {
    t.mock.method(documents, 'getById', async () => storedDocument());
    t.mock.method(documents, 'upsert', async (item) => item);
    t.mock.method(aiSearch, 'writeAcls', async () => 0);
    const { messages, patched } = watchQueue();

    const res = mockRes();
    await documentController.updateDocument({
      params: { id: DOC_EAGLE_ID }, query: {}, user: STAFF,
      body: { typeId: 'bbbbbbbbbbbbbbbbbbbbbbbb' }
    }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(patched, []);
    assert.deepStrictEqual(messages, [{ documentId: DOC_EAGLE_ID, projectId: '207' }]);
  });

  await t.test('a push that moves no parent field queues nothing', async () => {
    // The push fires on EVERY eagle-api write. Queueing unconditionally would trade a slow
    // request for a queue that re-walks every document in the corpus on every unrelated edit.
    t.mock.method(projects, 'getByEagleId', async () => storedProject());
    t.mock.method(documents, 'getById', async () => storedDocument());
    t.mock.method(documents, 'upsert', async (item) => item);
    const { messages } = watchQueue();

    await documentController.upsertFromEagle({
      params: { eagleId: DOC_EAGLE_ID }, query: {}, user: STAFF,
      body: { doc: eagleDocument({ displayName: 'Application (revised)' }) }
    }, mockRes());

    assert.deepStrictEqual(messages, []);
  });

  await t.test('a queue that refuses the message does not fail the document write', async () => {
    // Same rule the inline patch had: the Cosmos write is authoritative and has already landed,
    // and a stale chunk copy makes a filter MISS rows rather than showing text to anyone.
    // `scripts/backfill-chunk-parent-fields.js --project` is the repair.
    t.mock.method(projects, 'getByEagleId', async () => storedProject());
    t.mock.method(documents, 'getById', async () => storedDocument());
    t.mock.method(documents, 'upsert', async (item) => item);
    watchQueue(() => { throw new Error('queue not found'); });
    const errors = [];
    t.mock.method(logger, 'error', (message, meta) => { errors.push({ message, meta }); });

    const res = mockRes();
    await documentController.upsertFromEagle({
      params: { eagleId: DOC_EAGLE_ID }, query: {}, user: STAFF,
      body: { doc: eagleDocument({ type: 'aaaaaaaaaaaaaaaaaaaaaaaa' }) }
    }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.action, 'upsert');
    assert.strictEqual(errors.length, 1, 'a lost re-stamp has to leave a record somewhere');
    assert.match(errors[0].message, /could not be queued/);
    assert.strictEqual(errors[0].meta.documentId, DOC_EAGLE_ID);
    assert.strictEqual(errors[0].meta.error, 'queue not found');
  });
});
