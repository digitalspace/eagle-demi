'use strict';

/**
 * applyScanResult: one scan result moves an upload to the object store or to quarantine, and settles
 * its documents row once.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { applyScanResult } = require('../../src/intake/handler');
const { readForLevel, systemAccess } = require('../../src/helpers/access-sql');
const { setIntakeEnv, fakeStore, fakeAccount, fakeNrs, recordLogs } = require('./fakes');

const DOC = '6f1c2a9e-0b4d-4c55-9a51-3b7e2f8d9c10';
const BYTES = Buffer.from('%PDF-1.7 intake test');
const ETAG = '"0x8DCB0000000001"';

function pendingRow(extra = {}) {
  return { id: DOC, projectId: 'proj-1', scanStatus: 'pending', read: [], fileExt: 'pdf', ...extra };
}

/** A result as the sweep reads it from the blob's tags, for the blob the setup seeds. */
function scan(result, extra = {}) {
  return { result, scannedAt: '2026-10-14T18:00:00.000Z', eTag: ETAG, malwareNames: [], ...extra };
}

/** The project rows a system read answers; `proj-1` is public unless a test says otherwise. */
function fakeProjects(rows = { 'proj-1': { id: 'proj-1', read: readForLevel(4) } }) {
  return {
    getById: async (access, id) => {
      assert.deepStrictEqual(access, systemAccess());
      return rows[id] || null;
    }
  };
}

/** Intake configured, one pending row, its upload in `incoming`. */
function setup(t, row = pendingRow(), projects = fakeProjects()) {
  setIntakeEnv(t);
  const store = fakeStore([row]);
  const account = fakeAccount({ [DOC]: { bytes: BYTES, etag: ETAG, contentType: 'application/pdf' } });
  const nrs = fakeNrs();
  const logs = recordLogs(t);
  return { store, account, nrs, logs, deps: { store, blobs: account.blobs, nrs, projects } };
}

/** Apply `result` to the row as the store holds it now. */
const apply = (result, deps) => applyScanResult({ ...deps.store.rows.get(DOC) }, scan(result), deps);

const scannedLines = logs => logs.info.filter(l => l.message === 'intake scanned');

test('No threats found: the file goes to the object store under <project>/<hex>.<ext>', async (t) => {
  const { nrs, deps } = setup(t);

  await apply('No threats found', deps);

  const stored = nrs.objects.get('proj-1/6f1c2a9e0b4d4c559a513b7e2f8d9c10.pdf');
  assert.ok(stored, 'object written under the derived key');
  assert.deepStrictEqual(stored.bytes, BYTES);
  assert.strictEqual(stored.contentType, 'application/pdf');
});

test('No threats found: the row is clean, keyed, and takes its requested read list', async (t) => {
  const { store, deps } = setup(t, pendingRow({ requestedRead: readForLevel(3) }));

  await apply('No threats found', deps);

  const row = store.rows.get(DOC);
  assert.strictEqual(row.scanStatus, 'clean');
  assert.strictEqual(row.scanResult, 'No threats found');
  assert.strictEqual(row.scannedAt, '2026-10-14T18:00:00.000Z');
  assert.strictEqual(row.s3Key, 'proj-1/6f1c2a9e0b4d4c559a513b7e2f8d9c10.pdf');
  assert.deepStrictEqual(row.read, readForLevel(3));
  assert.strictEqual(row.isPublished, false);
});

test('No threats found publishes a public request under a public project', async (t) => {
  const { store, deps } = setup(t, pendingRow({ requestedRead: readForLevel(4) }));

  await apply('No threats found', deps);

  const row = store.rows.get(DOC);
  assert.strictEqual(row.scanStatus, 'clean');
  assert.deepStrictEqual(row.read, readForLevel(4));
  assert.ok(row.read.includes('public'));
  assert.strictEqual(row.isPublished, true);
});

test('No threats found caps the requested read list at the project as it is now', async (t) => {
  // Linked at staff while the project was staff; the project narrowed to team before the scan.
  const narrowed = fakeProjects({ 'proj-1': { id: 'proj-1', read: readForLevel(1) } });
  const { store, deps } = setup(t, pendingRow({ requestedRead: readForLevel(3) }), narrowed);

  await apply('No threats found', deps);

  const row = store.rows.get(DOC);
  assert.strictEqual(row.scanStatus, 'clean');
  assert.deepStrictEqual(row.read, readForLevel(1));
  assert.strictEqual(row.isPublished, false);
});

test('No threats found for a project that is gone releases with an empty read list', async (t) => {
  const { store, logs, deps } = setup(t, pendingRow({ requestedRead: ['public'] }), fakeProjects({}));

  await apply('No threats found', deps);

  const row = store.rows.get(DOC);
  assert.strictEqual(row.scanStatus, 'clean');
  assert.deepStrictEqual(row.read, []);
  assert.strictEqual(row.isPublished, false);
  const gone = logs.warn.filter(l => l.message === '[intake] project not found, released with an empty read list');
  assert.strictEqual(gone.length, 1);
  assert.strictEqual(gone[0].meta.projectId, 'proj-1');
});

test('No threats found keeps a sealed request sealed when the system read cannot see the project', async (t) => {
  const { store, deps } = setup(t, pendingRow({ requestedRead: readForLevel(0) }), fakeProjects({}));

  await apply('No threats found', deps);

  assert.deepStrictEqual(store.rows.get(DOC).read, readForLevel(0));
});

test('No threats found stores the scanned size on the row', async (t) => {
  const { store, deps } = setup(t);

  await apply('No threats found', deps);

  assert.strictEqual(store.rows.get(DOC).scanSizeBytes, BYTES.length);
});

test('Malicious stores the scanned size on the row', async (t) => {
  const { store, deps } = setup(t);

  await apply('Malicious', deps);

  assert.strictEqual(store.rows.get(DOC).scanSizeBytes, BYTES.length);
});

test('No threats found with no requested read list leaves read as it was', async (t) => {
  const { store, deps } = setup(t);

  await apply('No threats found', deps);

  assert.deepStrictEqual(store.rows.get(DOC).read, []);
});

test('No threats found keeps a key the row already carries', async (t) => {
  const { nrs, deps } = setup(t, pendingRow({ s3Key: 'proj-1/preset.pdf' }));

  await apply('No threats found', deps);

  assert.ok(nrs.objects.has('proj-1/preset.pdf'));
});

test('No threats found deletes the staging blob', async (t) => {
  const { account, deps } = setup(t);

  await apply('No threats found', deps);

  assert.strictEqual(account.containers.incoming.has(DOC), false);
  assert.strictEqual(account.containers.quarantine.size, 0);
});

test('a clean result for an overwritten upload releases nothing', async (t) => {
  const { store, nrs, account, deps } = setup(t);

  await applyScanResult(store.rows.get(DOC), scan('No threats found', { eTag: '0x8DCB0000000099' }), deps);

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

    await apply(result, deps);

    assert.deepStrictEqual(account.containers.quarantine.get(DOC).bytes, BYTES);
    assert.strictEqual(account.containers.incoming.has(DOC), false);
    assert.strictEqual(nrs.objects.size, 0);
  });

  test(`${result}: the row is rejected (${reason}) with an empty read list`, async (t) => {
    const { store, deps } = setup(t, pendingRow({ requestedRead: ['public'] }));

    await apply(result, deps);

    const row = store.rows.get(DOC);
    assert.strictEqual(row.scanStatus, 'rejected');
    assert.strictEqual(row.scanResult, result);
    assert.strictEqual(row.scanRejectReason, reason);
    assert.deepStrictEqual(row.read, []);
    assert.strictEqual(row.isPublished, false);
  });
}

test('Malicious records an empty malware name list and logs intake quarantined', async (t) => {
  const { store, logs, deps } = setup(t);

  await apply('Malicious', deps);

  assert.deepStrictEqual(store.rows.get(DOC).malwareNames, []);
  const quarantined = logs.warn.filter(l => l.message === 'intake quarantined');
  assert.strictEqual(quarantined.length, 1);
  assert.strictEqual(quarantined[0].meta.documentId, DOC);
});

test('a result the table does not know rejects the file', async (t) => {
  const { store, deps } = setup(t);

  await apply('Something new', deps);

  assert.strictEqual(store.rows.get(DOC).scanStatus, 'rejected');
  assert.strictEqual(store.rows.get(DOC).scanRejectReason, 'unknown-result');
});

test('intake scanned carries the blob size and a duration', async (t) => {
  const { logs, deps } = setup(t);

  await apply('No threats found', deps);

  const lines = scannedLines(logs);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].meta.documentId, DOC);
  assert.strictEqual(lines[0].meta.result, 'No threats found');
  assert.strictEqual(lines[0].meta.sizeBytes, BYTES.length);
  assert.strictEqual(typeof lines[0].meta.durationMs, 'number');
});

test('intake scanned carries the size of a quarantined file too', async (t) => {
  const { logs, deps } = setup(t);

  await apply('Malicious', deps);

  assert.strictEqual(scannedLines(logs)[0].meta.sizeBytes, BYTES.length);
});
