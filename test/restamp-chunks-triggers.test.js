'use strict';

/**
 * The chunk re-stamp queue trigger, registered against a recording `app` — same shape and same
 * reason as test/bulk-download-triggers.test.js.
 *
 * The guard is the part worth testing. `%CHUNK_RESTAMP_QUEUE%` is resolved by the HOST at startup,
 * and an unresolvable name is not a disabled worker: it is a startup error that takes the HTTP
 * functions down with it, so an environment that never set the setting must register nothing.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { loadIndex } = require('./helpers/load-index');

const MAX_DEQUEUE_COUNT = require('../host.json').extensions.queues.maxDequeueCount;

test('no CHUNK_RESTAMP_QUEUE registers no queue trigger, and leaves the API registered', (t) => {
  const { registered } = loadIndex(t, 'CHUNK_RESTAMP_QUEUE', undefined);

  assert.deepStrictEqual(registered.queues, []);
  assert.strictEqual(registered.https.length, 2);
});

test('an empty CHUNK_RESTAMP_QUEUE is off too', (t) => {
  const { registered } = loadIndex(t, 'CHUNK_RESTAMP_QUEUE', '');
  assert.deepStrictEqual(registered.queues, [],
    'Flex drops an app setting deployed empty, so the code reads undefined — but a param left at ' +
    "'' in one environment and a PUT of the whole collection in another must land the same way");
});

test('a queue name registers the worker against the app setting, not its value', (t) => {
  const { registered } = loadIndex(t, 'CHUNK_RESTAMP_QUEUE', 'chunk-restamp');

  assert.strictEqual(registered.queues.length, 1);
  const [{ name, options }] = registered.queues;

  assert.strictEqual(name, 'restampChunksWorker');
  assert.strictEqual(options.queueName, '%CHUNK_RESTAMP_QUEUE%',
    'the binding names the setting so the host re-reads it — inlining the value would make a ' +
    'queue rename a code deploy');
  assert.strictEqual(options.connection, 'AzureWebJobsStorage',
    'the producer sends on the host storage account; a different connection is a different queue');
  assert.strictEqual(typeof options.handler, 'function');
});

/** Replace the job module with a recorder; the handler `require`s it lazily. */
function stubJob(t, run) {
  const script = require.resolve('../src/jobs/restamp-chunks');
  const cached = require.cache[script];
  require.cache[script] = { id: script, filename: script, loaded: true, exports: { run } };
  t.after(() => { require.cache[script] = cached; });
}

test('the handler hands the message body to the job', async (t) => {
  const { index } = loadIndex(t, 'CHUNK_RESTAMP_QUEUE', 'chunk-restamp');
  const bodies = [];
  stubJob(t, async (message) => { bodies.push(message); });

  const body = JSON.stringify({ documentId: 'doc-1', projectId: '207' });
  await index.restampChunksWorker(body);

  assert.deepStrictEqual(bodies, [body],
    'the job owns the body shape — the trigger must not parse or reshape it on the way past');
});

test('the worker tells the job which delivery this is', async (t) => {
  const { index } = loadIndex(t, 'CHUNK_RESTAMP_QUEUE', 'chunk-restamp');
  const deliveries = [];
  stubJob(t, async (message, delivery) => { deliveries.push(delivery); });

  await index.restampChunksWorker('{"documentId":"doc-1"}',
    { triggerMetadata: { dequeueCount: 3 } });

  // The ceiling is read from host.json, not repeated: the queue extension is what decides how many
  // deliveries a message gets, and a copy of the number drifts into paging on the wrong attempt.
  assert.deepStrictEqual(deliveries, [{ attempt: 3, maxAttempts: MAX_DEQUEUE_COUNT }],
    'without it the job cannot tell the delivery that poisons from one that still has a retry');
});

test('a failing re-stamp is rethrown so the queue can retry and poison it', async (t) => {
  const { index } = loadIndex(t, 'CHUNK_RESTAMP_QUEUE', 'chunk-restamp');
  stubJob(t, async () => { throw new Error('cosmos unavailable'); });

  await assert.rejects(index.restampChunksWorker('{"documentId":"doc-1"}'), /cosmos unavailable/,
    'a swallowed failure would report a document whose chunks are still stale as re-stamped');
});
