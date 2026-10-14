'use strict';

/** intakeScanSweep: pending rows past the timeout are rejected, with or without an upload. */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { sweep } = require('../../src/intake/sweep');
const { setIntakeEnv, fakeStore, fakeAccount, recordLogs } = require('./fakes');

const NOW = Date.parse('2026-10-14T18:00:00Z');
const HOUR = 60 * 60 * 1000;
const ago = ms => new Date(NOW - ms).toISOString();
const BLOB = { bytes: Buffer.from('never scanned'), etag: '"0x1"' };

function row(id, createdAt, extra = {}) {
  return { id, projectId: 'proj-1', scanStatus: 'pending', read: [], createdAt, ...extra };
}

function setup(t, rows, incoming, env) {
  setIntakeEnv(t, env);
  const store = fakeStore(rows);
  const account = fakeAccount(incoming);
  const logs = recordLogs(t);
  return { store, account, logs, deps: { store, blobs: account.blobs } };
}

test('a pending upload just past 6 hours is quarantined and rejected as timeout', async (t) => {
  const { store, account, deps } = setup(t, [row('old', ago(6 * HOUR + 60000))], { old: BLOB });

  await sweep(deps, NOW);

  const settled = store.rows.get('old');
  assert.strictEqual(settled.scanStatus, 'rejected');
  assert.strictEqual(settled.scanRejectReason, 'timeout');
  assert.deepStrictEqual(settled.read, []);
  assert.deepStrictEqual(account.containers.quarantine.get('old'), BLOB);
  assert.strictEqual(account.containers.incoming.has('old'), false);
});

test('a pending upload just short of 6 hours is left alone', async (t) => {
  const { store, account, deps } = setup(t, [row('fresh', ago(6 * HOUR - 60000))], { fresh: BLOB });

  await sweep(deps, NOW);

  assert.strictEqual(store.rows.get('fresh').scanStatus, 'pending');
  assert.ok(account.containers.incoming.has('fresh'));
});

test('INTAKE_PENDING_TIMEOUT_HOURS moves the cutoff', async (t) => {
  const env = { INTAKE_STORAGE_ACCOUNT: 'demiintest', INTAKE_PENDING_TIMEOUT_HOURS: '2' };
  const { store, deps } = setup(t, [row('three', ago(3 * HOUR))], { three: BLOB }, env);

  await sweep(deps, NOW);

  assert.strictEqual(store.rows.get('three').scanRejectReason, 'timeout');
});

test('a pending row with no blob is rejected as no-upload', async (t) => {
  const { store, account, deps } = setup(t, [row('unused', ago(7 * HOUR))], {});

  await sweep(deps, NOW);

  assert.strictEqual(store.rows.get('unused').scanStatus, 'rejected');
  assert.strictEqual(store.rows.get('unused').scanRejectReason, 'no-upload');
  assert.strictEqual(account.containers.quarantine.size, 0);
});

test('a settled row is not swept', async (t) => {
  const clean = row('clean', ago(9 * HOUR), { scanStatus: 'clean', read: ['public'] });
  const { store, deps } = setup(t, [clean], {});

  await sweep(deps, NOW);

  assert.strictEqual(store.rows.get('clean').scanStatus, 'clean');
});

test('one row failing does not stop the rest, and the summary counts it', async (t) => {
  const { store, account, logs, deps } = setup(t,
    [row('broken', ago(8 * HOUR)), row('unused', ago(8 * HOUR))], { broken: BLOB });
  const quarantine = account.blobs.quarantine();
  const copy = quarantine.copyObject;
  quarantine.copyObject = async (src, ...rest) => {
    if (src === 'broken') throw new Error('copy refused');
    return copy(src, ...rest);
  };

  await sweep(deps, NOW);

  assert.strictEqual(store.rows.get('broken').scanStatus, 'pending');
  assert.strictEqual(store.rows.get('unused').scanRejectReason, 'no-upload');
  assert.strictEqual(logs.error.length, 1);
  assert.strictEqual(logs.info.find(l => l.message === 'intake sweep').meta.failed, 1);
});

test('the sweep logs one summary line', async (t) => {
  const rows = [row('old', ago(7 * HOUR)), row('unused', ago(7 * HOUR)), row('fresh', ago(HOUR))];
  const { logs, deps } = setup(t, rows, { old: BLOB, fresh: BLOB });

  await sweep(deps, NOW);

  const summaries = logs.info.filter(l => l.message === 'intake sweep');
  assert.strictEqual(summaries.length, 1);
  assert.deepStrictEqual(
    { stale: summaries[0].meta.stale, timedOut: summaries[0].meta.timedOut,
      noUpload: summaries[0].meta.noUpload, failed: summaries[0].meta.failed },
    { stale: 2, timedOut: 1, noUpload: 1, failed: 0 });
});

const monthLines = logs => logs.info.filter(l => l.message.startsWith('[intake] month-to-date'));

test('the sweep logs this UTC month\'s scanned bytes against the cap, as plain text', async (t) => {
  const scanned = (id, scannedAt, scanSizeBytes) =>
    row(id, ago(30 * 24 * HOUR), { scanStatus: 'clean', scannedAt, scanSizeBytes });
  const rows = [
    scanned('lastMonth', '2026-09-30T23:59:59.9999999Z', 1000),
    scanned('firstInstant', '2026-10-01T00:00:00.0000000Z', 100),
    scanned('today', '2026-10-14T17:00:00.0000000Z', 200),
    scanned('noSize', '2026-10-14T17:30:00.0000000Z', null),
    scanned('nextMonth', '2026-11-01T00:00:00.0000000Z', 5000)
  ];
  const env = { INTAKE_STORAGE_ACCOUNT: 'demiintest', INTAKE_CAP_GB_PER_MONTH: '25' };
  const { logs, deps } = setup(t, rows, {}, env);

  await sweep(deps, NOW);

  assert.deepStrictEqual(monthLines(logs).map(l => l.message),
    ['[intake] month-to-date scannedBytes=300 capBytes=26843545600']);
});

test('the month line is logged when nothing is pending, with capBytes=0 when no cap is set', async (t) => {
  const { logs, deps } = setup(t, [], {});

  await sweep(deps, NOW);

  assert.deepStrictEqual(monthLines(logs).map(l => l.message),
    ['[intake] month-to-date scannedBytes=0 capBytes=0']);
});

test('with INTAKE_STORAGE_ACCOUNT empty the sweep logs one line and touches nothing', async (t) => {
  setIntakeEnv(t, {});
  const logs = recordLogs(t);
  const untouchable = new Proxy({}, { get() { throw new Error('dependency used while disabled'); } });

  const summary = await sweep({ store: untouchable, blobs: untouchable }, NOW);

  assert.strictEqual(summary, null);
  assert.strictEqual(logs.all().length, 1);
  assert.match(logs.info[0].message, /INTAKE_STORAGE_ACCOUNT is unset/);
});
