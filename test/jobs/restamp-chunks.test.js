'use strict';

/**
 * The chunk re-stamp queue, both ends.
 *
 * The producer runs on a request that must not wait for the walk, and the handler runs on a
 * message that may be delivered more than once — so the assertions worth making are about what
 * the body carries (ids, never values) and about what the handler does when the patch does not
 * fully land. A swallowed failure here is a document whose chunks answer the old type filter for
 * the life of the chunk, with nothing on the wire to say so.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../../src/config');
const cosmos = require('../../src/db/cosmos-nosql');
const documents = require('../../src/repositories/documents');
const chunks = require('../../src/repositories/chunks');
const { logger } = require('../../src/utils/logger');

const restamp = require('../../src/jobs/restamp-chunks');

const { storedDocument, DOCUMENT_EAGLE_ID } = require('../helpers/eagle-mirror-fixtures');

const DOC_ID = DOCUMENT_EAGLE_ID;
const PROJECT_ID = '207';
/** The `parentFieldsPendingAt` a write left on the row, and the guard the clear has to carry. */
const TOKEN = '2026-09-01T00:00:00.000Z';

const patchResult = (overrides = {}) =>
  ({ succeeded: 19, failed: 0, statusCounts: { 200: 19 }, requestCharge: 42, ...overrides });

/** Set `config.chunkRestampQueue` for one test and put it back afterwards. */
function withQueueName(t, name) {
  const previous = config.chunkRestampQueue;
  config.chunkRestampQueue = name;
  t.after(() => { config.chunkRestampQueue = previous; });
}

/**
 * A fresh copy of the module with the Azure queue SDK replaced by a recorder.
 *
 * Re-required rather than mocked in place because the QueueClient is memoised per queue in
 * `src/jobs/queue-client.js` at first send — a stub installed after that is never reached, and the
 * memo is why that module has to be dropped from the cache along with the SDK.
 */
function loadWithQueueStub(t, { send } = {}) {
  const MODULE = require.resolve('../../src/jobs/restamp-chunks');
  const QUEUE_CLIENT = require.resolve('../../src/jobs/queue-client');
  const QUEUE_SDK = require.resolve('@azure/storage-queue');
  const IDENTITY = require.resolve('@azure/identity');
  const cached = [MODULE, QUEUE_CLIENT, QUEUE_SDK, IDENTITY].map(id => [id, require.cache[id]]);

  const sent = [];
  const urls = [];
  const options = [];
  require.cache[QUEUE_SDK] = {
    id: QUEUE_SDK,
    filename: QUEUE_SDK,
    loaded: true,
    exports: {
      QueueClient: class {
        constructor(url) { urls.push(url); }
        async sendMessage(body, sendOptions) {
          sent.push(body);
          options.push(sendOptions);
          if (send) return send(body);
          return { messageId: 'msg-1' };
        }
      }
    }
  };
  require.cache[IDENTITY] = {
    id: IDENTITY,
    filename: IDENTITY,
    loaded: true,
    exports: { DefaultAzureCredential: class {} }
  };
  delete require.cache[MODULE];
  delete require.cache[QUEUE_CLIENT];

  t.after(() => {
    for (const [id, entry] of cached) {
      if (entry === undefined) delete require.cache[id];
      else require.cache[id] = entry;
    }
  });

  return { module: require(MODULE), sent, urls, options };
}

test('the queue is off until it is named', (t) => {
  withQueueName(t, '');
  assert.strictEqual(restamp.enabled(), false,
    'Azure drops an app setting whose value is empty, so unset has to read as off');

  config.chunkRestampQueue = 'chunk-restamp';
  assert.strictEqual(restamp.enabled(), true);
});

test('the message carries the two ids and nothing else', async (t) => {
  withQueueName(t, 'chunk-restamp');
  process.env.AzureWebJobsStorage__accountName = 'demifcstore';
  t.after(() => { delete process.env.AzureWebJobsStorage__accountName; });

  const { module: queued, sent, urls } = loadWithQueueStub(t);

  await queued.enqueue({ documentId: DOC_ID, projectId: PROJECT_ID });

  assert.strictEqual(sent.length, 1);
  // The exact set, not a subset: field VALUES in the body would make a redelivered message
  // re-stamp whatever was true at enqueue time, which is the older edit whenever two overlap.
  assert.deepStrictEqual(JSON.parse(sent[0]), { documentId: DOC_ID, projectId: PROJECT_ID });
  assert.match(urls[0], /^https:\/\/demifcstore\.queue\.core\.windows\.net\/chunk-restamp$/,
    'the queue the worker triggers on is named by the same setting');
});

test('a send with no queue name and a send with no storage account both refuse', async (t) => {
  withQueueName(t, '');
  const { module: off } = loadWithQueueStub(t);
  await assert.rejects(off.enqueue({ documentId: DOC_ID, projectId: PROJECT_ID }),
    /CHUNK_RESTAMP_QUEUE is not set/);

  config.chunkRestampQueue = 'chunk-restamp';
  delete process.env.AzureWebJobsStorage__accountName;
  await assert.rejects(off.enqueue({ documentId: DOC_ID, projectId: PROJECT_ID }),
    /AzureWebJobsStorage__accountName is not set/,
    'a named queue with no account behind it is a broken deploy, not a switched-off feature');
});

test('the handler stamps the document as it reads it now, not as the message left it', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const current = storedDocument({ typeId: 'ffffffffffffffffffffffff' });
  const reads = [];
  t.mock.method(documents, 'getById', async (access, id, projectId) => {
    reads.push({ id, projectId });
    return current;
  });
  const patched = [];
  t.mock.method(chunks, 'setParentFieldsForDocument', async (access, id, document) => {
    patched.push({ id, document });
    return patchResult();
  });

  // A body written before the re-type above, carrying a stale value it must not be trusted for.
  const result = await restamp.run(JSON.stringify({
    documentId: DOC_ID, projectId: PROJECT_ID, typeId: 'aaaaaaaaaaaaaaaaaaaaaaaa'
  }));

  assert.deepStrictEqual(reads, [{ id: DOC_ID, projectId: PROJECT_ID }],
    'the project id is the container partition key — without it this is a cross-partition query');
  assert.strictEqual(patched.length, 1);
  assert.strictEqual(patched[0].document.typeId, 'ffffffffffffffffffffffff');
  assert.deepStrictEqual(result, { documentId: DOC_ID, patched: 19, failed: 0 });
});

test('the walk is guarded on the token the flag was raised with', async (t) => {
  // Without the guard the walk writes the values it read over whatever a chunk holds, so a message
  // that waited behind a retry puts a superseded type back onto chunks a newer walk — or the
  // ingest that wrote them — had already made current.
  t.afterEach(() => t.mock.restoreAll());

  t.mock.method(documents, 'getById', async () => storedDocument({ parentFieldsPendingAt: TOKEN }));
  const opts = [];
  t.mock.method(chunks, 'setParentFieldsForDocument', async (access, id, document, options) => {
    opts.push(options);
    return patchResult();
  });
  t.mock.method(documents, 'setParentFieldsPending', async () => ({ status: 'cleared' }));

  await restamp.run(JSON.stringify({ documentId: DOC_ID, projectId: PROJECT_ID }));

  assert.deepStrictEqual(opts, [{ stampedAt: TOKEN }]);
});

test('a row carrying no token is walked at the instant it was delivered', async (t) => {
  // Rows flagged before the token existed, and the `--live` repairs that send no flag at all. The
  // walk still has to say how new its values are, or every chunk it writes is overwritable by an
  // older walk that has not finished yet.
  t.afterEach(() => t.mock.restoreAll());

  t.mock.method(documents, 'getById', async () => storedDocument());
  const opts = [];
  t.mock.method(chunks, 'setParentFieldsForDocument', async (access, id, document, options) => {
    opts.push(options);
    return patchResult();
  });
  t.mock.method(documents, 'setParentFieldsPending', async () => ({ status: 'cleared' }));

  const before = new Date().toISOString();
  await restamp.run(JSON.stringify({ documentId: DOC_ID, projectId: PROJECT_ID }));

  assert.strictEqual(opts.length, 1);
  assert.ok(opts[0].stampedAt >= before,
    `an unguarded walk is last-writer-wins across concurrent walks: ${opts[0].stampedAt}`);
});

test('chunks a newer walk already stamped are reported, not counted as losses', async (t) => {
  // A 412 here means the chunk is NEWER than this walk, which is the guard working. Treating it as
  // a failed write would throw, retry the same walk three times and then poison a message that had
  // nothing to do.
  t.afterEach(() => t.mock.restoreAll());

  t.mock.method(documents, 'getById', async () => storedDocument({ parentFieldsPendingAt: TOKEN }));
  t.mock.method(chunks, 'setParentFieldsForDocument', async () =>
    patchResult({ succeeded: 12, failed: 0, skippedNewer: 7 }));
  const cleared = [];
  t.mock.method(documents, 'setParentFieldsPending', async (id, projectId, pending) => {
    cleared.push(pending);
    return { status: 'cleared', pendingAt: null };
  });
  const lines = [];
  t.mock.method(logger, 'info', (message, meta) => { lines.push({ message, meta }); });

  const result = await restamp.run(JSON.stringify({ documentId: DOC_ID, projectId: PROJECT_ID }));

  assert.deepStrictEqual(result, { documentId: DOC_ID, patched: 12, failed: 0 });
  assert.deepStrictEqual(cleared, [false], 'the walk served its token, so the flag comes down');
  const summary = lines.find(l => /chunk restamp/.test(l.message));
  assert.strictEqual(summary.meta.skippedNewer, 7,
    'a walk that wrote nothing because everything was newer has to be readable as that');
});

test('a landed patch clears the pending flag the write left behind', async (t) => {
  // The other half of the flag the document controller sets: without this the flag is written once
  // and never cleared, `--pending` re-stamps the same documents every run, and the reconcile line
  // the drift alert reads never returns to zero.
  t.afterEach(() => t.mock.restoreAll());

  t.mock.method(documents, 'getById', async () => storedDocument({ parentFieldsPendingAt: TOKEN }));
  t.mock.method(chunks, 'setParentFieldsForDocument', async () => patchResult());
  const cleared = [];
  t.mock.method(documents, 'setParentFieldsPending', async (id, projectId, pending, guard) => {
    cleared.push({ id, projectId, pending, guard });
    return { status: 'cleared', pendingAt: null };
  });

  await restamp.run(JSON.stringify({ documentId: DOC_ID, projectId: PROJECT_ID }));

  // The TOKEN off the row this run walked, not its revision: an unrelated write during the walk
  // moves `_etag` and must not refuse the clear.
  assert.deepStrictEqual(cleared,
    [{ id: DOC_ID, projectId: PROJECT_ID, pending: false, guard: { pendingAt: TOKEN } }]);
});

test('an unrelated write during the walk does not refuse the clear', async (t) => {
  // THE FLAG THAT STUCK. The clear used to carry the row's `_etag`, so any write landing during the
  // walk — `patchExtraction` recording an ingest, a display-name push — answered 412 and left the
  // flag up for a document whose chunks were already correct. Only an operator running
  // `--pending` took it back down. The token is not moved by those writes.
  t.afterEach(() => t.mock.restoreAll());

  t.mock.method(documents, 'getById', async () =>
    storedDocument({ _etag: '"0x8DC1"', parentFieldsPendingAt: TOKEN }));
  t.mock.method(chunks, 'setParentFieldsForDocument', async () => patchResult());
  const patched = [];
  t.mock.method(cosmos, 'patch', async (container, id, partitionKey, operations, condition, etag) => {
    patched.push({ condition, etag });
    return {};
  });

  await restamp.run(JSON.stringify({ documentId: DOC_ID, projectId: PROJECT_ID }));

  assert.strictEqual(patched.length, 1);
  assert.strictEqual(patched[0].etag, undefined,
    'an IfMatch on the row revision is what an unrelated write breaks');
  assert.match(patched[0].condition, /parentFieldsPendingAt = "2026-09-01T00:00:00\.000Z"/,
    `the clear must be conditional on the token it walked for, got: ${patched[0].condition}`);
});

test('the empty-string partition survives the message and reaches the patch', async (t) => {
  // Documents linked to no project live in `''`, which is a partition like any other. A falsy test
  // anywhere on this path turns a pinned read of it into a cross-partition scan of all 357.
  t.afterEach(() => t.mock.restoreAll());

  const reads = [];
  t.mock.method(documents, 'getById', async (access, id, projectId) => {
    reads.push({ id, projectId });
    return storedDocument({ projectId: '' });
  });
  t.mock.method(chunks, 'setParentFieldsForDocument', async () => patchResult());
  const patches = [];
  t.mock.method(cosmos, 'patch', async (container, id, partitionKey) => {
    patches.push({ container, id, partitionKey });
    return {};
  });

  await restamp.run(JSON.stringify({ documentId: DOC_ID, projectId: '' }));

  assert.deepStrictEqual(reads, [{ id: DOC_ID, projectId: '' }],
    'the body said which partition to read; dropping it costs a fan-out per message');
  assert.strictEqual(patches.length, 1);
  assert.strictEqual(patches[0].partitionKey, '', 'the flag is cleared in the same partition');
});

test('a flag raised after the handler read the document is left raised', async (t) => {
  // The losing sequence: this handler reads the row, a newer parent-field write lands and raises
  // the flag again with a token of its own, and an unconditional clear here wipes a flag that
  // stands for chunks this run never saw. The reconcile counts the flag, so clearing it is the
  // last signal that the newer write's chunks are stale.
  t.afterEach(() => t.mock.restoreAll());

  t.mock.method(documents, 'getById', async () => storedDocument({ parentFieldsPendingAt: TOKEN }));
  t.mock.method(chunks, 'setParentFieldsForDocument', async () => patchResult());
  const cleared = [];
  t.mock.method(documents, 'setParentFieldsPending', async (id, projectId, pending, guard) => {
    cleared.push({ id, projectId, pending, guard });
    return { status: 'conflict', pendingAt: guard.pendingAt };
  });
  const lines = [];
  t.mock.method(logger, 'info', (message, meta) => { lines.push({ message, meta }); });

  const result = await restamp.run(JSON.stringify({ documentId: DOC_ID, projectId: PROJECT_ID }));

  assert.deepStrictEqual(cleared[0].guard, { pendingAt: TOKEN },
    'the clear has to name the token this handler walked for, or it cannot be refused');
  assert.deepStrictEqual(result, { documentId: DOC_ID, patched: 19, failed: 0 },
    'a newer write owning the flag is not a job failure and must not poison the message');
  // Info, not warn: the newer change has a re-stamp of its own and nothing here needs attention.
  const notice = lines.find(l => /owns the flag/.test(l.message));
  assert.ok(notice, 'the one line that says why a flag outlived a successful re-stamp');
  assert.strictEqual(notice.meta.documentId, DOC_ID);
});

test('a row that vanished before the clear completes the message', async (t) => {
  // `missing` is not a failure to retry: the row is gone and its chunks went with it. Throwing
  // here would spend the message's attempts and poison it over a document that no longer exists.
  t.afterEach(() => t.mock.restoreAll());

  t.mock.method(documents, 'getById', async () => storedDocument({ parentFieldsPendingAt: TOKEN }));
  t.mock.method(chunks, 'setParentFieldsForDocument', async () => patchResult());
  t.mock.method(documents, 'setParentFieldsPending', async () =>
    ({ status: 'missing', reason: 'patch' }));
  const warnings = [];
  t.mock.method(logger, 'warn', (message, meta) => { warnings.push({ message, meta }); });

  const result = await restamp.run(JSON.stringify({ documentId: DOC_ID, projectId: PROJECT_ID }));

  assert.deepStrictEqual(result, { documentId: DOC_ID, patched: 19, failed: 0 });
  const notice = warnings.find(w => /gone before the pending flag/.test(w.message));
  assert.ok(notice, 'a flag that cannot be cleared because the row left has to be visible');
  assert.strictEqual(notice.meta.reason, 'patch');
});

test('a clear that failed for any other reason still fails the message', async (t) => {
  // Only 412 is an answer. Swallowing the rest would leave the flag raised with nothing retrying.
  t.afterEach(() => t.mock.restoreAll());

  t.mock.method(documents, 'getById', async () => storedDocument());
  t.mock.method(chunks, 'setParentFieldsForDocument', async () => patchResult());
  t.mock.method(documents, 'setParentFieldsPending', async () => {
    throw Object.assign(new Error('cosmos unavailable'), { code: 503 });
  });
  t.mock.method(logger, 'error', () => {});

  await assert.rejects(
    () => restamp.run(JSON.stringify({ documentId: DOC_ID, projectId: PROJECT_ID })),
    /cosmos unavailable/);
});

test('a patch that lost a chunk leaves the flag alone', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  t.mock.method(documents, 'getById', async () => storedDocument());
  t.mock.method(chunks, 'setParentFieldsForDocument', async () =>
    patchResult({ succeeded: 12, failed: 7 }));
  const cleared = [];
  t.mock.method(documents, 'setParentFieldsPending', async (...args) => { cleared.push(args); });
  t.mock.method(logger, 'error', () => {});

  await assert.rejects(
    () => restamp.run(JSON.stringify({ documentId: DOC_ID, projectId: PROJECT_ID })),
    /patch failed for 7 of 19/);
  assert.deepStrictEqual(cleared, [],
    'clearing on a part-stamped document is how the drift stops being visible');
});

test('the handler logs a summary of what it patched', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  t.mock.method(documents, 'getById', async () => storedDocument());
  t.mock.method(chunks, 'setParentFieldsForDocument', async () =>
    patchResult({ succeeded: 6104, failed: 0 }));
  const lines = [];
  t.mock.method(logger, 'info', (message, meta) => { lines.push({ message, meta }); });

  await restamp.run(JSON.stringify({ documentId: DOC_ID, projectId: PROJECT_ID }));

  const summary = lines.find(l => /chunk restamp/.test(l.message));
  assert.ok(summary, 'a job that runs out of sight of the request has to leave a record');
  assert.strictEqual(summary.meta.documentId, DOC_ID);
  assert.strictEqual(summary.meta.patched, 6104);
  assert.strictEqual(summary.meta.failed, 0);
});

test('a Buffer body is the same message', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  t.mock.method(documents, 'getById', async () => storedDocument());
  const patched = [];
  t.mock.method(chunks, 'setParentFieldsForDocument', async (access, id) => {
    patched.push(id);
    return patchResult();
  });

  await restamp.run(Buffer.from(JSON.stringify({ documentId: DOC_ID, projectId: PROJECT_ID })));

  assert.deepStrictEqual(patched, [DOC_ID]);
});

test('a document that no longer exists completes the message instead of retrying forever', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  t.mock.method(documents, 'getById', async () => null);
  let patches = 0;
  t.mock.method(chunks, 'setParentFieldsForDocument', async () => { patches += 1; });
  const warnings = [];
  t.mock.method(logger, 'warn', (message, meta) => { warnings.push({ message, meta }); });

  const result = await restamp.run(JSON.stringify({ documentId: DOC_ID, projectId: PROJECT_ID }));

  assert.strictEqual(patches, 0);
  assert.strictEqual(result.patched, 0);
  assert.strictEqual(warnings.length, 1, 'a purged document is a completed message, but not a silent one');
  assert.strictEqual(warnings[0].meta.documentId, DOC_ID);
});

test('a partly failed patch throws, so the queue redelivers it', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  t.mock.method(documents, 'getById', async () => storedDocument());
  t.mock.method(chunks, 'setParentFieldsForDocument', async () =>
    patchResult({ succeeded: 17, failed: 2 }));

  // Inline this was swallowed, because the document write had already answered 200 and a 500 would
  // have failed a request that succeeded. Off the request there is nothing left to fail, and the
  // ids-only body makes the redelivery safe.
  await assert.rejects(restamp.run(JSON.stringify({ documentId: DOC_ID, projectId: PROJECT_ID })),
    /failed for 2 of 19 chunks/);
});

test('a patch that throws is not swallowed either', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  t.mock.method(documents, 'getById', async () => storedDocument());
  t.mock.method(chunks, 'setParentFieldsForDocument', async () => {
    throw new Error('cosmos unavailable');
  });

  await assert.rejects(restamp.run(JSON.stringify({ documentId: DOC_ID, projectId: PROJECT_ID })),
    /cosmos unavailable/);
});

test('a body the handler cannot read is poisoned, not dropped', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  let reads = 0;
  t.mock.method(documents, 'getById', async () => { reads += 1; return storedDocument(); });

  await assert.rejects(restamp.run('58869abba4acd4014b81f55c'), /is not JSON/,
    'the bulk-download queue sends a bare id on the same account — one shape per queue, and a ' +
    'body from the wrong one has to be visible rather than acted on');
  await assert.rejects(restamp.run(JSON.stringify({ projectId: PROJECT_ID })), /no documentId/);

  assert.strictEqual(reads, 0);
});

/**
 * The three partition shapes a body can carry, and the one that means "unknown".
 *
 * `''` and JSON `null` are both real Cosmos partitions — null goes on the wire as `[null]`, and an
 * ABSENT property is a different partition again (PartitionKey.None, `[{}]`). Only an absent key
 * means the partition is unknown, and only that may cost the cross-partition drain. `??` folded null
 * into undefined, so every re-stamp of a null-partition document paid for a scan.
 */
test('parseMessage keeps null distinct from absent', async (t) => {
  const parse = (body) => restamp.parseMessage(body);

  await t.test('a null projectId survives as null', () => {
    assert.strictEqual(parse({ documentId: DOC_ID, projectId: null }).projectId, null);
  });

  await t.test('an empty-string projectId survives as the empty string', () => {
    assert.strictEqual(parse({ documentId: DOC_ID, projectId: '' }).projectId, '');
  });

  await t.test('an absent projectId is the only undefined', () => {
    assert.strictEqual(parse({ documentId: DOC_ID }).projectId, undefined);
  });

  await t.test('the same holds through the JSON text the queue actually carries', () => {
    assert.strictEqual(
      parse(JSON.stringify({ documentId: DOC_ID, projectId: null })).projectId, null);
    assert.strictEqual(
      parse(Buffer.from(JSON.stringify({ documentId: DOC_ID }))).projectId, undefined);
  });
});

test('a null-partition document is read at its own partition, not cross-partition', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const reads = [];
  t.mock.method(documents, 'getById', async (access, id, projectId) => {
    reads.push({ id, projectId });
    return storedDocument({ projectId: null });
  });
  t.mock.method(chunks, 'setParentFieldsForDocument', async () => patchResult());
  t.mock.method(documents, 'setParentFieldsPending', async () => ({ status: 'cleared' }));

  await restamp.run(JSON.stringify({ documentId: DOC_ID, projectId: null }));

  assert.deepStrictEqual(reads, [{ id: DOC_ID, projectId: null }],
    'undefined here turns a point read into a drain of up to 50 pages');
});

test('an object body is the same message', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  t.mock.method(documents, 'getById', async () => storedDocument());
  const patched = [];
  t.mock.method(chunks, 'setParentFieldsForDocument', async (access, id) => {
    patched.push(id);
    return patchResult();
  });

  // What the trigger actually delivers: the Node worker JSON-parses a queue body on the way in
  // (`fromRpcTypedData`), so the handler is handed an object and never the text that was sent.
  await restamp.run({ documentId: DOC_ID, projectId: PROJECT_ID });

  assert.deepStrictEqual(patched, [DOC_ID]);
});

test('a failure with attempts left re-queues the ids and does not throw', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  withQueueName(t, 'chunk-restamp');
  process.env.AzureWebJobsStorage__accountName = 'demifcstore';
  t.after(() => { delete process.env.AzureWebJobsStorage__accountName; });

  const { module: job, sent, options } = loadWithQueueStub(t);
  t.mock.method(documents, 'getById', async () => storedDocument());
  t.mock.method(chunks, 'setParentFieldsForDocument', async () => {
    throw new Error('429 too many requests');
  });
  const errors = [];
  t.mock.method(logger, 'error', (message, meta) => { errors.push({ message, meta }); });

  await job.run({ documentId: DOC_ID, projectId: PROJECT_ID }, { attempt: 1, maxAttempts: 3 });

  assert.deepStrictEqual(JSON.parse(sent[0]),
    { documentId: DOC_ID, projectId: PROJECT_ID, attempt: 2 },
    'the retry is a new message, so which attempt it is has to travel in the body');
  assert.strictEqual(options[0].visibilityTimeout, 30,
    'host.json hides a returned message for an hour — the zip worker\'s number, and the whole ' +
    'reason a retry is sent rather than thrown for');
  assert.deepStrictEqual(errors.filter(e => e.message.startsWith('[chunk restamp] job failed')), [],
    'the poison alert reads that phrase, and this attempt still has a retry coming');
});

test('each further attempt waits twice as long', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  withQueueName(t, 'chunk-restamp');
  process.env.AzureWebJobsStorage__accountName = 'demifcstore';
  t.after(() => { delete process.env.AzureWebJobsStorage__accountName; });

  const { module: job, sent, options } = loadWithQueueStub(t);
  t.mock.method(documents, 'getById', async () => storedDocument());
  t.mock.method(chunks, 'setParentFieldsForDocument', async () => {
    throw new Error('429 too many requests');
  });

  // Second attempt, counted off the body: a re-queued message is new, so its own dequeueCount is 1.
  await job.run({ documentId: DOC_ID, projectId: PROJECT_ID, attempt: 2 },
    { attempt: 1, maxAttempts: 3 });

  assert.strictEqual(JSON.parse(sent[0]).attempt, 3);
  assert.strictEqual(options[0].visibilityTimeout, 60);
});

test('the last attempt logs the line the alert matches and throws so the message poisons', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  withQueueName(t, 'chunk-restamp');
  process.env.AzureWebJobsStorage__accountName = 'demifcstore';
  t.after(() => { delete process.env.AzureWebJobsStorage__accountName; });

  const { module: job, sent } = loadWithQueueStub(t);
  t.mock.method(documents, 'getById', async () => storedDocument());
  t.mock.method(chunks, 'setParentFieldsForDocument', async () => {
    throw new Error('cosmos unavailable');
  });
  const errors = [];
  t.mock.method(logger, 'error', (message, meta) => { errors.push({ message, meta }); });

  await assert.rejects(
    job.run({ documentId: DOC_ID, projectId: PROJECT_ID, attempt: 3 },
      { attempt: 1, maxAttempts: 3 }),
    /cosmos unavailable/);

  assert.deepStrictEqual(sent, [], 'the attempts are spent, so a fourth message would never poison');
  const final = errors.find(e => e.message.startsWith('[chunk restamp] job failed'));
  assert.ok(final, 'the phrase is what demi-chunk-restamp-failed-<env> counts');
  assert.match(final.message, new RegExp(DOC_ID),
    'the alert leads to a runbook that needs the document id to repair anything');
});

test('a redelivery of the spent message poisons it without re-running or alerting again',
  async (t) => {
    // The queue is what poisons a message, and only after `maxDequeueCount` deliveries of it — so
    // the message that ran out of attempts is handed back twice more. Walking the chunks again
    // would spend the same minutes on a job already declared dead, and would fire
    // demi-chunk-restamp-failed-<env> three times, an hour apart, for one document.
    t.afterEach(() => t.mock.restoreAll());
    withQueueName(t, 'chunk-restamp');
    process.env.AzureWebJobsStorage__accountName = 'demifcstore';
    t.after(() => { delete process.env.AzureWebJobsStorage__accountName; });

    const { module: job, sent } = loadWithQueueStub(t);
    let walks = 0;
    t.mock.method(documents, 'getById', async () => storedDocument());
    t.mock.method(chunks, 'setParentFieldsForDocument', async () => {
      walks += 1;
      throw new Error('cosmos unavailable');
    });
    const errors = [];
    t.mock.method(logger, 'error', (message, meta) => { errors.push({ message, meta }); });

    await assert.rejects(
      job.run({ documentId: DOC_ID, projectId: PROJECT_ID, attempt: 3 },
        { attempt: 2, maxAttempts: 3 }),
      /already failed its last attempt/);

    assert.strictEqual(walks, 0, 'the walk must not be paid for a second time');
    assert.deepStrictEqual(sent, []);
    assert.deepStrictEqual(errors.filter(e => e.message.startsWith('[chunk restamp] job failed')), [],
      'one dead document is one alert line, not one per redelivery');
  });
