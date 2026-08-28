'use strict';

/**
 * The nightly reconcile is a Functions timer trigger, and nothing about it runs outside Azure —
 * the same blind spot test/functions-adapter.test.js exists for. So `@azure/functions` is replaced
 * in the require cache before `api/index.js` loads, and the assertions are on what the app was
 * asked to register.
 *
 * The guard is the part worth testing. `%RECONCILE_SCHEDULE%` is resolved by the HOST at startup,
 * and an unresolvable name fails startup — taking the HTTP functions down with it. Registering the
 * timer unconditionally would therefore turn a missing app setting into an API outage.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { logger } = require('../src/utils/logger');

const INDEX = require.resolve('../api/index');
const FUNCTIONS = require.resolve('@azure/functions');

/** Load api/index.js against a recording `app`, with RECONCILE_SCHEDULE set to `schedule`. */
function loadIndex(t, schedule) {
  const registered = { timers: [], https: [] };
  const cachedFunctions = require.cache[FUNCTIONS];
  const cachedIndex = require.cache[INDEX];
  const cachedSchedule = process.env.RECONCILE_SCHEDULE;
  // The sibling team-role timer registers off its own app setting, and a value left in the
  // environment would land in `registered.timers` and break every count below.
  const cachedTeams = process.env.SYNC_TEAMS_SCHEDULE;
  delete process.env.SYNC_TEAMS_SCHEDULE;

  require.cache[FUNCTIONS] = {
    id: FUNCTIONS,
    filename: FUNCTIONS,
    loaded: true,
    exports: {
      app: {
        timer: (name, options) => registered.timers.push({ name, options }),
        http: (name, options) => registered.https.push({ name, options }),
        hook: { appTerminate: () => {} }
      }
    }
  };
  delete require.cache[INDEX];
  if (schedule === undefined) delete process.env.RECONCILE_SCHEDULE;
  else process.env.RECONCILE_SCHEDULE = schedule;

  t.after(() => {
    require.cache[FUNCTIONS] = cachedFunctions;
    require.cache[INDEX] = cachedIndex;
    if (cachedSchedule === undefined) delete process.env.RECONCILE_SCHEDULE;
    else process.env.RECONCILE_SCHEDULE = cachedSchedule;
    if (cachedTeams === undefined) delete process.env.SYNC_TEAMS_SCHEDULE;
    else process.env.SYNC_TEAMS_SCHEDULE = cachedTeams;
  });

  return { registered, index: require('../api/index') };
}

test('no RECONCILE_SCHEDULE registers no timer, and leaves the API registered', (t) => {
  const { registered } = loadIndex(t, undefined);

  assert.deepStrictEqual(registered.timers, [],
    'an app setting the environment never set must not become a startup failure');
  assert.strictEqual(registered.https.length, 2,
    'and the guard must not take the HTTP functions with it — both routes still register');
});

test('an empty RECONCILE_SCHEDULE is off too', (t) => {
  const { registered } = loadIndex(t, '');
  assert.deepStrictEqual(registered.timers, [],
    'the setting is declared empty in every environment that has not opted in — the whole ' +
    'appSettings collection is a PUT, so absent is not an option');
});

test('a schedule registers the timer against the app setting, not its value', (t) => {
  const { registered } = loadIndex(t, '0 0 9 * * *');

  assert.strictEqual(registered.timers.length, 1);
  const [{ name, options }] = registered.timers;

  assert.strictEqual(name, 'reconcileEagle');
  assert.strictEqual(options.schedule, '%RECONCILE_SCHEDULE%',
    'the binding names the setting so the host re-reads it — inlining the value here would make ' +
    'a schedule change a code deploy');
  assert.strictEqual(options.runOnStartup, false,
    'a deploy restarts this app, and a restart is not a reason to re-read the Eagle corpus');
  assert.strictEqual(typeof options.handler, 'function');
});

test('the handler runs the reconcile', async (t) => {
  const { index } = loadIndex(t, '0 0 9 * * *');

  const script = require.resolve('../src/scripts/reconcile-eagle');
  const cached = require.cache[script];
  let ran = 0;
  require.cache[script] = {
    id: script,
    filename: script,
    loaded: true,
    exports: { run: async () => { ran++; return { drift: 0 }; } }
  };
  t.after(() => { require.cache[script] = cached; });

  await index.reconcileEagle();
  assert.strictEqual(ran, 1, 'the timer must call run(), which is what logs the alert line');
});

test('a failing reconcile is logged and does not throw at the host', async (t) => {
  const { index } = loadIndex(t, '0 0 9 * * *');

  const script = require.resolve('../src/scripts/reconcile-eagle');
  const cached = require.cache[script];
  require.cache[script] = {
    id: script,
    filename: script,
    loaded: true,
    exports: { run: async () => { throw new Error('eagle-api unreachable'); } }
  };
  t.after(() => { require.cache[script] = cached; });

  const errors = [];
  t.mock.method(logger, 'error', (message, meta) => { errors.push({ message, meta }); });

  await index.reconcileEagle();

  assert.strictEqual(errors.length, 1, 'a night that failed has to leave a record somewhere');
  assert.match(errors[0].message, /\[reconcile\]/);
  assert.strictEqual(errors[0].meta.error, 'eagle-api unreachable');
  assert.ok(errors[0].meta.stack, 'without the stack the record says only that something failed');
});
