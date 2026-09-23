'use strict';

/**
 * The scheduled-Update announce timer. Same guard as the other timers (see reconcile-timer.test.js):
 * `%ANNOUNCE_UPDATES_SCHEDULE%` is resolved by the host, so an unset setting must register nothing.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { loadIndex } = require('./helpers/load-index');

test('no ANNOUNCE_UPDATES_SCHEDULE registers no timer', (t) => {
  const { registered } = loadIndex(t, 'ANNOUNCE_UPDATES_SCHEDULE', undefined);
  assert.deepStrictEqual(registered.timers, []);
});

test('a schedule registers announceUpdates against the app setting', (t) => {
  const { registered } = loadIndex(t, 'ANNOUNCE_UPDATES_SCHEDULE', '0 */5 * * * *');

  assert.strictEqual(registered.timers.length, 1);
  const [{ name, options }] = registered.timers;
  assert.strictEqual(name, 'announceUpdates');
  assert.strictEqual(options.schedule, '%ANNOUNCE_UPDATES_SCHEDULE%');
  assert.strictEqual(options.runOnStartup, false);
});

test('the handler runs the scheduled announce', async (t) => {
  const { index } = loadIndex(t, 'ANNOUNCE_UPDATES_SCHEDULE', '0 */5 * * * *');

  const script = require.resolve('../src/scripts/announce-updates');
  const cached = require.cache[script];
  let ran = 0;
  require.cache[script] = {
    id: script, filename: script, loaded: true, exports: { run: async () => { ran++; } }
  };
  t.after(() => { require.cache[script] = cached; });

  await index.announceUpdates();
  assert.strictEqual(ran, 1);
});

test('a failed run is logged and swallowed, so the host does not retry the tick', async (t) => {
  const { index } = loadIndex(t, 'ANNOUNCE_UPDATES_SCHEDULE', '0 */5 * * * *');
  const { logger } = require('../src/utils/logger');
  const errors = [];
  t.mock.method(logger, 'error', (msg, meta) => { errors.push({ msg, meta }); });

  const script = require.resolve('../src/scripts/announce-updates');
  const cached = require.cache[script];
  require.cache[script] = {
    id: script, filename: script, loaded: true,
    exports: { run: async () => { throw new Error('Cosmos is down'); } }
  };
  t.after(() => { require.cache[script] = cached; });

  await assert.doesNotReject(() => index.announceUpdates());
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].msg, '[updates] scheduled announce failed');
  assert.strictEqual(errors[0].meta.error, 'Cosmos is down');
});
