'use strict';

/**
 * The intake functions register only when INTAKE_STORAGE_ACCOUNT is set, so a release that ships
 * before the intake infrastructure exists adds no trigger the host cannot bind.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { loadIndex } = require('../helpers/load-index');
const { ACCOUNT, setIntakeEnv } = require('./fakes');

test('no INTAKE_STORAGE_ACCOUNT registers neither intake function', (t) => {
  setIntakeEnv(t, {});
  const { registered } = loadIndex(t, 'INTAKE_STORAGE_ACCOUNT', undefined);

  assert.deepStrictEqual(registered.eventGrids, []);
  assert.deepStrictEqual(registered.timers, []);
  assert.strictEqual(registered.https.length, 2);
});

test('INTAKE_STORAGE_ACCOUNT registers the scan result trigger', (t) => {
  setIntakeEnv(t, {});
  const { registered, index } = loadIndex(t, 'INTAKE_STORAGE_ACCOUNT', ACCOUNT);

  assert.deepStrictEqual(registered.eventGrids.map(e => e.name), ['intakeScanResult']);
  assert.strictEqual(registered.eventGrids[0].options.handler, index.intakeScanResult);
});

test('INTAKE_STORAGE_ACCOUNT registers the sweep hourly by default, not on startup', (t) => {
  setIntakeEnv(t, {});
  const { registered, index } = loadIndex(t, 'INTAKE_STORAGE_ACCOUNT', ACCOUNT);

  const sweep = registered.timers.find(r => r.name === 'intakeScanSweep');
  assert.strictEqual(sweep.options.schedule, '0 0 * * * *');
  assert.strictEqual(sweep.options.runOnStartup, false);
  assert.strictEqual(sweep.options.handler, index.intakeScanSweep);
});

test('INTAKE_SWEEP_SCHEDULE sets the sweep schedule', (t) => {
  setIntakeEnv(t, { INTAKE_SWEEP_SCHEDULE: '0 */15 * * * *' });
  const { registered } = loadIndex(t, 'INTAKE_STORAGE_ACCOUNT', ACCOUNT);

  assert.strictEqual(registered.timers.find(r => r.name === 'intakeScanSweep').options.schedule,
    '0 */15 * * * *');
});
