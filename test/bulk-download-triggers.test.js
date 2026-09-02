'use strict';

/**
 * The queue worker and the zip sweeper are host triggers, so nothing about them runs outside Azure
 * — the app is loaded against a recording `app` (test/helpers/load-index.js) and the assertions are
 * on what it registered. Same shape and same reason as test/reconcile-timer.test.js.
 *
 * The guards are the part worth testing. `%BULK_DOWNLOADS_QUEUE%` and `%BULK_CLEANUP_SCHEDULE%` are
 * resolved by the HOST at startup, and an unresolvable name is a startup error that takes the HTTP
 * functions down with it. Both settings are empty wherever the feature is not switched on.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { logger } = require('../src/utils/logger');

const { loadIndex } = require('./helpers/load-index');

test('no BULK_DOWNLOADS_QUEUE registers no queue trigger, and leaves the API registered', (t) => {
  const { registered } = loadIndex(t, 'BULK_DOWNLOADS_QUEUE', undefined);

  assert.deepStrictEqual(registered.queues, [],
    'an app setting the environment never set must not become a startup failure');
  assert.strictEqual(registered.https.length, 2);
});

test('an empty BULK_DOWNLOADS_QUEUE is off too', (t) => {
  const { registered } = loadIndex(t, 'BULK_DOWNLOADS_QUEUE', '');
  assert.deepStrictEqual(registered.queues, [],
    'the setting is declared empty in every environment that has not opted in — the whole ' +
    'appSettings collection is a PUT, so absent is not an option');
});

test('a queue name registers the worker against the app setting, not its value', (t) => {
  const { registered } = loadIndex(t, 'BULK_DOWNLOADS_QUEUE', 'bulk-downloads');

  assert.strictEqual(registered.queues.length, 1);
  const [{ name, options }] = registered.queues;

  assert.strictEqual(name, 'bulkDownloadWorker');
  assert.strictEqual(options.queueName, '%BULK_DOWNLOADS_QUEUE%',
    'the binding names the setting so the host re-reads it — inlining the value would make a ' +
    'queue rename a code deploy');
  assert.strictEqual(options.connection, 'AzureWebJobsStorage',
    'the producer sends on the host storage account; a different connection is a different queue');
  assert.strictEqual(typeof options.handler, 'function');
});

/** Replace the worker module with a recorder; the handler `require`s it lazily. */
function stubWorker(t, run) {
  const script = require.resolve('../src/jobs/bulk-download');
  const cached = require.cache[script];
  require.cache[script] = { id: script, filename: script, loaded: true, exports: { run } };
  t.after(() => { require.cache[script] = cached; });
}

test('the handler runs the job named by the message', async (t) => {
  const { index } = loadIndex(t, 'BULK_DOWNLOADS_QUEUE', 'bulk-downloads');
  const ran = [];
  stubWorker(t, async (jobId) => { ran.push(jobId); });

  await index.bulkDownloadWorker('job-42');
  // messageEncoding "none" means the body is the bare id; a Buffer body is the same id undecoded.
  await index.bulkDownloadWorker(Buffer.from('job-43', 'utf8'));

  assert.deepStrictEqual(ran, ['job-42', 'job-43']);
});

test('the handler tells the worker which delivery this is', async (t) => {
  const { index } = loadIndex(t, 'BULK_DOWNLOADS_QUEUE', 'bulk-downloads');
  const deliveries = [];
  stubWorker(t, async (jobId, delivery) => { deliveries.push(delivery); });

  await index.bulkDownloadWorker('job-42', { triggerMetadata: { dequeueCount: 3 } });
  // No context at all — the host has passed one on every delivery so far, but a missing one must
  // not make every attempt look like the last.
  await index.bulkDownloadWorker('job-42');

  const maxAttempts = require('../host.json').extensions.queues.maxDequeueCount;
  assert.deepStrictEqual(deliveries, [
    { attempt: 3, maxAttempts },
    { attempt: 1, maxAttempts }
  ], 'the worker fires the poison alert on the last attempt only, so it has to know the count');
});

test('a failing job is rethrown so the queue can retry and poison it', async (t) => {
  const { index } = loadIndex(t, 'BULK_DOWNLOADS_QUEUE', 'bulk-downloads');
  stubWorker(t, async () => { throw new Error('nrs unreachable'); });

  await assert.rejects(index.bulkDownloadWorker('job-44'), /nrs unreachable/,
    'a swallowed failure would report a lost job as a delivered one');
});

test('no BULK_CLEANUP_SCHEDULE registers no timer', (t) => {
  const { registered } = loadIndex(t, 'BULK_CLEANUP_SCHEDULE', undefined);
  assert.deepStrictEqual(registered.timers, []);
});

test('a schedule registers the sweeper against the app setting', (t) => {
  const { registered } = loadIndex(t, 'BULK_CLEANUP_SCHEDULE', '0 0 4 * * *');

  assert.strictEqual(registered.timers.length, 1);
  const [{ name, options }] = registered.timers;

  assert.strictEqual(name, 'cleanupBulkDownloads');
  assert.strictEqual(options.schedule, '%BULK_CLEANUP_SCHEDULE%');
  assert.strictEqual(options.runOnStartup, false,
    'a deploy restarts this app, and a restart is not a reason to sweep');
  assert.strictEqual(typeof options.handler, 'function');
});

test('a failing sweep is logged and does not throw at the host', async (t) => {
  const { index } = loadIndex(t, 'BULK_CLEANUP_SCHEDULE', '0 0 4 * * *');

  const script = require.resolve('../src/scripts/cleanup-bulk-downloads');
  const cached = require.cache[script];
  require.cache[script] = {
    id: script,
    filename: script,
    loaded: true,
    exports: { run: async () => { throw new Error('object store unreachable'); } }
  };
  t.after(() => { require.cache[script] = cached; });

  const errors = [];
  t.mock.method(logger, 'error', (message, meta) => { errors.push({ message, meta }); });

  await index.cleanupBulkDownloads();

  assert.strictEqual(errors.length, 1, 'a sweep that failed has to leave a record somewhere');
  assert.match(errors[0].message, /\[bulk\] cleanup/);
  assert.doesNotMatch(errors[0].message, /\[bulk\] job failed/,
    'the poison alert matches "[bulk] job failed" — a sweep failure must not fire it');
  assert.strictEqual(errors[0].meta.error, 'object store unreachable');
});
