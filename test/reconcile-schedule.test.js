'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { msUntilHour, startReconcileSchedule } = require('../src/reconcile-schedule');
const { logger } = require('../src/utils/logger');

const HOUR = 3600 * 1000;

// The timer is set once at boot and the process outlives the day, so getting this wrong is not a
// run at the wrong minute — it is a negative delay (fires instantly, then every tick forever) or a
// run 24 hours late. Neither shows up until the app has been up for a day.
test('the delay is to the next occurrence of the hour, today or tomorrow', () => {
  const at = (iso) => new Date(iso);

  assert.strictEqual(msUntilHour(9, at('2026-08-26T00:00:00Z')), 9 * HOUR,
    'same day, hour still ahead');
  assert.strictEqual(msUntilHour(9, at('2026-08-26T08:30:00Z')), 0.5 * HOUR,
    'half an hour before it');
  assert.strictEqual(msUntilHour(9, at('2026-08-26T09:00:00Z')), 24 * HOUR,
    'exactly on the hour is the run that just happened — the next one is tomorrow, not now');
  assert.strictEqual(msUntilHour(9, at('2026-08-26T09:00:01Z')), 24 * HOUR - 1000,
    'a second past it rolls over');
  assert.strictEqual(msUntilHour(0, at('2026-08-26T23:59:00Z')), 60 * 1000,
    'midnight, one minute out — the case a naive same-day delay gets negative');
  // Month and year boundaries are the same arithmetic, and setUTCDate handles both — asserted so a
  // hand-rolled `+ 86400000` replacement is caught rather than assumed equivalent.
  assert.strictEqual(msUntilHour(2, at('2026-12-31T23:00:00Z')), 3 * HOUR,
    'across a year boundary');
});

test('no RECONCILE_HOUR_UTC schedules nothing at all', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-08-26T00:00:00Z') });
  let calls = 0;
  const job = () => { calls++; };

  assert.strictEqual(startReconcileSchedule(job, undefined), false, 'absent is off');
  assert.strictEqual(startReconcileSchedule(job, ''), false,
    "empty is off too — an app setting declared and left blank is how every environment that has " +
    'not opted in arrives here, and Number("") is 0, a perfectly valid hour');

  t.mock.timers.tick(48 * HOUR);
  assert.strictEqual(calls, 0, 'two days passed and nothing ran');
});

test('an hour outside 0-23 is refused rather than rounded into one', (t) => {
  const warnings = [];
  t.mock.method(logger, 'warn', (message) => { warnings.push(message); });

  for (const bad of ['24', '-1', '9.5', 'nightly']) {
    assert.strictEqual(startReconcileSchedule(() => {}, bad), false, `${bad} must not schedule`);
  }
  assert.strictEqual(warnings.length, 4, 'and each one says so — a silent off looks like a bug');
});

test('a failing run is logged and the schedule survives it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-08-26T00:00:00Z') });
  const errors = [];
  t.mock.method(logger, 'error', (message) => { errors.push(message); });
  t.mock.method(logger, 'info', () => {});

  let calls = 0;
  const job = async () => { calls++; throw new Error('eagle-api unreachable'); };

  assert.strictEqual(startReconcileSchedule(job, '09'), true);

  // The await inside the timer callback settles on the microtask queue, which tick() does not
  // drain — setImmediate is not mocked, so this yields until it has.
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  t.mock.timers.tick(9 * HOUR);
  await settle();
  assert.strictEqual(calls, 1, 'first run fired at 09:00');

  t.mock.timers.tick(24 * HOUR);
  await settle();
  assert.strictEqual(calls, 2,
    'the failure must not end the schedule — an alert on drift is worthless if one bad night ' +
    'stops the job that writes the line it reads');
  assert.strictEqual(errors.length, 2, 'and both failures were logged');
});

test('a run reschedules for the same hour the next day', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-08-26T12:00:00Z') });
  t.mock.method(logger, 'info', () => {});

  const ranAt = [];
  const job = async () => { ranAt.push(new Date().toISOString()); };
  startReconcileSchedule(job, '09');

  // tick() advances the mocked clock by the full amount and then runs whatever came due, so the
  // ticks below land exactly on 09:00 and the timestamps are the real thing rather than an
  // artefact of over-ticking.
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  t.mock.timers.tick(20 * HOUR);
  await settle();
  assert.deepStrictEqual(ranAt, [], 'nothing runs before the hour arrives');

  for (const step of [1 * HOUR, 24 * HOUR, 24 * HOUR]) {
    t.mock.timers.tick(step);
    await settle();
  }

  assert.deepStrictEqual(ranAt, [
    '2026-08-27T09:00:00.000Z',
    '2026-08-28T09:00:00.000Z',
    '2026-08-29T09:00:00.000Z'
  ], 'one run a night at the configured hour, never sliding off it');
});
