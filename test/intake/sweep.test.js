'use strict';

/**
 * intakeScanSweep: the result pass applies the scan result each pending upload's tags carry; the
 * timeout pass rejects rows still pending after the timeout, with or without an upload.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { sweep } = require('../../src/intake/sweep');
const { readForLevel } = require('../../src/helpers/access-sql');
const { setIntakeEnv, fakeStore, fakeAccount, fakeNrs, recordLogs } = require('./fakes');

const NOW = Date.parse('2026-10-14T18:00:00Z');
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const ago = ms => new Date(NOW - ms).toISOString();
const BLOB = { bytes: Buffer.from('never scanned'), etag: '"0x1"' };
const UPLOADED = new Date(NOW - 10 * MINUTE);

/** A blob uploaded at UPLOADED and tagged by Defender a minute later, unless `scanTime` says otherwise. */
function tagged(result, { scanTime = new Date(UPLOADED.getTime() + MINUTE).toISOString(),
  resultKey = 'Malware scanning scan result', timeKey = 'Malware scanning scan time' } = {}) {
  return {
    bytes: Buffer.from(`%PDF ${result}`), etag: '"0x2"', contentType: 'application/pdf',
    lastModified: UPLOADED, tags: { [resultKey]: result, [timeKey]: scanTime }
  };
}

function row(id, createdAt, extra = {}) {
  return { id, projectId: 'proj-1', scanStatus: 'pending', read: [], createdAt, ...extra };
}

function setup(t, rows, incoming, env) {
  setIntakeEnv(t, env);
  const store = fakeStore(rows);
  const account = fakeAccount(incoming);
  const nrs = fakeNrs();
  const logs = recordLogs(t);
  const projects = { getById: async (_access, id) => ({ id, read: readForLevel(4) }) };
  return { store, account, nrs, logs, deps: { store, blobs: account.blobs, nrs, projects } };
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

test('the sweep logs one summary line per pass', async (t) => {
  const rows = [row('old', ago(7 * HOUR)), row('unused', ago(7 * HOUR)), row('fresh', ago(HOUR))];
  const { logs, deps } = setup(t, rows, { old: BLOB, fresh: BLOB });

  await sweep(deps, NOW);

  const summaries = logs.info.filter(l => l.message === 'intake sweep');
  assert.strictEqual(summaries.length, 1);
  assert.deepStrictEqual(
    { stale: summaries[0].meta.stale, timedOut: summaries[0].meta.timedOut,
      noUpload: summaries[0].meta.noUpload, failed: summaries[0].meta.failed },
    { stale: 1, timedOut: 1, noUpload: 0, failed: 0 });
  const results = logs.info.filter(l => l.message === 'intake results');
  assert.strictEqual(results.length, 1);
  assert.deepStrictEqual(
    { polled: results[0].meta.polled, awaiting: results[0].meta.awaiting, noUpload: results[0].meta.noUpload },
    { polled: 3, awaiting: 2, noUpload: 1 });
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

// Result pass: rows created 15 minutes ago are inside the upload link window (15 min + 5).

const recent = id => row(id, ago(15 * MINUTE));
const results = logs => logs.info.find(l => l.message === 'intake results').meta;

test('untagged blob stays pending', async (t) => {
  const { store, account, logs, deps } = setup(t, [recent('a')], { a: BLOB });

  await sweep(deps, NOW);

  assert.strictEqual(store.rows.get('a').scanStatus, 'pending');
  assert.ok(account.containers.incoming.has('a'));
  assert.strictEqual(results(logs).awaiting, 1);
});

test('missing blob inside the link window stays pending', async (t) => {
  const { store, logs, deps } = setup(t, [row('a', ago(19 * MINUTE))], {});

  await sweep(deps, NOW);

  assert.strictEqual(store.rows.get('a').scanStatus, 'pending');
  assert.strictEqual(results(logs).notUploaded, 1);
});

test('missing blob past link + 5 min is rejected no-upload in the result pass', async (t) => {
  const { store, logs, deps } = setup(t, [row('a', ago(21 * MINUTE))], {});

  await sweep(deps, NOW);

  assert.strictEqual(store.rows.get('a').scanStatus, 'rejected');
  assert.strictEqual(store.rows.get('a').scanRejectReason, 'no-upload');
  assert.strictEqual(results(logs).noUpload, 1);
  assert.strictEqual(logs.info.find(l => l.message === 'intake sweep').meta.stale, 0);
});

test('"No threats found" releases', async (t) => {
  const blob = tagged('No threats found');
  const { store, account, nrs, deps } = setup(t, [recent('a')], { a: blob });

  await sweep(deps, NOW);

  const settled = store.rows.get('a');
  assert.strictEqual(settled.scanStatus, 'clean');
  assert.strictEqual(settled.scanResult, 'No threats found');
  assert.strictEqual(settled.scannedAt, new Date(NOW).toISOString());
  assert.deepStrictEqual(nrs.objects.get(settled.s3Key).bytes, blob.bytes);
  assert.strictEqual(account.containers.incoming.has('a'), false);
});

test('clean tag with scan time before lastModified stays pending and logs \'scan older than blob\' once', async (t) => {
  // The overwrite case: the tag is for the bytes the client replaced.
  const scanTime = new Date(UPLOADED.getTime() - MINUTE).toISOString();
  const { store, nrs, logs, deps } = setup(t, [recent('a')], { a: tagged('No threats found', { scanTime }) });

  await sweep(deps, NOW);

  assert.strictEqual(store.rows.get('a').scanStatus, 'pending');
  assert.strictEqual(nrs.objects.size, 0);
  const older = logs.warn.filter(l => /scan older than blob/.test(l.message));
  assert.strictEqual(older.length, 1);
  assert.deepStrictEqual([older[0].meta.documentId, older[0].meta.scanTime], ['a', scanTime]);
});

test('unparsable scan time stays pending', async (t) => {
  const blob = tagged('No threats found', { scanTime: 'not a date' });
  const { store, nrs, logs, deps } = setup(t, [recent('a')], { a: blob });

  await sweep(deps, NOW);

  assert.strictEqual(store.rows.get('a').scanStatus, 'pending');
  assert.strictEqual(nrs.objects.size, 0);
  assert.strictEqual(logs.warn.filter(l => /scan time unreadable/.test(l.message)).length, 1);
});

for (const [result, reason] of [
  ['Not scanned - blob size exceeded', 'not-scanned'],
  ['Scan failed - x', 'scan-error']
]) {
  test(`"${result}" rejects ${reason}`, async (t) => {
    const { store, account, nrs, deps } = setup(t, [recent('a')], { a: tagged(result) });

    await sweep(deps, NOW);

    const settled = store.rows.get('a');
    assert.strictEqual(settled.scanStatus, 'rejected');
    assert.strictEqual(settled.scanRejectReason, reason);
    assert.strictEqual(settled.scanResult, result);
    assert.ok(account.containers.quarantine.has('a'));
    assert.strictEqual(nrs.objects.size, 0);
  });
}

test('getTags 403 counts failed, the row stays pending, and the next row still runs', async (t) => {
  const rows = [row('a', ago(16 * MINUTE)), row('b', ago(15 * MINUTE))];
  const { store, account, logs, deps } = setup(t, rows,
    { a: tagged('No threats found'), b: tagged('No threats found') });
  account.denyTags = new Set(['a']);

  await sweep(deps, NOW);

  assert.strictEqual(store.rows.get('a').scanStatus, 'pending');
  assert.strictEqual(store.rows.get('b').scanStatus, 'clean');
  assert.strictEqual(results(logs).failed, 1);
  const errors = logs.error.filter(l => l.meta && l.meta.documentId === 'a');
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].meta.error, /not authorized/);
});

test('a lowercase or uppercase key is read', async (t) => {
  const lower = tagged('No threats found',
    { resultKey: 'malware scanning scan result', timeKey: 'malware scanning scan time' });
  const upper = tagged('Malicious', { resultKey: 'MALWARE SCANNING SCAN RESULT', timeKey: 'MALWARE SCANNING SCAN TIME' });
  const { store, deps } = setup(t, [recent('lower'), recent('upper')], { lower, upper });

  await sweep(deps, NOW);

  assert.strictEqual(store.rows.get('lower').scanStatus, 'clean');
  assert.strictEqual(store.rows.get('upper').scanRejectReason, 'malicious');
});

test('650 pending rows: 500 are polled, and the warning carries rowsLeft', async (t) => {
  const ids = Array.from({ length: 650 }, (_, i) => `r${String(i).padStart(3, '0')}`);
  const rows = ids.map((id, i) => row(id, ago(HOUR - i * 1000)));
  const { store, logs, deps } = setup(t, rows, Object.fromEntries(ids.map(id => [id, BLOB])));
  const pages = t.mock.method(store, 'listPending');

  const summary = await sweep(deps, NOW);

  assert.strictEqual(summary.results.polled, 500);
  assert.strictEqual(pages.mock.callCount(), 5);
  const stopped = logs.warn.filter(l => l.message === '[intake] result pass stopped early');
  assert.strictEqual(stopped.length, 1);
  assert.deepStrictEqual(stopped[0].meta, { reason: 'row cap', polled: 500, rowsLeft: 150 });
});

test('a budget overrun stops the pass, and the timeout pass and month line still log', async (t) => {
  const rows = [row('stale', ago(7 * HOUR)), recent('a'), recent('b')];
  const { store, logs, deps } = setup(t, rows, { stale: BLOB, a: tagged('No threats found'), b: BLOB });
  // Each clock read is 11 minutes on: the first row runs, the second starts past 20 minutes.
  let reads = 0;
  const clock = () => (reads++) * 11 * MINUTE;

  await sweep(deps, NOW, clock);

  const stopped = logs.warn.filter(l => l.message === '[intake] result pass stopped early');
  assert.deepStrictEqual(stopped.map(l => l.meta), [{ reason: 'time budget', polled: 1, rowsLeft: 2 }]);
  assert.strictEqual(store.rows.get('a').scanStatus, 'pending');
  assert.strictEqual(store.rows.get('stale').scanRejectReason, 'timeout');
  assert.strictEqual(logs.info.filter(l => l.message === 'intake sweep').length, 1);
  assert.strictEqual(monthLines(logs).length, 1);
});

test('a throw from listPending still lets the timeout pass and month line run', async (t) => {
  const { store, logs, deps } = setup(t, [row('stale', ago(7 * HOUR))], { stale: BLOB });
  store.listPending = async () => { throw new Error('query rejected'); };

  await sweep(deps, NOW);

  const failed = logs.error.filter(l => l.message === '[intake] result pass failed');
  assert.strictEqual(failed.length, 1);
  assert.strictEqual(failed[0].meta.error, 'query rejected');
  assert.strictEqual(store.rows.get('stale').scanRejectReason, 'timeout');
  assert.strictEqual(monthLines(logs).length, 1);
});
