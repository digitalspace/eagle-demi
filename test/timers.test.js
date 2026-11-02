'use strict';

// An unresolvable `%NAME%` schedule fails host startup and takes the HTTP functions with it, so
// each timer registers only when its app setting is set. edgeBan has its own file.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { logger } = require('../src/utils/logger');
const { loadIndex } = require('./helpers/load-index');

/** Each row: the module the handler requires, and how a stand-in `run` is exported from it. */
const TIMERS = [
  {
    name: 'reconcileEagle',
    setting: 'RECONCILE_SCHEDULE',
    module: '../src/scripts/reconcile-eagle',
    exportsFor: run => ({ run }),
    args: [{ store: true }],
    failure: { message: '[reconcile] nightly run failed', meta: {} }
  },
  {
    name: 'reconcileEngage',
    setting: 'RECONCILE_ENGAGE_SCHEDULE',
    module: '../src/sync-out/kinds',
    exportsFor: run => ({ KINDS: { commentPeriod: { reconcile: run } } }),
    args: [{ store: true }],
    failure: { message: '[reconcile-engage] nightly run failed', meta: { kind: 'commentPeriod' } }
  },
  {
    name: 'syncTrackTeams',
    setting: 'SYNC_TEAMS_SCHEDULE',
    module: '../src/scripts/sync-track-teams',
    exportsFor: run => ({ run }),
    args: [{ live: true }],
    failure: { message: '[track-teams] nightly run failed', meta: {} }
  },
  {
    name: 'syncTrackProjects',
    setting: 'SYNC_PROJECTS_SCHEDULE',
    module: '../src/scripts/sync-track-projects',
    exportsFor: run => ({ run }),
    args: [{ live: true }],
    failure: { message: '[track-projects-poll] run failed', meta: {} }
  },
  {
    name: 'announceUpdates',
    setting: 'ANNOUNCE_UPDATES_SCHEDULE',
    module: '../src/scripts/announce-updates',
    exportsFor: run => ({ run }),
    args: [],
    failure: { message: '[updates] scheduled announce failed', meta: {} }
  }
];

const SCHEDULE = '0 0 9 * * *';

/** Puts `exports` in the require cache in place of `module`, for this test only. */
function stubModule(t, module, exports) {
  const file = require.resolve(module);
  const cached = require.cache[file];
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
  t.after(() => { require.cache[file] = cached; });
}

const pick = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj[k]]));

test('with every schedule unset, no timer registers and both HTTP routes stay', (t) => {
  const { registered } = loadIndex(t);

  assert.deepStrictEqual(registered.timers, []);
  assert.deepStrictEqual(registered.https.map(h => h.name), ['api', 'apiRoot']);
});

for (const row of TIMERS) {
  // Every environment declares the setting, empty until it opts in: appSettings is a PUT.
  test(`${row.name}: an empty ${row.setting} registers no timer`, (t) => {
    const { registered } = loadIndex(t, row.setting, '');

    assert.deepStrictEqual(registered.timers, []);
  });

  test(`${row.name}: a set ${row.setting} binds the setting name, not its value, and skips startup`, (t) => {
    const { registered, index } = loadIndex(t, row.setting, SCHEDULE);

    assert.deepStrictEqual(registered.timers.map(({ name }) => name), [row.name]);
    assert.deepStrictEqual(pick(registered.timers[0].options, ['schedule', 'runOnStartup', 'handler']), {
      schedule: `%${row.setting}%`,
      runOnStartup: false,
      handler: index[row.name]
    });
  });

  test(`${row.name}: the handler runs its job with ${JSON.stringify(row.args)}`, async (t) => {
    const { index } = loadIndex(t, row.setting, SCHEDULE);
    const calls = [];
    stubModule(t, row.module, row.exportsFor(async (...args) => { calls.push(args); }));

    await index[row.name]();

    assert.deepStrictEqual(calls, [row.args]);
  });

  test(`${row.name}: a failing job is logged with its stack and does not reject at the host`, async (t) => {
    const { index } = loadIndex(t, row.setting, SCHEDULE);
    const thrown = new Error('upstream unreachable');
    stubModule(t, row.module, row.exportsFor(async () => { throw thrown; }));
    const errors = [];
    t.mock.method(logger, 'error', (message, meta) => { errors.push({ message, meta }); });

    await assert.doesNotReject(() => index[row.name]());

    const expected = { ...row.failure.meta, error: 'upstream unreachable', stack: thrown.stack };
    assert.deepStrictEqual(errors.map(e => e.message), [row.failure.message]);
    assert.deepStrictEqual(pick(errors[0].meta, Object.keys(expected)), expected);
  });
}

test('reconcileEngage runs every kind\'s reconcile, and one failing kind does not stop the rest', async (t) => {
  const { index } = loadIndex(t, 'RECONCILE_ENGAGE_SCHEDULE', SCHEDULE);
  const calls = [];
  const hook = (name, error) => async (opts) => {
    calls.push([name, opts]);
    if (error) throw error;
  };
  stubModule(t, '../src/sync-out/kinds', {
    KINDS: { first: { reconcile: hook('first', new Error('first down')) }, second: { reconcile: hook('second') } }
  });
  const errors = [];
  t.mock.method(logger, 'error', (message, meta) => { errors.push(meta); });

  await index.reconcileEngage();

  assert.deepStrictEqual(calls, [['first', { store: true }], ['second', { store: true }]]);
  assert.deepStrictEqual(errors.map(e => [e.kind, e.error]), [['first', 'first down']]);
});
