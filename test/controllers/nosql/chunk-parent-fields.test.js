'use strict';

// Both halves fail silently: the request answers 200 and the document row is right, but a chunk
// search filter matches fewer rows than it should.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const documents = require('../../../src/repositories/documents');
const projects = require('../../../src/repositories/projects');
const chunks = require('../../../src/repositories/chunks');
const aiSearch = require('../../../src/search/ai-search');
const documentController = require('../../../src/controllers/nosql/document');
const restampChunks = require('../../../src/jobs/restamp-chunks');
const { useConfig } = require('../../helpers/use-config');
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
    // Without `parentStampedAt` a re-stamp that started before this ingest would overwrite the
    // fresh copy with old values and leave nothing flagged.
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

  // Inline path so the re-stamp is observable; with no queue and no opt-in it is skipped.
  // restamp-dispatch.test.js owns the choice of path.
  useConfig(t, { chunkRestampInline: true });

  // The flag write is mocked too: a landed inline walk clears the flag, which is a Cosmos call.
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
    t.mock.method(documents, 'readForWrite', async () => storedDocument());
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
    // Chunk reads scope access on `projectId`, and chunks are partitioned by documentId, so a move
    // that stops at the document row leaves them on the old project's roles.
    t.mock.method(projects, 'getByEagleId', async () => ({ ...storedProject(), id: '208' }));
    t.mock.method(documents, 'readForWrite', async () => storedDocument());
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
    // The push rebuilds the row from Eagle's record and upsert replaces it, so an unrelated push
    // must not clear DEMI's own pending flag.
    t.mock.method(projects, 'getByEagleId', async () => storedProject());
    t.mock.method(documents, 'readForWrite', async () =>
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
    t.mock.method(documents, 'readForWrite', async () => storedDocument());
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
    t.mock.method(documents, 'readForWrite', async () => null);
    t.mock.method(documents, 'upsert', async (item) => item);
    const patched = watchChunks();

    await documentController.upsertFromEagle({
      params: { eagleId: DOC_EAGLE_ID }, query: {}, user: STAFF,
      body: { doc: eagleDocument() }
    }, mockRes());

    assert.deepStrictEqual(patched, []);
  });

  await t.test('a failed patch is not allowed to fail the document write', async () => {
    // The document write already landed; a stale copy only makes a filter miss chunks, never
    // shows text, so unlike the ACL patch it must not 500.
    t.mock.method(projects, 'getByEagleId', async () => storedProject());
    t.mock.method(documents, 'readForWrite', async () => storedDocument());
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
    // `chunks.parentFieldsOf` string-coerces for the `Edm.String` index, so a numeric `typeId` on
    // the row would never match its chunks' "12" and `parentFieldsChanged` would not notice.
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
    // `func start` with no storage account must work without a warning; the warning is for an
    // environment that asked for neither target and needs the backfill.
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
    t.mock.method(documents, 'readForWrite', async () => storedDocument());
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
    t.mock.method(documents, 'readForWrite', async () => storedDocument());
    t.mock.method(documents, 'upsert', async (item) => item);
    const { messages } = watchQueue();

    await documentController.upsertFromEagle({
      params: { eagleId: DOC_EAGLE_ID }, query: {}, user: STAFF,
      body: { doc: eagleDocument({ displayName: 'Application (revised)' }) }
    }, mockRes());

    assert.deepStrictEqual(messages, []);
  });

  await t.test('a queue that refuses the message does not fail the document write', async () => {
    // The document write already landed and a stale copy only misses rows; the repair is
    // `scripts/backfill-chunk-parent-fields.js --project`.
    t.mock.method(projects, 'getByEagleId', async () => storedProject());
    t.mock.method(documents, 'readForWrite', async () => storedDocument());
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
