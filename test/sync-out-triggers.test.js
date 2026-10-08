'use strict';

/**
 * The sync-out queue trigger, registered against a recording `app` — same shape and same reason as
 * test/restamp-chunks-triggers.test.js: an unresolvable `%SYNC_OUT_QUEUE%` fails host startup.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { loadIndex } = require('./helpers/load-index');

test('no SYNC_OUT_QUEUE registers no queue trigger, and leaves the API registered', (t) => {
  const { registered } = loadIndex(t, 'SYNC_OUT_QUEUE', undefined);

  assert.deepStrictEqual(registered.queues, []);
  assert.strictEqual(registered.https.length, 2);
});

test('an empty SYNC_OUT_QUEUE is off too', (t) => {
  const { registered } = loadIndex(t, 'SYNC_OUT_QUEUE', '');
  assert.deepStrictEqual(registered.queues, []);
});

test('a queue name registers the worker against the app setting, not its value', (t) => {
  const { registered } = loadIndex(t, 'SYNC_OUT_QUEUE', 'sync-out');

  assert.strictEqual(registered.queues.length, 1);
  const [{ name, options }] = registered.queues;
  assert.strictEqual(name, 'syncOutWorker');
  assert.strictEqual(options.queueName, '%SYNC_OUT_QUEUE%');
  assert.strictEqual(options.connection, 'AzureWebJobsStorage',
    'the producer sends on the host storage account; a different connection is a different queue');
});

test('the handler passes the message and delivery to sync-out, and rethrows', async (t) => {
  const { index } = loadIndex(t, 'SYNC_OUT_QUEUE', 'sync-out');
  const resolved = require.resolve('../src/sync-out');
  const cached = require.cache[resolved];
  const calls = [];
  const workerHandler = async (message, context) => {
    calls.push({ message, context });
    throw new Error('last attempt');
  };
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: { workerHandler } };
  t.after(() => { require.cache[resolved] = cached; });

  const body = '{"consumer":"eagle","id":"engage-42"}';
  const context = { triggerMetadata: { dequeueCount: 3 } };
  await assert.rejects(index.syncOutWorker(body, context), /last attempt/,
    'a failure the worker throws must reach the host, or the message never reaches the poison queue');
  assert.deepStrictEqual(calls, [{ message: body, context }]);
});
