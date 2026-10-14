'use strict';

/**
 * intakeScanResult: one Defender scan result moves an upload to the object store or to quarantine,
 * and settles its documents row exactly once.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { onScanResult, SCAN_EVENT } = require('../../src/intake/handler');
const { ACCOUNT, setIntakeEnv, fakeStore, fakeAccount, fakeNrs, recordLogs } = require('./fakes');

const DOC = '6f1c2a9e-0b4d-4c55-9a51-3b7e2f8d9c10';
const BYTES = Buffer.from('%PDF-1.7 intake test');
const ETAG = '"0x8DCB0000000001"';

function pendingRow(extra = {}) {
  return { id: DOC, projectId: 'proj-1', scanStatus: 'pending', read: [], fileExt: 'pdf', ...extra };
}

function scanEvent(result, data = {}) {
  return {
    eventType: SCAN_EVENT,
    data: {
      blobUri: `https://${ACCOUNT}.blob.core.windows.net/incoming/${DOC}`,
      eTag: '0x8DCB0000000001',
      scanFinishedTimeUtc: '2026-10-14T18:00:00.0000000Z',
      scanResultType: result,
      scanResultDetails: { malwareNamesFound: result === 'Malicious' ? ['DOS/EICAR_Test_File'] : [] },
      ...data
    }
  };
}

/** Intake configured, one pending row, its upload in `incoming`. */
function setup(t, row = pendingRow()) {
  setIntakeEnv(t);
  const store = fakeStore([row]);
  const account = fakeAccount({ [DOC]: { bytes: BYTES, etag: ETAG, contentType: 'application/pdf' } });
  const nrs = fakeNrs();
  const logs = recordLogs(t);
  return { store, account, nrs, logs, deps: { store, blobs: account.blobs, nrs } };
}

const scannedLines = logs => logs.info.filter(l => l.message === 'intake scanned');

test('No threats found: the file goes to the object store under <project>/<hex>.<ext>', async (t) => {
  const { nrs, deps } = setup(t);

  await onScanResult(scanEvent('No threats found'), deps);

  const stored = nrs.objects.get('proj-1/6f1c2a9e0b4d4c559a513b7e2f8d9c10.pdf');
  assert.ok(stored, 'object written under the derived key');
  assert.deepStrictEqual(stored.bytes, BYTES);
  assert.strictEqual(stored.contentType, 'application/pdf');
});

test('No threats found: the row is clean, keyed, and takes its requested read list', async (t) => {
  const { store, deps } = setup(t, pendingRow({ requestedRead: ['eao', 'public'] }));

  await onScanResult(scanEvent('No threats found'), deps);

  const row = store.rows.get(DOC);
  assert.strictEqual(row.scanStatus, 'clean');
  assert.strictEqual(row.scanResult, 'No threats found');
  assert.strictEqual(row.scannedAt, '2026-10-14T18:00:00.0000000Z');
  assert.strictEqual(row.s3Key, 'proj-1/6f1c2a9e0b4d4c559a513b7e2f8d9c10.pdf');
  assert.deepStrictEqual(row.read, ['eao', 'public']);
  assert.strictEqual(row.isPublished, true);
});

test('No threats found stores the scanned size on the row', async (t) => {
  const { store, deps } = setup(t);

  await onScanResult(scanEvent('No threats found'), deps);

  assert.strictEqual(store.rows.get(DOC).scanSizeBytes, BYTES.length);
});

test('Malicious stores the scanned size on the row', async (t) => {
  const { store, deps } = setup(t);

  await onScanResult(scanEvent('Malicious'), deps);

  assert.strictEqual(store.rows.get(DOC).scanSizeBytes, BYTES.length);
});

test('No threats found with no requested read list leaves read as it was', async (t) => {
  const { store, deps } = setup(t);

  await onScanResult(scanEvent('No threats found'), deps);

  assert.deepStrictEqual(store.rows.get(DOC).read, []);
});

test('No threats found keeps a key the row already carries', async (t) => {
  const { nrs, deps } = setup(t, pendingRow({ s3Key: 'proj-1/preset.pdf' }));

  await onScanResult(scanEvent('No threats found'), deps);

  assert.ok(nrs.objects.has('proj-1/preset.pdf'));
});

test('No threats found deletes the staging blob', async (t) => {
  const { account, deps } = setup(t);

  await onScanResult(scanEvent('No threats found'), deps);

  assert.strictEqual(account.containers.incoming.has(DOC), false);
  assert.strictEqual(account.containers.quarantine.size, 0);
});

test('a clean result for an overwritten upload releases nothing', async (t) => {
  const { store, nrs, account, deps } = setup(t);

  await onScanResult(scanEvent('No threats found', { eTag: '0x8DCB0000000099' }), deps);

  assert.strictEqual(nrs.objects.size, 0);
  assert.strictEqual(store.rows.get(DOC).scanStatus, 'pending');
  assert.ok(account.containers.incoming.has(DOC));
});

const REJECTIONS = [
  ['Malicious', 'malicious'],
  ['Error', 'scan-error'],
  ['Not scanned', 'not-scanned']
];

for (const [result, reason] of REJECTIONS) {
  test(`${result}: the file moves to quarantine and never reaches the object store`, async (t) => {
    const { nrs, account, deps } = setup(t);

    await onScanResult(scanEvent(result), deps);

    assert.deepStrictEqual(account.containers.quarantine.get(DOC).bytes, BYTES);
    assert.strictEqual(account.containers.incoming.has(DOC), false);
    assert.strictEqual(nrs.objects.size, 0);
  });

  test(`${result}: the row is rejected (${reason}) with an empty read list`, async (t) => {
    const { store, deps } = setup(t, pendingRow({ requestedRead: ['public'] }));

    await onScanResult(scanEvent(result), deps);

    const row = store.rows.get(DOC);
    assert.strictEqual(row.scanStatus, 'rejected');
    assert.strictEqual(row.scanResult, result);
    assert.strictEqual(row.scanRejectReason, reason);
    assert.deepStrictEqual(row.read, []);
    assert.strictEqual(row.isPublished, false);
  });
}

test('Malicious records the malware names and logs intake quarantined', async (t) => {
  const { store, logs, deps } = setup(t);

  await onScanResult(scanEvent('Malicious'), deps);

  assert.deepStrictEqual(store.rows.get(DOC).malwareNames, ['DOS/EICAR_Test_File']);
  const quarantined = logs.warn.filter(l => l.message === 'intake quarantined');
  assert.strictEqual(quarantined.length, 1);
  assert.strictEqual(quarantined[0].meta.documentId, DOC);
});

test('a result the table does not know rejects the file', async (t) => {
  const { store, deps } = setup(t);

  await onScanResult(scanEvent('Something new'), deps);

  assert.strictEqual(store.rows.get(DOC).scanStatus, 'rejected');
  assert.strictEqual(store.rows.get(DOC).scanRejectReason, 'unknown-result');
});

test('intake scanned carries the blob size and a duration', async (t) => {
  const { logs, deps } = setup(t);

  await onScanResult(scanEvent('No threats found'), deps);

  const lines = scannedLines(logs);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].meta.documentId, DOC);
  assert.strictEqual(lines[0].meta.result, 'No threats found');
  assert.strictEqual(lines[0].meta.sizeBytes, BYTES.length);
  assert.strictEqual(typeof lines[0].meta.durationMs, 'number');
});

test('intake scanned carries the size of a quarantined file too', async (t) => {
  const { logs, deps } = setup(t);

  await onScanResult(scanEvent('Malicious'), deps);

  assert.strictEqual(scannedLines(logs)[0].meta.sizeBytes, BYTES.length);
});

test('a repeated event changes nothing and logs once', async (t) => {
  const { store, nrs, logs, deps } = setup(t, pendingRow({ requestedRead: ['public'] }));
  await onScanResult(scanEvent('No threats found'), deps);
  const settled = { ...store.rows.get(DOC) };

  await onScanResult(scanEvent('Malicious'), deps);

  assert.deepStrictEqual(store.rows.get(DOC), settled);
  assert.strictEqual(nrs.objects.size, 1);
  assert.strictEqual(scannedLines(logs).length, 1);
  assert.strictEqual(logs.info.filter(l => l.message === 'intake result already applied').length, 1);
});

test('a late event for a row the sweep rejected is ignored and logged', async (t) => {
  const timedOut = pendingRow({ scanStatus: 'rejected', scanRejectReason: 'timeout' });
  const { store, nrs, logs, deps } = setup(t, timedOut);

  await onScanResult(scanEvent('No threats found'), deps);

  assert.strictEqual(store.rows.get(DOC).scanStatus, 'rejected');
  assert.strictEqual(nrs.objects.size, 0);
  const late = logs.info.filter(l => l.message === 'intake late result ignored');
  assert.strictEqual(late.length, 1);
  assert.strictEqual(late[0].meta.documentId, DOC);
});

test('an unknown document id logs a warning and resolves', async (t) => {
  const { logs, deps } = setup(t);
  const event = scanEvent('No threats found', {
    blobUri: `https://${ACCOUNT}.blob.core.windows.net/incoming/no-such-document`
  });

  await onScanResult(event, deps);

  const warned = logs.warn.filter(l => /unknown intake document/.test(l.message));
  assert.strictEqual(warned.length, 1);
  assert.strictEqual(warned[0].meta.documentId, 'no-such-document');
});

test('a blob in another account is ignored', async (t) => {
  const { store, deps } = setup(t);
  const event = scanEvent('No threats found', {
    blobUri: `https://otheraccount.blob.core.windows.net/incoming/${DOC}`
  });

  await onScanResult(event, deps);

  assert.strictEqual(store.rows.get(DOC).scanStatus, 'pending');
});

test('a blob in another container is ignored', async (t) => {
  const { store, deps } = setup(t);
  const event = scanEvent('Malicious', {
    blobUri: `https://${ACCOUNT}.blob.core.windows.net/quarantine/${DOC}`
  });

  await onScanResult(event, deps);

  assert.strictEqual(store.rows.get(DOC).scanStatus, 'pending');
});

test('with INTAKE_STORAGE_ACCOUNT empty the handler logs one line and touches nothing', async (t) => {
  setIntakeEnv(t, {});
  const logs = recordLogs(t);
  const untouchable = new Proxy({}, { get() { throw new Error('dependency used while disabled'); } });

  await onScanResult(scanEvent('Malicious'), { store: untouchable, blobs: untouchable, nrs: untouchable });

  assert.strictEqual(logs.all().length, 1);
  assert.match(logs.info[0].message, /INTAKE_STORAGE_ACCOUNT is unset/);
});
