'use strict';

/**
 * Where a document write sends the chunk re-stamp — the queue, the request, or nowhere — and the
 * outbox flag that outlives every one of those choices.
 *
 * The write raises `parentFieldsPending` on the SAME upsert that moves the field, so the document
 * is on the reconcile line from the moment it lands. Only a landed patch clears it. That ordering
 * is the point: flagging on a failed enqueue alone covered the loss anyone would notice and missed
 * the quiet one, where the message was accepted and then spent its retries into the poison queue.
 * `scripts/backfill-chunk-parent-fields.js --pending` is the repair either way.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');

const config = require('../../../src/config');
const documents = require('../../../src/repositories/documents');
const chunks = require('../../../src/repositories/chunks');
const aiSearch = require('../../../src/search/ai-search');
const restampChunks = require('../../../src/jobs/restamp-chunks');
const documentController = require('../../../src/controllers/nosql/document');
const { logger } = require('../../../src/utils/logger');
const {
  mockRes, STAFF, storedDocument, DOCUMENT_EAGLE_ID
} = require('../../helpers/eagle-mirror-fixtures');

const DOC_ID = DOCUMENT_EAGLE_ID;
const NEW_TYPE_ID = 'cccccccccccccccccccccccc';
const ETAG = '"0x8DC1"';
/** What the repository answers a raise with, when the raise is a second write rather than a stamp
 *  riding the upsert. */
const RAISED_AT = '2026-09-01T00:00:00.000Z';

/** A staff re-type through PUT /documents/:id — the shortest write that moves a parent field. */
const retype = (controller, res = mockRes()) => controller.updateDocument({
  params: { id: DOC_ID }, query: {}, user: STAFF, body: { typeId: NEW_TYPE_ID }
}, res);

function withInline(t, on) {
  const previous = config.chunkRestampInline;
  config.chunkRestampInline = on;
  t.after(() => { config.chunkRestampInline = previous; });
}

/** The write itself, mocked, plus recorders for both re-stamp paths and for the flag. */
function watchWrite(t) {
  t.mock.method(documents, 'getById', async () => storedDocument({ _etag: ETAG }));
  const upserted = [];
  t.mock.method(documents, 'upsert', async (item) => { upserted.push(item); return item; });
  t.mock.method(aiSearch, 'writeAcls', async () => 0);
  const patched = [];
  t.mock.method(chunks, 'setParentFieldsForDocument', async (access, id, document) => {
    patched.push({ id, document });
    return { succeeded: 1, failed: 0, statusCounts: {}, requestCharge: 1 };
  });
  const warnings = [];
  t.mock.method(logger, 'warn', (message, meta) => { warnings.push({ message, meta }); });
  const flagged = [];
  t.mock.method(documents, 'setParentFieldsPending', async (id, projectId, pending, guard) => {
    flagged.push({ id, projectId, pending, guard });
    return pending ? { status: 'raised', pendingAt: RAISED_AT } : { status: 'cleared', pendingAt: null };
  });
  return { upserted, patched, warnings, flagged };
}

/** Just the flag recorder, for the paths that write no document row of their own. */
function watchPending(t) {
  const flagged = [];
  t.mock.method(documents, 'setParentFieldsPending', async (id, projectId, pending, guard) => {
    flagged.push({ id, projectId, pending, guard });
    return pending ? { status: 'raised', pendingAt: RAISED_AT } : { status: 'cleared', pendingAt: null };
  });
  return { flagged };
}

/**
 * An NDJSON ingest request, the streaming door. A real Readable, because the handler drives it with
 * readline and the batching is the whole point of the case below.
 */
const streamOf = (blocks) => ({
  stream: Readable.from([JSON.stringify({}), ...blocks.map(b => JSON.stringify(b))].map(l => `${l}\n`)),
  params: { id: DOC_ID }, query: {}, user: STAFF, is: (type) => type === 'application/x-ndjson'
});

/** Enough markdown to cross the streaming batch bound `n` times. */
const blocksFor = (batches) =>
  Array.from({ length: batches * 210 }, (_, i) => `Para ${i} ${'q'.repeat(2600)}`);

/** What the row carries when the write owes a re-stamp. */
function assertRaised(row, label) {
  assert.strictEqual(row.parentFieldsPending, true, label);
  assert.match(row.parentFieldsPendingAt, /^\d{4}-\d{2}-\d{2}T/,
    'the timestamp is how long the drift has stood, so the reconcile can age it');
}

/**
 * A controller with its warn-once flag unset.
 *
 * Module-level state, so a test that asserts on the first warning has to own the module. Only the
 * controller is dropped from the cache — everything it requires stays shared, which is what keeps
 * the mocks above pointed at the objects it uses.
 */
function freshController(t) {
  const MODULE = require.resolve('../../../src/controllers/nosql/document');
  const cached = require.cache[MODULE];
  delete require.cache[MODULE];
  t.after(() => { require.cache[MODULE] = cached; });
  return require(MODULE);
}

test('a queue name sends the work to the queue, on a row already flagged', async (t) => {
  // THE LOST RE-STAMP, first half. A message that went out is not proof the walk happened: it can
  // fail every attempt and poison, and nothing comes back to say so. The row carries the flag from
  // the write itself, so the reconcile counts this document until the handler clears it.
  t.afterEach(() => t.mock.restoreAll());
  t.mock.method(restampChunks, 'enabled', () => true);
  const messages = [];
  t.mock.method(restampChunks, 'enqueue', async (message) => { messages.push(message); });
  const { upserted, patched, flagged } = watchWrite(t);

  await retype(documentController);

  assert.deepStrictEqual(messages, [{ documentId: DOC_ID, projectId: '207' }]);
  assert.deepStrictEqual(patched, [], 'the walk is what the queue exists to keep off the request');
  assert.strictEqual(upserted.length, 1);
  assertRaised(upserted[0], 'an enqueued re-stamp that never lands has to leave a trace');
  assert.deepStrictEqual(flagged, [],
    'the flag rides the write, so there is no second round trip to raise it');
});

test('a re-stamp that could not be queued needs no second write', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.mock.method(restampChunks, 'enabled', () => true);
  t.mock.method(restampChunks, 'enqueue', async () => { throw new Error('queue unreachable'); });
  const { upserted, flagged } = watchWrite(t);
  const errors = [];
  t.mock.method(logger, 'error', (message, meta) => { errors.push({ message, meta }); });

  const res = mockRes();
  await retype(documentController, res);

  assert.strictEqual(res.statusCode, 200, 'the document write itself had already landed');
  assertRaised(upserted[0], 'a failed enqueue is the case the flag always covered');
  assert.deepStrictEqual(flagged, [],
    'the row went in flagged, so a failed enqueue is a log line and nothing more');
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].message, /could not be queued/);
});

test('a message that poisons leaves the flag standing', async (t) => {
  // THE LOST RE-STAMP, second half, end to end: the write flags the row and enqueues, every
  // attempt fails, the message poisons, and nothing has cleared the flag. Before the outbox this
  // document was invisible — the enqueue succeeded, so the old fallback never fired.
  t.afterEach(() => t.mock.restoreAll());
  t.mock.method(restampChunks, 'enabled', () => true);
  const messages = [];
  t.mock.method(restampChunks, 'enqueue', async (message) => { messages.push(message); });
  const { upserted, flagged } = watchWrite(t);
  t.mock.method(logger, 'error', () => {});

  await retype(documentController);
  assertRaised(upserted[0], 'nothing else in this sequence ever writes the flag');

  t.mock.method(chunks, 'setParentFieldsForDocument', async () => {
    throw new Error('cosmos unavailable');
  });
  await assert.rejects(
    () => restampChunks.run(JSON.stringify(messages[0]), { attempt: 1, maxAttempts: 1 }),
    /cosmos unavailable/);

  assert.deepStrictEqual(flagged, [],
    'a poisoned job clears nothing, which is exactly what leaves the document countable');
});

test('CHUNK_RESTAMP_INLINE walks the chunks on the request and clears the flag it raised',
  async (t) => {
    t.afterEach(() => t.mock.restoreAll());
    withInline(t, true);
    const { upserted, patched, flagged } = watchWrite(t);
    const messages = [];
    t.mock.method(restampChunks, 'enqueue', async (message) => { messages.push(message); });

    await retype(documentController);

    // `func start` has no storage account to send to, so the opt-in is the only way to see the
    // re-stamp happen at all without Azure.
    assert.strictEqual(patched.length, 1);
    assert.strictEqual(patched[0].document.typeId, NEW_TYPE_ID);
    assert.deepStrictEqual(messages, []);
    assertRaised(upserted[0], 'the flag goes up before the walk, on this path too');
    // Same token guard the queue handler uses: the walk stamped from the flag this write raised,
    // so a newer parent-field change's flag must survive it — and an unrelated write landing in
    // between must not refuse it, which is what an etag guard did.
    assert.deepStrictEqual(flagged, [{
      id: DOC_ID,
      projectId: '207',
      pending: false,
      guard: { pendingAt: upserted[0].parentFieldsPendingAt }
    }]);
  });

test('an inline walk that fails leaves the flag raised', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  withInline(t, true);
  const { upserted, flagged } = watchWrite(t);
  t.mock.method(chunks, 'setParentFieldsForDocument', async () => {
    throw new Error('cosmos unavailable');
  });
  t.mock.method(logger, 'error', () => {});

  await retype(documentController);

  assertRaised(upserted[0]);
  assert.deepStrictEqual(flagged, [], 'only a landed patch clears it');
});

test('an inline walk that lost a chunk leaves the flag raised too', async (t) => {
  // Part-stamped is still stale: some chunks answer the new value and some the old.
  t.afterEach(() => t.mock.restoreAll());
  withInline(t, true);
  const { flagged } = watchWrite(t);
  t.mock.method(chunks, 'setParentFieldsForDocument', async () =>
    ({ succeeded: 12, failed: 7, statusCounts: {}, requestCharge: 1 }));
  t.mock.method(logger, 'error', () => {});

  await retype(documentController);

  assert.deepStrictEqual(flagged, []);
});

test('with neither set the re-stamp is skipped, warned about once, and the write still succeeds',
  async (t) => {
    t.afterEach(() => t.mock.restoreAll());
    withInline(t, false);
    const controller = freshController(t);
    const { upserted, patched, warnings, flagged } = watchWrite(t);
    const messages = [];
    t.mock.method(restampChunks, 'enqueue', async (message) => { messages.push(message); });

    assert.strictEqual(restampChunks.enabled(), false, 'the suite sets no queue name');

    const first = mockRes();
    await retype(controller, first);
    await retype(controller);

    assert.strictEqual(first.statusCode, 200,
      'a misconfigured re-stamp must never be the reason a document push fails');
    assert.deepStrictEqual(patched, [],
      'the inline walk is an opt-in — arriving at it by losing a setting is the timeout this ' +
      'change exists to prevent');
    assert.deepStrictEqual(messages, []);
    const skipped = warnings.filter(w => /CHUNK_RESTAMP_INLINE/.test(w.message));
    assert.strictEqual(skipped.length, 1,
      'one line per worker: this fires on every write that moves a field, and a line per request ' +
      'would bury the pushes themselves');
    assert.strictEqual(skipped[0].meta.documentId, DOC_ID);
    // The warning is once per WORKER, so it cannot say which documents were skipped. The flag is
    // per document, and it is what `--pending` and the nightly reconcile read.
    assert.strictEqual(upserted.length, 2);
    upserted.forEach(row => assertRaised(row));
    assert.deepStrictEqual(flagged, []);
  });

test('a write that moves no parent field carries no flag', async (t) => {
  // The flag has to mean something. Stamping every write would put the whole corpus on the
  // reconcile line and `--pending` would re-walk 1.1M chunks a night.
  t.afterEach(() => t.mock.restoreAll());
  const { upserted, flagged } = watchWrite(t);

  const res = mockRes();
  await documentController.updateDocument({
    params: { id: DOC_ID }, query: {}, user: STAFF, body: { displayName: 'Application (revised)' }
  }, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(upserted.length, 1);
  assert.strictEqual(upserted[0].parentFieldsPending, undefined);
  assert.strictEqual(upserted[0].parentFieldsPendingAt, undefined);
  assert.deepStrictEqual(flagged, []);
});

test('the flag never reaches the caller', async (t) => {
  // It is DEMI bookkeeping about its own chunks, and PUT echoes the saved row back. The vis
  // catalog is an allow-list, so an uncatalogued key is dropped — this is the case that says so.
  t.afterEach(() => t.mock.restoreAll());
  watchWrite(t);

  const res = mockRes();
  await retype(documentController, res);

  assert.strictEqual(res.statusCode, 200);
  assert.ok(!Object.hasOwn(res.body, 'parentFieldsPending'));
  assert.ok(!Object.hasOwn(res.body, 'parentFieldsPendingAt'));
});

test('a second raise mints a token later than the one already on the row', async (t) => {
  // Two raises inside one millisecond — an eagle-api push and a staff edit landing together, or a
  // clock that did not move between them — used to write the same `parentFieldsPendingAt` twice.
  // The first re-stamp's clear then matched the SECOND raise's token and took its flag down, and
  // the chunks that write moved went stale with nothing on the reconcile line to say so.
  t.afterEach(() => t.mock.restoreAll());
  t.mock.method(restampChunks, 'enabled', () => true);
  t.mock.method(restampChunks, 'enqueue', async () => {});
  // Stands in for "the clock has not moved since the last raise", with the skew made visible.
  const alreadyRaisedAt = new Date(Date.now() + 60000).toISOString();
  t.mock.method(documents, 'getById', async () => storedDocument({
    _etag: ETAG, parentFieldsPending: true, parentFieldsPendingAt: alreadyRaisedAt
  }));
  const upserted = [];
  t.mock.method(documents, 'upsert', async (item) => { upserted.push(item); return item; });
  t.mock.method(aiSearch, 'writeAcls', async () => 0);

  await retype(documentController);

  assert.ok(upserted[0].parentFieldsPendingAt > alreadyRaisedAt,
    'the new token must beat the one it replaces, or one clear takes down two raises: ' +
    `${upserted[0].parentFieldsPendingAt} is not later than ${alreadyRaisedAt}`);
});

test('a parent field that moved mid-ingest is raised again when the last batch has landed',
  async (t) => {
    // THE INGEST WINDOW. A stream is minutes of batches, every one of them stamped from the row
    // read at the start. A re-type landing halfway through raises its own flag and sends its own
    // re-stamp — but that walk reaches only the chunks written so far, and then it CLEARS the flag.
    // The batches still to come are written afterwards, carrying the old type, with nothing left
    // watching. The ingest closes the window from its own end.
    t.afterEach(() => t.mock.restoreAll());
    t.mock.method(restampChunks, 'enabled', () => true);
    const messages = [];
    t.mock.method(restampChunks, 'enqueue', async (message) => { messages.push(message); });

    // Read at the top of the request, and again once the last batch has landed. The re-type lands
    // in between.
    let reads = 0;
    t.mock.method(documents, 'getById', async () => {
      reads += 1;
      return reads === 1 ? storedDocument() : storedDocument({ typeId: NEW_TYPE_ID });
    });
    t.mock.method(documents, 'patchExtraction', async () => ({}));
    const batches = [];
    t.mock.method(chunks, 'upsertBatch', async (access, id, items) => {
      batches.push(items.length);
      return { succeeded: items.length, failed: 0, statusCounts: {} };
    });
    t.mock.method(chunks, 'deleteSurplus', async () => ({ succeeded: 0, failed: 0 }));
    const { flagged } = watchPending(t);

    const res = mockRes();
    await documentController.ingestChunks(streamOf(blocksFor(2)), res);

    assert.strictEqual(res.statusCode, 200, 'the chunks landed; the drift is a separate fact');
    assert.ok(batches.length > 1, `the window only exists across batches, got ${batches.length}`);
    assert.deepStrictEqual(flagged,
      [{ id: DOC_ID, projectId: '207', pending: true, guard: undefined }],
      'the document has to go back on the reconcile line, or the drift is invisible');
    assert.deepStrictEqual(messages, [{ documentId: DOC_ID, projectId: '207' }],
      'and a re-stamp has to be sent, now that the whole chunk set exists to walk');
  });

test('the JSON ingest path checks for the same drift', async (t) => {
  // Both doors, one rule. A 10 MB markdown is still seconds of chunking and one bulk write per 100
  // chunks, and this path stamps from a snapshot exactly as the streaming one does.
  t.afterEach(() => t.mock.restoreAll());
  t.mock.method(restampChunks, 'enabled', () => true);
  const messages = [];
  t.mock.method(restampChunks, 'enqueue', async (message) => { messages.push(message); });
  let reads = 0;
  t.mock.method(documents, 'getById', async () => {
    reads += 1;
    return reads === 1 ? storedDocument() : storedDocument({ typeId: NEW_TYPE_ID });
  });
  t.mock.method(documents, 'patchExtraction', async () => ({}));
  t.mock.method(chunks, 'replaceForDocument', async (access, id, items) =>
    ({ succeeded: items.length, failed: 0, statusCounts: {} }));
  const { flagged } = watchPending(t);

  await documentController.ingestChunks({
    params: { id: DOC_ID }, query: {}, user: STAFF, body: { markdown: 'x'.repeat(9000) }
  }, mockRes());

  assert.deepStrictEqual(flagged,
    [{ id: DOC_ID, projectId: '207', pending: true, guard: undefined }]);
  assert.deepStrictEqual(messages, [{ documentId: DOC_ID, projectId: '207' }]);
});

test('a long stream picks up a parent field that moved, without a read per batch', async (t) => {
  // The narrowing beside the end-of-ingest check: a stream that runs for minutes re-reads the row
  // every 25 batches, so the chunks written after an edit carry the new values instead of the
  // whole tail carrying the snapshot's. It is a cadence, not a guarantee — the batches between two
  // reads still carry the old values, and the flag raised at ingest end is what covers them.
  t.afterEach(() => t.mock.restoreAll());
  t.mock.method(restampChunks, 'enabled', () => true);
  t.mock.method(restampChunks, 'enqueue', async () => {});
  let reads = 0;
  t.mock.method(documents, 'getById', async () => {
    reads += 1;
    return reads === 1 ? storedDocument() : storedDocument({ typeId: NEW_TYPE_ID });
  });
  t.mock.method(documents, 'patchExtraction', async () => ({}));
  const stamped = [];
  t.mock.method(chunks, 'upsertBatch', async (access, id, items) => {
    stamped.push(items.map(chunk => chunk.typeId));
    return { succeeded: items.length, failed: 0, statusCounts: {} };
  });
  t.mock.method(chunks, 'deleteSurplus', async () => ({ succeeded: 0, failed: 0 }));
  watchPending(t);

  // One chunk per block, so the batch count is the block count over the streaming bound.
  await documentController.ingestChunks(streamOf(blocksFor(27)), mockRes());

  const firstFresh = stamped.findIndex(types => types.includes(NEW_TYPE_ID));
  assert.ok(firstFresh > 0,
    `the tail of the stream kept stamping the snapshot, over ${stamped.length} batches`);
  assert.ok(reads < stamped.length / 2,
    `a point read per batch is what the cadence avoids: ${reads} reads for ${stamped.length} batches`);
});

test('a value that moved and moved back during a stream is still raised', async (t) => {
  // The end-of-ingest check compares the snapshot against the final row, and those two agree here:
  // the type went to another value and came back. What does not agree is the middle of the stream,
  // where the mid-stream refresh picked the other value up and every batch after it carried it —
  // so the drift is real, it is invisible to a comparison of the two ends, and only the stream
  // itself can report it.
  t.afterEach(() => t.mock.restoreAll());
  t.mock.method(restampChunks, 'enabled', () => true);
  const messages = [];
  t.mock.method(restampChunks, 'enqueue', async (message) => { messages.push(message); });

  // Read 1 is the snapshot, read 2 the mid-stream refresh, read 3 the end-of-ingest check.
  let reads = 0;
  t.mock.method(documents, 'getById', async () => {
    reads += 1;
    return reads === 2 ? storedDocument({ typeId: NEW_TYPE_ID }) : storedDocument();
  });
  t.mock.method(documents, 'patchExtraction', async () => ({}));
  const stamped = [];
  t.mock.method(chunks, 'upsertBatch', async (access, id, items) => {
    stamped.push(items.map(chunk => chunk.typeId));
    return { succeeded: items.length, failed: 0, statusCounts: {} };
  });
  t.mock.method(chunks, 'deleteSurplus', async () => ({ succeeded: 0, failed: 0 }));
  const { flagged } = watchPending(t);

  const res = mockRes();
  await documentController.ingestChunks(streamOf(blocksFor(27)), res);

  assert.strictEqual(res.statusCode, 200, 'the chunks landed; the drift is a separate fact');
  assert.strictEqual(reads, 3, `the refresh has to have run for this to be the case, got ${reads}`);
  assert.ok(stamped.some(types => types.includes(NEW_TYPE_ID)),
    'no batch carried the middle value, so there is no drift here to find');
  assert.deepStrictEqual(flagged,
    [{ id: DOC_ID, projectId: '207', pending: true, guard: undefined }],
    'the chunks stamped mid-stream are wrong and nothing is on the reconcile line for them');
  assert.deepStrictEqual(messages, [{ documentId: DOC_ID, projectId: '207' }]);
});

test('a raise that loses every race at ingest end does not fail the ingest', async (t) => {
  // The chunks are in and the document is marked extracted by the time this runs. A throw here
  // would 500 a request that succeeded, and the extraction host would re-ingest a document that
  // landed — minutes of GPU per document, on the path that is already the slow one.
  t.afterEach(() => t.mock.restoreAll());
  t.mock.method(restampChunks, 'enabled', () => true);
  t.mock.method(restampChunks, 'enqueue', async () => {});
  let reads = 0;
  t.mock.method(documents, 'getById', async () => {
    reads += 1;
    return reads === 1 ? storedDocument() : storedDocument({ typeId: NEW_TYPE_ID });
  });
  t.mock.method(documents, 'patchExtraction', async () => ({}));
  t.mock.method(chunks, 'replaceForDocument', async (access, id, items) =>
    ({ succeeded: items.length, failed: 0, statusCounts: {} }));
  t.mock.method(documents, 'setParentFieldsPending', async () => {
    throw new Error('parentFieldsPending raise lost 3 races');
  });
  const errors = [];
  t.mock.method(logger, 'error', (message, meta) => { errors.push({ message, meta }); });

  const res = mockRes();
  await documentController.ingestChunks({
    params: { id: DOC_ID }, query: {}, user: STAFF, body: { markdown: 'x'.repeat(9000) }
  }, res);

  assert.strictEqual(res.statusCode, 200);
  assert.ok(errors.some(e => /drift check/.test(e.message)),
    'a lost raise that nobody logs is drift nothing will ever look for');
});

test('an ingest nothing moved under raises nothing', async (t) => {
  // The check has to mean something. Raising on every ingest would put the whole corpus on the
  // reconcile line for the length of a re-extraction.
  t.afterEach(() => t.mock.restoreAll());
  t.mock.method(restampChunks, 'enabled', () => true);
  const messages = [];
  t.mock.method(restampChunks, 'enqueue', async (message) => { messages.push(message); });
  t.mock.method(documents, 'getById', async () => storedDocument());
  t.mock.method(documents, 'patchExtraction', async () => ({}));
  t.mock.method(chunks, 'upsertBatch', async (access, id, items) =>
    ({ succeeded: items.length, failed: 0, statusCounts: {} }));
  t.mock.method(chunks, 'deleteSurplus', async () => ({ succeeded: 0, failed: 0 }));
  const { flagged } = watchPending(t);

  await documentController.ingestChunks(streamOf(blocksFor(2)), mockRes());

  assert.deepStrictEqual(flagged, []);
  assert.deepStrictEqual(messages, []);
});
