'use strict';

/**
 * The team-role sync is a Functions timer trigger, and nothing about it runs outside Azure — so
 * `@azure/functions` is replaced in the require cache before `api/index.js` loads, and the
 * assertions are on what the app was asked to register. Same shape as
 * test/reconcile-timer.test.js, and for the same reason.
 *
 * The guard is the part worth testing. `%SYNC_TEAMS_SCHEDULE%` is resolved by the HOST at startup,
 * and an unresolvable name fails startup — taking the HTTP functions down with it. The setting is
 * empty in every environment whose realm does not yet hold the two clients this sync authenticates
 * as, so "off" is the normal case, not the exceptional one.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { logger } = require('../src/utils/logger');

const INDEX = require.resolve('../api/index');
const FUNCTIONS = require.resolve('@azure/functions');

/** Load api/index.js against a recording `app`, with SYNC_TEAMS_SCHEDULE set to `schedule`. */
function loadIndex(t, schedule) {
  const registered = { timers: [], https: [] };
  const cachedFunctions = require.cache[FUNCTIONS];
  const cachedIndex = require.cache[INDEX];
  const cachedSchedule = process.env.SYNC_TEAMS_SCHEDULE;
  // The sibling reconcile timer registers off its own app setting; left set, it would land in
  // `registered.timers` and break every count below.
  const cachedReconcile = process.env.RECONCILE_SCHEDULE;
  delete process.env.RECONCILE_SCHEDULE;

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
  if (schedule === undefined) delete process.env.SYNC_TEAMS_SCHEDULE;
  else process.env.SYNC_TEAMS_SCHEDULE = schedule;

  t.after(() => {
    require.cache[FUNCTIONS] = cachedFunctions;
    require.cache[INDEX] = cachedIndex;
    if (cachedSchedule === undefined) delete process.env.SYNC_TEAMS_SCHEDULE;
    else process.env.SYNC_TEAMS_SCHEDULE = cachedSchedule;
    if (cachedReconcile === undefined) delete process.env.RECONCILE_SCHEDULE;
    else process.env.RECONCILE_SCHEDULE = cachedReconcile;
  });

  return { registered, index: require('../api/index') };
}

test('no SYNC_TEAMS_SCHEDULE registers no timer, and leaves the API registered', (t) => {
  const { registered } = loadIndex(t, undefined);

  assert.deepStrictEqual(registered.timers, [],
    'an app setting the environment never set must not become a startup failure');
  assert.strictEqual(registered.https.length, 2,
    'and the guard must not take the HTTP functions with it — both routes still register');
});

test('an empty SYNC_TEAMS_SCHEDULE is off too', (t) => {
  const { registered } = loadIndex(t, '');
  assert.deepStrictEqual(registered.timers, [],
    'the setting is declared empty in every environment that has not opted in — the whole ' +
    'appSettings collection is a PUT, so absent is not an option');
});

test('a schedule registers the timer against the app setting, not its value', (t) => {
  const { registered } = loadIndex(t, '0 0 10 * * *');

  assert.strictEqual(registered.timers.length, 1);
  const [{ name, options }] = registered.timers;

  assert.strictEqual(name, 'syncTrackTeams');
  assert.strictEqual(options.schedule, '%SYNC_TEAMS_SCHEDULE%',
    'the binding names the setting so the host re-reads it — inlining the value here would make ' +
    'a schedule change a code deploy');
  assert.strictEqual(options.runOnStartup, false,
    'a deploy restarts this app, and a restart is not a reason to rewrite every role mapping');
  assert.strictEqual(typeof options.handler, 'function');
});

test('the handler runs the sync live', async (t) => {
  const { index } = loadIndex(t, '0 0 10 * * *');

  const script = require.resolve('../src/scripts/sync-track-teams');
  const cached = require.cache[script];
  const calls = [];
  require.cache[script] = {
    id: script,
    filename: script,
    loaded: true,
    exports: { run: async (opts) => { calls.push(opts); return { failures: 0 }; } }
  };
  t.after(() => { require.cache[script] = cached; });

  await index.syncTrackTeams();
  assert.deepStrictEqual(calls, [{ live: true }],
    'a scheduled dry run would report a plan nothing ever applies');
});

test('a failing sync is logged and does not throw at the host', async (t) => {
  const { index } = loadIndex(t, '0 0 10 * * *');

  const script = require.resolve('../src/scripts/sync-track-teams');
  const cached = require.cache[script];
  require.cache[script] = {
    id: script,
    filename: script,
    loaded: true,
    exports: { run: async () => { throw new Error('keycloak unreachable'); } }
  };
  t.after(() => { require.cache[script] = cached; });

  const errors = [];
  t.mock.method(logger, 'error', (message, meta) => { errors.push({ message, meta }); });

  await index.syncTrackTeams();

  assert.strictEqual(errors.length, 1, 'a night that failed has to leave a record somewhere');
  assert.match(errors[0].message, /\[track-teams\]/);
  assert.strictEqual(errors[0].meta.error, 'keycloak unreachable');
  assert.ok(errors[0].meta.stack, 'without the stack the record says only that something failed');
});
