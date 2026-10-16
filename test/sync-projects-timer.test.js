'use strict';

/**
 * The projects-only Track poll, loaded against a recording `app` as test/sync-teams-timer.test.js
 * does, and guarded for the same reason: an unresolvable `%SYNC_PROJECTS_SCHEDULE%` fails startup.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { logger } = require('../src/utils/logger');

const { loadIndex } = require('./helpers/load-index');

/** Puts `run` in place of the poll script's own, for this test only. */
function stubPoll(t, run) {
  const script = require.resolve('../src/scripts/sync-track-projects');
  const cached = require.cache[script];
  require.cache[script] = { id: script, filename: script, loaded: true, exports: { run } };
  t.after(() => { require.cache[script] = cached; });
}

test('no SYNC_PROJECTS_SCHEDULE registers no timer, and leaves the API registered', (t) => {
  const { registered } = loadIndex(t, 'SYNC_PROJECTS_SCHEDULE', undefined);

  assert.deepStrictEqual(registered.timers, []);
  assert.strictEqual(registered.https.length, 2, 'the guard must not take the HTTP functions with it');
});

test('an empty SYNC_PROJECTS_SCHEDULE is off too', (t) => {
  const { registered } = loadIndex(t, 'SYNC_PROJECTS_SCHEDULE', '');
  assert.deepStrictEqual(registered.timers, []);
});

test('a schedule registers the poll against the app setting, not its value', (t) => {
  const { registered } = loadIndex(t, 'SYNC_PROJECTS_SCHEDULE', '0 */5 * * * *');

  assert.strictEqual(registered.timers.length, 1);
  const [{ name, options }] = registered.timers;

  assert.strictEqual(name, 'syncTrackProjects');
  assert.strictEqual(options.schedule, '%SYNC_PROJECTS_SCHEDULE%');
  assert.strictEqual(options.runOnStartup, false);
  assert.strictEqual(typeof options.handler, 'function');
});

test('the handler runs the poll live', async (t) => {
  const { index } = loadIndex(t, 'SYNC_PROJECTS_SCHEDULE', '0 */5 * * * *');
  const calls = [];
  stubPoll(t, async (opts) => { calls.push(opts); return { failures: 0 }; });

  await index.syncTrackProjects();
  assert.deepStrictEqual(calls, [{ live: true }]);
});

test('a failing poll is logged and does not throw at the host', async (t) => {
  const { index } = loadIndex(t, 'SYNC_PROJECTS_SCHEDULE', '0 */5 * * * *');
  stubPoll(t, async () => { throw new Error('cosmos unreachable'); });
  const errors = [];
  t.mock.method(logger, 'error', (message, meta) => { errors.push({ message, meta }); });

  await index.syncTrackProjects();

  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].message, /\[track-projects-poll\]/);
  assert.strictEqual(errors[0].meta.error, 'cosmos unreachable');
  assert.ok(errors[0].meta.stack);
});
