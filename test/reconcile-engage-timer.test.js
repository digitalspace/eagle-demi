'use strict';

/**
 * The ENGAGE reconcile timer, registered against a recording `app` — same shape and same reason as
 * test/reconcile-timer.test.js: an unresolvable `%RECONCILE_ENGAGE_SCHEDULE%` fails host startup.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { logger } = require('../src/utils/logger');
const { loadIndex } = require('./helpers/load-index');

/** Replace the script with a recorder; the handler `require`s it lazily. */
function stubScript(t, run) {
  const script = require.resolve('../src/scripts/reconcile-engage');
  const cached = require.cache[script];
  require.cache[script] = { id: script, filename: script, loaded: true, exports: { run } };
  t.after(() => { require.cache[script] = cached; });
}

test('no RECONCILE_ENGAGE_SCHEDULE registers no timer, and leaves the API registered', (t) => {
  const { registered } = loadIndex(t, 'RECONCILE_ENGAGE_SCHEDULE', undefined);

  assert.deepStrictEqual(registered.timers, []);
  assert.strictEqual(registered.https.length, 2);
});

test('a schedule registers the timer against the app setting, not its value', (t) => {
  const { registered } = loadIndex(t, 'RECONCILE_ENGAGE_SCHEDULE', '0 30 10 * * *');

  assert.strictEqual(registered.timers.length, 1);
  const [{ name, options }] = registered.timers;
  assert.strictEqual(name, 'reconcileEngage');
  assert.strictEqual(options.schedule, '%RECONCILE_ENGAGE_SCHEDULE%');
  assert.strictEqual(options.runOnStartup, false);
});

test('the handler runs the reconcile and stores its report, without repair', async (t) => {
  const { index } = loadIndex(t, 'RECONCILE_ENGAGE_SCHEDULE', '0 30 10 * * *');
  const calls = [];
  stubScript(t, async (opts) => { calls.push(opts); });

  await index.reconcileEngage();

  assert.deepStrictEqual(calls, [{ store: true }],
    'GET /admin/reconcile-engage serves the stored report; repair re-sends to Eagle and stays a hand run');
});

test('a failing reconcile is logged and does not throw at the host', async (t) => {
  const { index } = loadIndex(t, 'RECONCILE_ENGAGE_SCHEDULE', '0 30 10 * * *');
  stubScript(t, async () => { throw new Error('eagle-api unreachable'); });
  const errors = [];
  t.mock.method(logger, 'error', (message, meta) => { errors.push({ message, meta }); });

  await index.reconcileEngage();

  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].message, /\[reconcile-engage\]/);
  assert.strictEqual(errors[0].meta.error, 'eagle-api unreachable');
  assert.ok(errors[0].meta.stack);
});
