'use strict';

/**
 * applyScanResult: one scan result moves an upload to the object store or to quarantine, and settles
 * its documents row once.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const { applyScanResult } = require('../../src/intake/handler');
const aiSearch = require('../../src/search/ai-search');
const audit = require('../../src/utils/audit');
const documents = require('../../src/repositories/documents');
const extraction = require('../../src/extraction/enqueue');
const syncOut = require('../../src/sync-out');
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

/** Apply `result` to the row as the pending listing returns it: no source or publish columns. */
function applyListed(result, deps) {
  const { id, projectId, createdAt, requestedRead, s3Key, fileExt } = deps.store.rows.get(DOC);
  return applyScanResult({ id, projectId, createdAt, requestedRead, s3Key, fileExt }, scan(result), deps);
}

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

test('No threats found puts the stored row, not the pending listing, in the documents index', async (t) => {
  const { deps } = setup(t, pendingRow({ requestedRead: readForLevel(3), displayName: 'Survey', createdAt: 'x' }));
  t.mock.method(documents, 'readForWrite', async id => ({ ...deps.store.rows.get(id) }));
  t.mock.method(aiSearch, 'config', () => ({ configured: true }));
  const sent = t.mock.method(aiSearch, 'upsertIndexRows', async (_index, rows) => rows.length);

  await applyListed('No threats found', deps);

  assert.deepStrictEqual(sent.mock.calls.map(c => c.arguments[1].map(row => [row.id, row.displayName, row.read])),
    [[[DOC, 'Survey', readForLevel(3)]]]);
});

test('No threats found never publishes on a requested read list alone', async (t) => {
  const { store, deps } = setup(t, pendingRow({ requestedRead: readForLevel(4) }));

  await apply('No threats found', deps);

  const row = store.rows.get(DOC);
  assert.strictEqual(row.scanStatus, 'clean');
  assert.deepStrictEqual(row.read, readForLevel(3));
  assert.strictEqual(row.isPublished, false);
});

/** Stand-in for the repository publish: the store row takes level 4's read list. */
function fakeSetPublished(t, store) {
  return t.mock.method(documents, 'setPublished', async (id, _projectId, level) => {
    Object.assign(store.rows.get(id), { read: readForLevel(level), isPublished: level === 4 });
    return store.rows.get(id);
  });
}

test('No threats found sends the re-read clean row, after settle, to sync-out and extraction', async (t) => {
  const { store, deps } = setup(t, pendingRow({ requestedRead: readForLevel(3), documentSource: 'PROJECT' }));
  const seen = [];
  t.mock.method(syncOut, 'enqueueQuietly', async (row, opts) => {
    seen.push(['sync-out', row, opts, store.rows.get(DOC).scanStatus]);
    return [];
  });
  t.mock.method(extraction, 'enqueueExtraction', async (row, reason) => {
    seen.push(['extraction', row, reason, store.rows.get(DOC).scanStatus]);
    return true;
  });

  await applyListed('No threats found', deps);

  assert.deepStrictEqual(seen.map(([step, row, arg, stored]) => [step, row.documentSource, row.scanStatus, arg, stored]), [
    ['sync-out', 'PROJECT', 'clean', { kind: 'document' }, 'clean'],
    ['extraction', 'PROJECT', 'clean', 'intake', 'clean']
  ]);
});

test('an enqueue that throws after release leaves the row clean', async (t) => {
  const { store, deps } = setup(t);
  t.mock.method(syncOut, 'enqueueQuietly', async () => { throw new Error('queue down'); });
  t.mock.method(extraction, 'enqueueExtraction', async () => { throw new Error('queue down'); });

  const outcome = await apply('No threats found', deps);

  assert.strictEqual(outcome, 'clean');
  assert.strictEqual(store.rows.get(DOC).scanStatus, 'clean');
});

test('No threats found stores the file size, content type and SHA-256 of the copied bytes', async (t) => {
  const { store, deps } = setup(t);

  await apply('No threats found', deps);

  const row = store.rows.get(DOC);
  assert.strictEqual(row.fileSize, BYTES.length);
  assert.strictEqual(row.mimeType, 'application/pdf');
  assert.strictEqual(row.uploadSha256, crypto.createHash('sha256').update(BYTES).digest('hex'));
});

test('publishOnRelease on a public project ends at level 4 with one system audit row naming the requester', async (t) => {
  const { store, deps } = setup(t, pendingRow({
    requestedRead: readForLevel(3), publishOnRelease: true, publishRequestedBy: 'staff-1'
  }));
  const publishes = fakeSetPublished(t, store);
  const audits = t.mock.method(audit, 'auditEvent', () => {});

  await applyListed('No threats found', deps);

  const row = store.rows.get(DOC);
  assert.strictEqual(row.scanStatus, 'clean');
  assert.deepStrictEqual(row.read, readForLevel(4));
  assert.strictEqual(publishes.mock.callCount(), 1);
  assert.deepStrictEqual(audits.mock.calls.map(c => [c.arguments[0], c.arguments[1].action,
    c.arguments[1].targetId, c.arguments[1].detail.requestedBy, c.arguments[1].detail.reason]),
  [[null, 'record.widen', DOC, 'staff-1', 'publish on upload']]);
});

test('publishOnRelease on a staff-only project stays at the capped level and says why', async (t) => {
  const staffOnly = fakeProjects({ 'proj-1': { id: 'proj-1', read: readForLevel(3) } });
  const { store, deps } = setup(t, pendingRow({ requestedRead: readForLevel(3), publishOnRelease: true }), staffOnly);
  const publishes = fakeSetPublished(t, store);

  await apply('No threats found', deps);

  const row = store.rows.get(DOC);
  assert.deepStrictEqual(row.read, readForLevel(3));
  assert.strictEqual(row.isPublished, false);
  assert.strictEqual(row.publishRefused, 'project-not-public');
  assert.strictEqual(publishes.mock.callCount(), 0);
});

/** The store's refusal record, as the real conditional patch: lands on a released row only. */
function withMarkPublishRefused(store) {
  store.markPublishRefused = async (row, reason) => {
    const stored = store.rows.get(row.id);
    if (stored.scanStatus !== 'clean') return false;
    stored.publishRefused = reason;
    return true;
  };
}

test('publishOnRelease whose publish fails stays at the capped level and says why', async (t) => {
  const { store, deps } = setup(t, pendingRow({ requestedRead: readForLevel(3), publishOnRelease: true }));
  withMarkPublishRefused(store);
  t.mock.method(documents, 'setPublished', async () => { throw new Error('cosmos down'); });
  const audits = t.mock.method(audit, 'auditEvent', () => {});

  const outcome = await apply('No threats found', deps);

  const row = store.rows.get(DOC);
  assert.strictEqual(outcome, 'clean');
  assert.deepStrictEqual(row.read, readForLevel(3));
  assert.strictEqual(row.publishRefused, 'publish-failed');
  assert.strictEqual(audits.mock.callCount(), 0);
});

/** Watch every step after a copy: index writes, sync-out and extraction sends. */
function watchAfterRelease(t, deps) {
  t.mock.method(documents, 'readForWrite', async id => ({ ...deps.store.rows.get(id) }));
  t.mock.method(aiSearch, 'config', () => ({ configured: true }));
  return {
    indexed: t.mock.method(aiSearch, 'upsertIndexRows', async (_index, rows) => rows.length),
    synced: t.mock.method(syncOut, 'enqueueQuietly', async () => []),
    queued: t.mock.method(extraction, 'enqueueExtraction', async () => true)
  };
}

const NEW_BYTES = { bytes: Buffer.from('%PDF-1.7 unscanned overwrite'), etag: '"0x8DCB0000000002"' };

test('bytes overwritten after the scan release nothing and leave the row pending', async (t) => {
  const { store, nrs, account, logs, deps } = setup(t);
  const after = watchAfterRelease(t, deps);
  const client = account.blobs.staging();
  const stat = client.statObject;
  // The overwrite lands between the release's stat and its copy.
  client.statObject = async (key) => {
    const seen = await stat(key);
    account.containers.incoming.set(DOC, { ...account.containers.incoming.get(DOC), ...NEW_BYTES });
    return seen;
  };

  const outcome = await apply('No threats found', deps);

  assert.strictEqual(outcome, 'stale');
  assert.strictEqual(store.rows.get(DOC).scanStatus, 'pending');
  assert.strictEqual(nrs.objects.size, 0);
  assert.ok(account.containers.incoming.has(DOC));
  assert.deepStrictEqual([after.indexed, after.synced, after.queued].map(m => m.mock.callCount()), [0, 0, 0]);
  assert.strictEqual(logs.warn.filter(l => l.message.startsWith('[intake] upload changed after its scan')).length, 1);
});

test('a condition failure mid-copy removes the truncated object and leaves the row pending', async (t) => {
  const { store, nrs, account, deps } = setup(t);
  const after = watchAfterRelease(t, deps);
  account.blobs.staging().getRangeStream = async () => Readable.from((async function* () {
    yield BYTES.subarray(0, 4);
    throw Object.assign(new Error('condition not met'), { statusCode: 412 });
  })());

  assert.strictEqual(await apply('No threats found', deps), 'stale');
  assert.strictEqual(store.rows.get(DOC).scanStatus, 'pending');
  assert.strictEqual(nrs.objects.size, 0);
  assert.deepStrictEqual([after.indexed, after.synced, after.queued].map(m => m.mock.callCount()), [0, 0, 0]);
});

test('a clean result read without an etag releases nothing, even when the blob has none', async (t) => {
  const { store, nrs, account, deps } = setup(t);
  account.containers.incoming.get(DOC).etag = undefined;

  const outcome = await applyScanResult({ ...store.rows.get(DOC) }, scan('No threats found', { eTag: undefined }), deps);

  assert.strictEqual(outcome, 'stale');
  assert.strictEqual(store.rows.get(DOC).scanStatus, 'pending');
  assert.strictEqual(nrs.objects.size, 0);
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png body')]);

/** An Update image upload whose bytes are PNG, named with `fileExt`; `blob` overrides the stored blob. */
function setupImage(t, fileExt, blob = {}) {
  const ctx = setup(t, pendingRow({ documentSource: 'UPDATE', fileExt }));
  ctx.account.containers.incoming.set(DOC, { bytes: PNG, etag: ETAG, contentType: 'image/png', ...blob });
  return ctx;
}

test('an Update image with PNG bytes and a .png name releases from a listed row without its source', async (t) => {
  const { store, nrs, deps } = setupImage(t, 'png');

  await applyListed('No threats found', deps);

  assert.strictEqual(store.rows.get(DOC).scanStatus, 'clean');
  assert.strictEqual(nrs.objects.size, 1);
});

const NOT_AN_IMAGE = [
  ['PNG bytes but a .jpg name', 'jpg', {}],
  ['PNG bytes over 10 MB', 'png', { size: 10 * 1024 * 1024 + 1 }],
  ['PNG bytes stored as image/jpeg', 'png', { contentType: 'image/jpeg' }]
];

for (const [label, fileExt, blob] of NOT_AN_IMAGE) {
  test(`an Update image with ${label} is rejected not-an-image`, async (t) => {
    const { store, nrs, account, deps } = setupImage(t, fileExt, blob);

    await applyListed('No threats found', deps);

    const row = store.rows.get(DOC);
    assert.strictEqual(row.scanStatus, 'rejected');
    assert.strictEqual(row.scanRejectReason, 'not-an-image');
    assert.strictEqual(nrs.objects.size, 0);
    assert.ok(account.containers.quarantine.has(DOC));
  });
}

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
