'use strict';

/**
 * The search-definition queue trigger, registered against a recording `app` — same shape and same
 * reason as test/restamp-chunks-triggers.test.js.
 *
 * `%SEARCH_DEFINITIONS_QUEUE%` is resolved by the HOST at startup, and an unresolvable name is not
 * a disabled worker: it is a startup error that takes the HTTP functions down with it.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { loadIndex } = require('./helpers/load-index');

const MAX_DEQUEUE_COUNT = require('../host.json').extensions.queues.maxDequeueCount;

test('no SEARCH_DEFINITIONS_QUEUE registers no queue trigger, and leaves the API registered', (t) => {
  const { registered } = loadIndex(t, 'SEARCH_DEFINITIONS_QUEUE', undefined);

  assert.deepStrictEqual(registered.queues, []);
  assert.strictEqual(registered.https.length, 2);
});

test('an empty SEARCH_DEFINITIONS_QUEUE is off too', (t) => {
  const { registered } = loadIndex(t, 'SEARCH_DEFINITIONS_QUEUE', '');
  assert.deepStrictEqual(registered.queues, [],
    'Flex drops an app setting deployed empty, so the code reads undefined');
});

test('a queue name registers the worker against the app setting, not its value', (t) => {
  const { registered } = loadIndex(t, 'SEARCH_DEFINITIONS_QUEUE', 'search-definitions');

  assert.strictEqual(registered.queues.length, 1);
  const [{ name, options }] = registered.queues;

  assert.strictEqual(name, 'searchDefinitionsWorker');
  assert.strictEqual(options.queueName, '%SEARCH_DEFINITIONS_QUEUE%');
  assert.strictEqual(options.connection, 'AzureWebJobsStorage');
  assert.strictEqual(typeof options.handler, 'function');
});

/** Replace the job module with a recorder; the handler `require`s it lazily. */
function stubJob(t, run) {
  const script = require.resolve('../src/jobs/search-definitions');
  const cached = require.cache[script];
  require.cache[script] = { id: script, filename: script, loaded: true, exports: { run } };
  t.after(() => { require.cache[script] = cached; });
}

test('the handler hands the job id and the delivery count to the job', async (t) => {
  const { index } = loadIndex(t, 'SEARCH_DEFINITIONS_QUEUE', 'search-definitions');
  const calls = [];
  stubJob(t, async (jobId, delivery) => { calls.push({ jobId, delivery }); });

  await index.searchDefinitionsWorker('searchdef:6f1c4b9e-0d2a-4d9d-9c3e-1f5f9a2b7c40',
    { triggerMetadata: { dequeueCount: 2 } });

  assert.deepStrictEqual(calls, [{
    jobId: 'searchdef:6f1c4b9e-0d2a-4d9d-9c3e-1f5f9a2b7c40',
    delivery: { attempt: 2, maxAttempts: MAX_DEQUEUE_COUNT }
  }]);
});
