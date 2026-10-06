'use strict';

/**
 * PDF title lease API against an in-memory row store and object store. The object store keeps
 * versions and honours copy-source If-Match like the NRS bucket, so every assertion about "the
 * original is still whole" reads real bytes back. Most PDFs are real `pdf-title/titler.py` output
 * (test/fixtures/pdf-title); the rest are built with `test/helpers/pdf-build.js`.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const config = require('../../../src/config');
const documents = require('../../../src/repositories/documents');
const cosmos = require('../../../src/db/cosmos-nosql');
const storage = require('../../../src/storage');
const backupCheck = require('../../../src/helpers/backup-check');
const controller = require('../../../src/controllers/nosql/pdf-title');
const { logger } = require('../../../src/utils/logger');
const { makeRes } = require('../../../src/http/router');
const { readForLevel } = require('../../../src/helpers/access-sql');
const { classicTail, classicPdf } = require('../../helpers/pdf-build');

const FIXTURES = path.join(__dirname, '..', '..', 'fixtures', 'pdf-title');
const fixture = name => fs.readFileSync(path.join(FIXTURES, name));

const KEY = 'etl/p1/report.pdf';
const BACKUP = storage.backupKeyFor(KEY);
const ORIGINAL = fixture('classic-info.original.pdf');
const TITLED = fixture('classic-info.titled.pdf');
const RETITLED = fixture('classic-info.retitled.pdf');
const XMP_ORIGINAL = fixture('classic-xmp.original.pdf');
const XMP_TITLED = fixture('classic-xmp.titled.pdf');
/** The titles TITLED and RETITLED carry. */
const FIRST = 'Site C Report, Final (2026) \u00e9';
const SECOND = 'Site C Report';

// Mongo ObjectIds, as the seed and the Eagle push write `id`. No `eaglePushedAt`: the seed never sets it.
const ID = '5f1d7a3c9b2e4d6f8a0b1c2d';
const ID2 = '5f1d7a3c9b2e4d6f8a0b1c2e';

const DOC = {
  id: ID,
  projectId: 'p1',
  s3Key: KEY,
  displayName: FIRST,
  mimeType: 'application/pdf',
  fileExt: 'pdf',
  fileSize: ORIGINAL.length,
  read: readForLevel(4)
};

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const md5Hex = b => crypto.createHash('md5').update(b).digest('hex');
const md5B64 = b => crypto.createHash('md5').update(b).digest('base64');
const clone = v => structuredClone(v);
const past = () => new Date(Date.now() - 1000).toISOString();

/** Rows by id, objects by key with versions, and every call worth asserting on. */
function world(t, { rows = [DOC], objects = { [KEY]: ORIGINAL }, gate = { ok: true } } = {}) {
  const db = new Map(rows.map((row, i) => [row.id, { ...clone(row), _etag: `e${i}` }]));
  const store = new Map();
  let version = 0;
  const put = (key, bytes, contentType = 'application/pdf') =>
    store.set(key, { bytes, etag: md5Hex(bytes), versionId: `v${++version}`, contentType });
  for (const [key, bytes] of Object.entries(objects)) put(key, bytes);

  const calls = { patches: [], removes: [], copies: [], uploads: [], gate: [], ranges: [] };

  t.mock.method(documents, 'readForWrite', async (id) => (db.has(id) ? clone(db.get(id)) : null));
  t.mock.method(cosmos, 'patch', async (container, id, pk, ops, condition, etag) => {
    const row = db.get(id);
    if (etag !== row._etag) throw Object.assign(new Error('precondition'), { code: 412 });
    calls.patches.push(ops);
    for (const op of ops) row[op.path.slice(1)] = clone(op.value);
    row._etag = `${row._etag}+`;
    return clone(row);
  });
  t.mock.method(cosmos, 'query', async (container, spec) => {
    const all = [...db.values()].map(clone);
    if (spec.query.includes('ARRAY_CONTAINS(@keys')) {
      const keys = spec.parameters[0].value;
      return { items: all.filter(r => keys.includes(r.s3Key)).map(r => ({ id: r.id, s3Key: r.s3Key })) };
    }
    if (spec.query.includes('lease.expiresAt <')) {
      const now = spec.parameters[0].value;
      return { items: all.filter(r => r.pdfTitle && r.pdfTitle.lease && r.pdfTitle.lease.expiresAt < now) };
    }
    return {
      items: all.filter(r => r.s3Key && (r.read.includes('public') || (r.pdfTitle && r.pdfTitle.status === 'titled'))),
      continuationToken: undefined
    };
  });

  t.mock.method(storage, 'statObject', async (key) => {
    const o = store.get(key);
    return o ? { size: o.bytes.length, contentType: o.contentType, etag: o.etag, versionId: o.versionId } : null;
  });
  t.mock.method(storage, 'copyObject', async (src, dest, { ifSourceEtag }) => {
    calls.copies.push({ src, dest, ifSourceEtag });
    const o = store.get(src);
    if (!o || o.etag !== ifSourceEtag) throw Object.assign(new Error('PreconditionFailed'), { code: 'PreconditionFailed' });
    if (dest === storage.backupKeyFor(src) && store.has(dest)) throw Object.assign(new Error('exists'), { code: 'BACKUP_EXISTS' });
    put(dest, o.bytes, o.contentType);
    return { etag: store.get(dest).etag, versionId: store.get(dest).versionId };
  });
  t.mock.method(storage, 'removeObject', async (key, opts) => {
    calls.removes.push({ key, versionId: opts && opts.versionId });
    if (opts && opts.versionId && store.get(key) && store.get(key).versionId === opts.versionId) store.delete(key);
  });
  t.mock.method(storage, 'getObjectStream', async (key) => {
    const bytes = store.get(key).bytes;
    // Several chunks, so prefix, tail and scan are exercised across chunk edges.
    return Readable.from([0, 100, 333, 700].map((at, i, all) => bytes.subarray(at, all[i + 1])).filter(b => b.length));
  });
  t.mock.method(storage, 'readRange', async (key, offset, length, { versionId } = {}) => {
    calls.ranges.push({ key, offset, length, versionId });
    const o = store.get(key);
    if (!o || o.versionId !== versionId) throw new Error('NoSuchVersion');
    return o.bytes.subarray(offset, offset + length);
  });
  t.mock.method(storage, 'getDownloadUrl', async (key) => `https://store.test/${key}?sig=get`);
  t.mock.method(storage, 'getUploadUrl', async (key, opts) => {
    calls.uploads.push({ key, ...opts });
    return `https://store.test/${key}?sig=put`;
  });
  t.mock.method(backupCheck, 'assertBackedUp', async (key, stat) => {
    calls.gate.push({ key, ...stat });
    return typeof gate === 'function' ? gate(key, stat) : gate;
  });

  /** The worker's PUT, with the store's If-Match and Content-MD5 checks. */
  function workerPut(key, bytes, headers) {
    const current = store.get(key);
    const ifMatch = String(headers['If-Match'] || '').replace(/"/g, '');
    if (current && ifMatch && ifMatch !== current.etag) return 412;
    if (headers['Content-MD5'] !== md5B64(bytes)) return 400;
    put(key, bytes, headers['Content-Type']);
    return 200;
  }

  const row = (id = ID) => db.get(id);
  const closePutWindow = (id = ID) => { row(id).pdfTitle.inFlight.putExpiresAt = new Date(Date.now() - 60000).toISOString(); };
  const expireLease = (id = ID) => { row(id).pdfTitle.lease.expiresAt = past(); };
  return { db, store, calls, put, workerPut, row, closePutWindow, expireLease };
}

async function call(handler, { id = ID, body, query = {}, keyId = 'worker' } = {}) {
  const res = makeRes('test');
  await handler({ params: { id }, query, body, headers: {}, user: { keyId } }, res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

const lease = (opts) => call(controller.lease, opts);
const commit = (body, opts = {}) => call(controller.commit, { ...opts, body });
const report = (body, opts = {}) => call(controller.report, { ...opts, body });
const pending = async () => (await call(controller.listPending)).body.items;

function commitBody(leaseId, bytes, { first = true, original = ORIGINAL } = {}) {
  const body = { leaseId, newLength: bytes.length, newSha256: sha256(bytes), newMd5: md5B64(bytes) };
  if (first) Object.assign(body, { originalLength: original.length, originalSha256: sha256(original) });
  return body;
}

/** Lease, commit and PUT `bytes` as the worker would. */
async function titleOnce(w, bytes, { id = ID, first = true, query = {}, original } = {}) {
  const leased = await lease({ id, query });
  assert.equal(leased.status, 201, JSON.stringify(leased.body));
  const committed = await commit(commitBody(leased.body.leaseId, bytes, { first, original }), { id });
  assert.equal(committed.status, 200, JSON.stringify(committed.body));
  const putStatus = w.workerPut(w.row(id).s3Key, bytes, committed.body.headers);
  return { leased, committed, putStatus, leaseId: leased.body.leaseId };
}

async function titled(w) {
  const { leaseId } = await titleOnce(w, TITLED);
  w.closePutWindow();
  assert.equal((await report({ leaseId })).body.outcome, 'titled');
}

test('pdf title lease API', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.beforeEach((t) => {
    for (const level of ['info', 'warn', 'error']) t.mock.method(logger, level, () => {});
  });

  await t.test('first titling: list, lease, commit, PUT, report, then titled and backup gone', async (t) => {
    const w = world(t);
    const logged = t.mock.method(logger, 'info', () => {});

    assert.deepEqual(await pending(), [{ id: ID, projectId: 'p1', mode: 'title', title: FIRST }]);

    const { leased, committed, putStatus, leaseId } = await titleOnce(w, TITLED);
    assert.equal(leased.body.backupUrl, `https://store.test/${BACKUP}?sig=get`);
    assert.equal(leased.body.title, FIRST);
    assert.equal(leased.body.maxGrowth, controller.MAX_GROWTH);
    assert.deepEqual(w.calls.copies[0], { src: KEY, dest: BACKUP, ifSourceEtag: md5Hex(ORIGINAL) });
    assert.deepEqual(w.calls.gate[0], { key: KEY, size: ORIGINAL.length, etag: md5Hex(ORIGINAL) });

    // Content-MD5 is signed into the link; If-Match and Content-MD5 are required on the PUT.
    assert.deepEqual(w.calls.uploads, [{ key: KEY, expirySeconds: 120, contentMd5: md5B64(TITLED) }]);
    assert.equal(committed.body.headers['If-Match'], `"${md5Hex(ORIGINAL)}"`);
    assert.equal(committed.body.headers['Content-MD5'], md5B64(TITLED));
    assert.equal(committed.body.headers['Content-Type'], 'application/pdf');
    assert.ok(Date.parse(committed.body.putExpiresAt) > Date.now());
    assert.equal(putStatus, 200);
    assert.ok(logged.mock.calls.some(c => c.arguments[0] === 'pdf-title.original' &&
      c.arguments[1].sha256 === sha256(ORIGINAL) && c.arguments[1].length === ORIGINAL.length));

    const backupVersion = w.row().pdfTitle.lease.backupVersionId;
    assert.equal((await report({ leaseId })).body.reason, 'put-window-open');
    w.closePutWindow();
    assert.deepEqual((await report({ leaseId })).body, { outcome: 'titled', status: 'titled', reason: null });

    const record = w.row().pdfTitle;
    assert.equal(record.status, 'titled');
    assert.equal(record.title, FIRST);
    assert.equal(record.sourceKey, KEY);
    assert.equal(record.originalLength, ORIGINAL.length);
    assert.equal(record.originalSha256, sha256(ORIGINAL));
    assert.equal(record.titledLength, TITLED.length);
    assert.equal(record.titledSha256, sha256(TITLED));
    assert.equal(record.lease, undefined);
    assert.equal(record.inFlight, undefined);
    assert.deepEqual(w.calls.removes, [{ key: BACKUP, versionId: backupVersion }], 'backup deleted by versionId');
    assert.ok(!w.store.has(BACKUP));
    assert.ok(w.store.get(KEY).bytes.equals(TITLED));

    // Only the DEMI-owned record is ever written; size fields keep the original size.
    assert.ok(w.calls.patches.every(ops => ops.every(op => op.path === '/pdfTitle')));
    assert.equal(w.row().fileSize, ORIGINAL.length);

    assert.deepEqual(await pending(), [], 'a current record is not listed again');
    assert.equal((await lease()).body.reason, 'current');
  });

  await t.test('every route refuses on a store without ETag and version semantics', async (t) => {
    const w = world(t);
    const backend = config.storageBackend;
    config.storageBackend = 'azure';
    t.after(() => { config.storageBackend = backend; });
    for (const handler of [controller.listPending, controller.sweep, controller.lease, controller.commit, controller.report]) {
      const res = await call(handler, { body: {} });
      assert.equal(res.status, 503);
      assert.equal(res.body.reason, 'backend-unsupported');
    }
    assert.equal(w.calls.copies.length, 0);
  });

  await t.test('refusal reasons, each with no backup taken', async (t) => {
    const cases = {
      'not-public': { ...DOC, read: readForLevel(2) },
      'no-public-name': { ...DOC, vis: { displayName: 3 } },
      'sealed': { ...DOC, read: ['compliance'] },
      'not-pdf': { ...DOC, mimeType: 'application/vnd.ms-excel', fileExt: 'xlsx' }
    };
    for (const [reason, row] of Object.entries(cases)) {
      const w = world(t, { rows: [row] });
      const res = await lease();
      assert.equal(res.status, 409, reason);
      assert.equal(res.body.reason, reason);
      assert.equal(w.calls.copies.length, 0, reason);
      assert.deepEqual(await pending(), [], `${reason} is not listed`);
      t.mock.restoreAll();
      for (const level of ['info', 'warn', 'error']) t.mock.method(logger, level, () => {});
    }
  });

  await t.test('an ObjectId id is from Eagle without a push stamp: listed and leased', async (t) => {
    world(t);
    assert.equal(DOC.eaglePushedAt, undefined);
    assert.deepEqual((await pending()).map(r => r.id), [ID]);
    assert.equal((await lease()).status, 201);
  });

  await t.test('any other id is refused not-from-eagle and not listed, even with a push stamp', async (t) => {
    for (const id of [crypto.randomUUID(), ID.toUpperCase(), ID.slice(1)]) {
      const w = world(t, { rows: [{ ...DOC, id, eaglePushedAt: 1759600000000 }] });
      const res = await lease({ id });
      assert.equal(res.status, 409, id);
      assert.equal(res.body.reason, 'not-from-eagle', id);
      assert.equal(w.calls.copies.length, 0, id);
      assert.deepEqual(await pending(), [], `${id} is not listed`);
      t.mock.restoreAll();
      for (const level of ['info', 'warn', 'error']) t.mock.method(logger, level, () => {});
    }
  });

  await t.test('the backup gate refusing stops the lease before any write', async (t) => {
    const w = world(t, { gate: { ok: false, reason: 'no-backup' } });
    const res = await lease();
    assert.equal(res.status, 409);
    assert.equal(res.body.reason, 'no-backup');
    assert.equal(w.calls.copies.length, 0);
    assert.equal(w.calls.patches.length, 0);
  });

  await t.test('a backup whose MD5 no longer matches parks the row for review', async (t) => {
    const w = world(t, { gate: { ok: false, reason: 'md5-mismatch' } });
    assert.equal((await lease()).body.reason, 'md5-mismatch');
    assert.equal(w.row().pdfTitle.status, 'needs-review');
    assert.equal((await lease()).body.reason, 'needs-review');
    assert.deepEqual(await pending(), [], 'a row under review is not listed');
  });

  await t.test('a file over 256 MiB is skipped and recorded', async (t) => {
    const w = world(t);
    t.mock.method(storage, 'statObject', async () => ({ size: controller.MAX_BYTES + 1, etag: 'aa', contentType: 'application/pdf' }));
    const res = await lease();
    assert.equal(res.body.reason, 'over-cap');
    assert.equal(w.row().pdfTitle.status, 'skipped');
    assert.equal(w.calls.copies.length, 0);
  });

  await t.test('a key stored by two rows is skipped and never listed', async (t) => {
    const w = world(t, { rows: [DOC, { ...DOC, id: ID2 }] });
    assert.deepEqual(await pending(), []);
    assert.equal((await lease()).body.reason, 'shared-key');
    assert.equal(w.calls.copies.length, 0);
  });

  await t.test('a live lease refuses a second one and hides the row; a lost race is 412', async (t) => {
    const w = world(t);
    assert.equal((await lease()).status, 201);
    assert.equal((await lease()).body.reason, 'lease-held');
    assert.deepEqual(await pending(), [], 'a leased row is not listed');

    const w2 = world(t);
    t.mock.method(cosmos, 'patch', async () => { throw Object.assign(new Error('precondition'), { code: 412 }); });
    assert.equal((await lease()).status, 412);
    assert.equal(w2.calls.copies.length, 0);
    assert.ok(w.store.has(KEY));
  });

  await t.test('only the principal that took the lease may use it', async (t) => {
    world(t);
    const leased = await lease({ keyId: 'worker-a' });
    const res = await commit(commitBody(leased.body.leaseId, TITLED), { keyId: 'worker-b' });
    assert.equal(res.body.reason, 'no-lease');
  });

  await t.test('an orphan backup equal to the live object is replaced, deleted by its version', async (t) => {
    const w = world(t, { objects: { [KEY]: ORIGINAL, [BACKUP]: ORIGINAL } });
    const orphan = w.store.get(BACKUP).versionId;
    assert.equal((await lease()).status, 201);
    assert.deepEqual(w.calls.removes[0], { key: BACKUP, versionId: orphan });
  });

  await t.test('an orphan backup that differs from the live object is kept for review', async (t) => {
    const w = world(t, { objects: { [KEY]: ORIGINAL, [BACKUP]: Buffer.from('%PDF-other') } });
    assert.equal((await lease()).body.reason, 'orphan-backup-differs');
    assert.equal(w.calls.removes.length, 0);
    assert.equal(w.row().pdfTitle.status, 'needs-review');
  });

  await t.test('the source changing before the backup copy releases the lease', async (t) => {
    const w = world(t);
    t.mock.method(storage, 'copyObject', async () => { throw Object.assign(new Error('PreconditionFailed'), { code: 'PreconditionFailed' }); });
    assert.equal((await lease()).body.reason, 'source-changed');
    assert.equal(w.row().pdfTitle.lease, undefined);
  });

  await t.test('commit refusals', async (t) => {
    await t.test('the source changed: 409, nothing signed, backup deleted', async (t) => {
      const w = world(t);
      const leased = await lease();
      w.put(KEY, Buffer.from('%PDF-foreign'));
      const res = await commit(commitBody(leased.body.leaseId, TITLED));
      assert.equal(res.body.reason, 'source-changed');
      assert.equal(w.calls.uploads.length, 0);
      assert.ok(!w.store.has(BACKUP));
      assert.equal(w.row().pdfTitle.lease, undefined);
    });

    await t.test('the worker\'s original hash is checked against the API\'s own read', async (t) => {
      const w = world(t);
      const leased = await lease();
      const res = await commit({ ...commitBody(leased.body.leaseId, TITLED), originalSha256: sha256(Buffer.from('other')) });
      assert.equal(res.body.reason, 'original-mismatch');
      assert.equal(w.calls.uploads.length, 0);
      assert.equal(w.row().pdfTitle.originalSha256, undefined);
    });

    await t.test('an increment over the growth cap is refused', async (t) => {
      const w = world(t);
      const leased = await lease();
      const body = { ...commitBody(leased.body.leaseId, TITLED), newLength: ORIGINAL.length + controller.MAX_GROWTH + 1 };
      assert.equal((await commit(body)).status, 400);
      assert.equal(w.calls.uploads.length, 0);
    });

    await t.test('a stored object that is not a PDF gets no write link', async (t) => {
      const zip = Buffer.concat([Buffer.from('PK\x03\x04'), ORIGINAL]);
      const w = world(t, { objects: { [KEY]: zip } });
      const leased = await lease();
      const res = await commit({ ...commitBody(leased.body.leaseId, TITLED), originalLength: zip.length, originalSha256: sha256(zip) });
      assert.equal(res.body.reason, 'not-pdf-bytes');
      assert.equal(w.calls.uploads.length, 0);
      assert.equal(w.row().pdfTitle.status, 'skipped');
    });

    await t.test('an original the reader refuses is skipped with its reason, before any link', async (t) => {
      const encrypted = fixture('encrypted.original.pdf');
      const w = world(t, { objects: { [KEY]: encrypted } });
      const leased = await lease();
      const res = await commit(commitBody(leased.body.leaseId, Buffer.concat([encrypted, Buffer.from('\n')]), { original: encrypted }));
      assert.equal(res.status, 409);
      assert.equal(res.body.reason, 'original-encrypted');
      assert.equal(w.calls.uploads.length, 0);
      assert.ok(!w.store.has(BACKUP));
      const record = w.row().pdfTitle;
      assert.deepEqual([record.status, record.reason, record.lease], ['skipped', 'original-encrypted', undefined]);
      assert.equal(record.originalSha256, undefined, 'an unread original is not recorded');
    });

    await t.test('a backup with no versionId is never read unpinned', async (t) => {
      const w = world(t);
      const leased = await lease();
      w.row().pdfTitle.lease.backupVersionId = null;
      assert.equal((await commit(commitBody(leased.body.leaseId, TITLED))).body.reason, 'backup-unversioned');
      assert.equal(w.calls.ranges.length, 0);
      assert.equal(w.calls.uploads.length, 0);
      assert.equal(w.row().pdfTitle.status, undefined, 'not a fact about the file, so not a skip');
    });

    await t.test('too little lease left for the PUT link', async (t) => {
      const w = world(t);
      const leased = await lease();
      w.row().pdfTitle.lease.expiresAt = new Date(Date.now() + 100 * 1000).toISOString();
      assert.equal((await commit(commitBody(leased.body.leaseId, TITLED))).body.reason, 'lease-too-short');
      assert.equal(w.calls.uploads.length, 0);
    });

    await t.test('the row\'s key changed after the lease', async (t) => {
      const w = world(t, { objects: { [KEY]: ORIGINAL, 'etl/p1/new.pdf': ORIGINAL } });
      const leased = await lease();
      w.row().s3Key = 'etl/p1/new.pdf';
      assert.equal((await commit(commitBody(leased.body.leaseId, TITLED))).body.reason, 'key-changed');
      assert.equal(w.calls.uploads.length, 0);
      assert.ok(!w.store.has(BACKUP));
    });
  });

  await t.test('inside the PUT window nothing is final, even for a good object', async (t) => {
    const w = world(t);
    const leased = await lease();
    const committed = await commit(commitBody(leased.body.leaseId, TITLED));

    const early = await report({ leaseId: leased.body.leaseId, skipped: true, reason: 'x' });
    assert.equal(early.status, 409);
    assert.equal(early.body.reason, 'put-window-open');
    assert.ok(early.body.putExpiresAt);

    // The late PUT lands; it is good, but stays unrecorded while the link lives.
    assert.equal(w.workerPut(KEY, TITLED, committed.body.headers), 200);
    assert.equal((await report({ leaseId: leased.body.leaseId })).body.reason, 'put-window-open');
    assert.equal(w.row().pdfTitle.status, undefined);
    assert.ok(w.row().pdfTitle.lease);
    assert.ok(w.store.has(BACKUP));

    w.closePutWindow();
    assert.equal((await report({ leaseId: leased.body.leaseId })).body.outcome, 'titled');
    assert.ok(!w.store.has(BACKUP));
  });

  await t.test('a PUT refused on If-Match, reported once the link is dead, leaves the store as it was', async (t) => {
    const w = world(t);
    const leased = await lease();
    const committed = await commit(commitBody(leased.body.leaseId, TITLED));
    assert.equal(w.workerPut(KEY, TITLED, { ...committed.body.headers, 'If-Match': '"0000"' }), 412);
    w.closePutWindow();
    const res = await report({ leaseId: leased.body.leaseId, skipped: true, reason: 'put-412' });
    assert.equal(res.body.outcome, 'skipped');
    assert.ok(w.store.get(KEY).bytes.equals(ORIGINAL));
    assert.ok(!w.store.has(BACKUP));
  });

  await t.test('a plain report after a failure that wrote nothing releases without a skip', async (t) => {
    const w = world(t);
    const leased = await lease();
    await commit(commitBody(leased.body.leaseId, TITLED));
    w.closePutWindow();
    const res = await report({ leaseId: leased.body.leaseId });
    assert.equal(res.body.outcome, 'released');
    assert.equal(w.row().pdfTitle.status, undefined);
    assert.equal((await pending()).length, 1, 'offered again');
  });

  /**
   * PUT refused bytes, report inside the window (undone at once, nothing final), PUT the same bytes
   * again through the same link, then report after the window. Returns the final report body.
   */
  async function refusedTwice(w, leaseId, bytes, headers, original = ORIGINAL) {
    assert.equal(w.workerPut(KEY, bytes, headers), 200);
    const inWindow = await report({ leaseId });
    assert.equal(inWindow.status, 409);
    assert.equal(inWindow.body.reason, 'put-window-open');
    assert.ok(w.store.get(KEY).bytes.equals(original), 'undone at once');
    assert.ok(w.store.has(BACKUP), 'backup kept inside the window');
    assert.ok(w.row().pdfTitle.lease, 'lease kept inside the window');
    assert.equal(w.row().pdfTitle.status, undefined, 'no final status inside the window');

    // If-Match is unsigned and the object is the source again, so the same link lands again.
    assert.equal(w.workerPut(KEY, bytes, headers), 200);
    assert.ok(w.store.has(BACKUP));
    w.closePutWindow();
    const final = await report({ leaseId });
    assert.equal(final.status, 200);
    assert.ok(w.store.get(KEY).bytes.equals(original), 'the original is in the store at the end');
    return final.body;
  }

  await t.test('verify failures copy the backup back, and a second PUT cannot undo that', async (t) => {
    await t.test('a whole-file hash mismatch: needs review, backup kept', async (t) => {
      const w = world(t);
      const leased = await lease();
      const wrong = Buffer.from(TITLED);
      wrong[wrong.length - 20] ^= 1;
      const committed = await commit({ ...commitBody(leased.body.leaseId, wrong), newSha256: sha256(TITLED) });
      const final = await refusedTwice(w, leased.body.leaseId, wrong, committed.body.headers);
      assert.deepEqual(final, { outcome: 'needs-review', status: 'needs-review', reason: 'hash-mismatch' });
      assert.ok(w.store.has(BACKUP));
      assert.equal(w.row().pdfTitle.overwritten.etag, md5Hex(wrong), 'the overwritten version is on record');
      assert.equal((await lease()).body.reason, 'needs-review');
    });

    await t.test('the original prefix changed though the whole hash matches what was reported', async (t) => {
      const w = world(t);
      const leased = await lease();
      const bent = Buffer.from(TITLED);
      bent[20] ^= 1;
      const committed = await commit(commitBody(leased.body.leaseId, bent));
      const final = await refusedTwice(w, leased.body.leaseId, bent, committed.body.headers);
      assert.equal(final.outcome, 'needs-review');
      assert.equal(final.reason, 'hash-mismatch');
    });

    await t.test('an increment that is not the titler\'s shape is undone and skipped', async (t) => {
      const w = world(t);
      const leased = await lease();
      const text = TITLED.toString('latin1');
      const at = text.lastIndexOf('/Producer');
      assert.ok(at > ORIGINAL.length, 'the edit lands in the increment');
      const hostile = Buffer.from(`${text.slice(0, at)}/AA      ${text.slice(at + 9)}`, 'latin1');
      const committed = await commit(commitBody(leased.body.leaseId, hostile));
      const final = await refusedTwice(w, leased.body.leaseId, hostile, committed.body.headers);
      assert.deepEqual(final, { outcome: 'skipped', status: 'skipped', reason: 'tail-forbidden:AA' });
      assert.ok(!w.store.has(BACKUP), 'deleted only after the window');
    });

    await t.test('an XMP stream under a number that is not the original\'s metadata is undone and skipped', async (t) => {
      const w = world(t, { objects: { [KEY]: XMP_ORIGINAL } });
      const leased = await lease();
      const text = XMP_TITLED.toString('latin1');
      const at = text.indexOf('7 0 obj', XMP_ORIGINAL.length);
      assert.ok(at > 0 && text.slice(at, at + 200).includes('/Type /Metadata'), 'the XMP object of the increment');
      // Object 4 is the original's page: the revision would turn it into an XML stream.
      const moved = Buffer.from(`${text.slice(0, at)}4${text.slice(at + 1)}`, 'latin1');
      const committed = await commit(commitBody(leased.body.leaseId, moved, { original: XMP_ORIGINAL }));
      const final = await refusedTwice(w, leased.body.leaseId, moved, committed.body.headers, XMP_ORIGINAL);
      assert.deepEqual(final, { outcome: 'skipped', status: 'skipped', reason: 'tail-xmp-number' });
    });

    await t.test('facts the reader did not write fail closed, and nothing is released inside the window', async (t) => {
      const cases = [
        ['original-unscanned', { prev: 441, root: [3, 0], info: [1, 0], size: 6, metadataObjects: [] }],
        // The previous reader's facts, without the Catalog and Info it now keeps.
        ['original-unscanned', { prev: 441, root: [3, 0], info: [1, 0], size: 6, metadata: null }],
        ['original-xref', { error: 'original-xref' }]
      ];
      for (const [reason, facts] of cases) {
        const w = world(t);
        const leased = await lease();
        const committed = await commit(commitBody(leased.body.leaseId, TITLED));
        w.row().pdfTitle.inFlight.facts = facts;
        const final = await refusedTwice(w, leased.body.leaseId, TITLED, committed.body.headers);
        assert.deepEqual(final, { outcome: 'skipped', status: 'skipped', reason }, reason);
        t.mock.restoreAll();
        for (const level of ['info', 'warn', 'error']) t.mock.method(logger, level, () => {});
      }
    });

    await t.test('an Info nested 100,000 deep is refused as a shape, not a crash, and undone', async (t) => {
      const w = world(t);
      const deep = `<< /Title (x) /K ${'['.repeat(100000)}${']'.repeat(100000)} >>`;
      const bytes = Buffer.concat([ORIGINAL, classicTail(ORIGINAL, [[1, deep]], '/Size 6 /Root 3 0 R /Info 1 0 R /Prev 441')]);
      const { leaseId } = await titleOnce(w, bytes);
      w.closePutWindow();
      assert.deepEqual((await report({ leaseId })).body, { outcome: 'skipped', status: 'skipped', reason: 'tail-syntax' });
      assert.ok(w.store.get(KEY).bytes.equals(ORIGINAL));
    });

    await t.test('a titled file for another title than the lease\'s is undone and skipped', async (t) => {
      const w = world(t, { rows: [{ ...DOC, displayName: SECOND }] });
      const { leaseId } = await titleOnce(w, TITLED);
      w.closePutWindow();
      assert.deepEqual((await report({ leaseId })).body, { outcome: 'skipped', status: 'skipped', reason: 'tail-info-title' });
      assert.ok(w.store.get(KEY).bytes.equals(ORIGINAL));
    });

    await t.test('a check that throws copies the backup back and skips', async (t) => {
      const w = world(t);
      const { leaseId } = await titleOnce(w, TITLED);
      w.closePutWindow();
      const stream = storage.getObjectStream;
      let thrown = false;
      t.mock.method(storage, 'getObjectStream', async (key) => {
        if (thrown) return stream(key);
        thrown = true;
        throw new Error('connection reset');
      });
      assert.deepEqual((await report({ leaseId })).body, { outcome: 'skipped', status: 'skipped', reason: 'check-failed' });
      assert.ok(w.store.get(KEY).bytes.equals(ORIGINAL));
      assert.equal(w.row().pdfTitle.lease, undefined);
    });

    await t.test('a changed Content-Type', async (t) => {
      const w = world(t);
      const leased = await lease();
      const committed = await commit(commitBody(leased.body.leaseId, TITLED));
      const final = await refusedTwice(w, leased.body.leaseId, TITLED, { ...committed.body.headers, 'Content-Type': 'text/html' });
      assert.equal(final.reason, 'content-type-changed');
      assert.ok(w.store.has(BACKUP));
    });

    await t.test('refused once, then the store holds the source after the window', async (t) => {
      const w = world(t);
      const leased = await lease();
      const wrong = Buffer.from(TITLED);
      wrong[wrong.length - 20] ^= 1;
      const committed = await commit({ ...commitBody(leased.body.leaseId, wrong), newSha256: sha256(TITLED) });
      assert.equal(w.workerPut(KEY, wrong, committed.body.headers), 200);
      assert.equal((await report({ leaseId: leased.body.leaseId })).status, 409);
      w.closePutWindow();
      const final = await report({ leaseId: leased.body.leaseId });
      assert.equal(final.body.reason, 'hash-mismatch', 'the earlier refusal is still the outcome');
      assert.ok(w.store.has(BACKUP));
    });
  });

  await t.test('a rename re-titles from the original and never rewrites the recorded original', async (t) => {
    const w = world(t);
    await titled(w);
    const recorded = { ...w.row().pdfTitle };

    w.row().displayName = SECOND;
    assert.deepEqual((await pending()).map(i => [i.mode, i.title]), [['title', SECOND]]);

    const { leased, leaseId } = await titleOnce(w, RETITLED, { first: false });
    assert.equal(leased.body.originalLength, ORIGINAL.length);
    assert.equal(leased.body.originalSha256, sha256(ORIGINAL));
    // The gate asks after the archived original, not the titled object now stored.
    assert.deepEqual(w.calls.gate.at(-1), { key: KEY, size: ORIGINAL.length, etag: md5Hex(ORIGINAL) });

    w.closePutWindow();
    assert.equal((await report({ leaseId })).body.outcome, 'titled');
    const record = w.row().pdfTitle;
    assert.equal(record.title, SECOND);
    assert.equal(record.originalLength, recorded.originalLength);
    assert.equal(record.originalSha256, recorded.originalSha256);
    assert.equal(record.titledSha256, sha256(RETITLED));
  });

  await t.test('the original is read in ranges of the backup version, never past its length', async (t) => {
    const w = world(t);
    await titled(w);
    w.row().displayName = SECOND;
    const max = storage.MAX_RANGE_BYTES;
    storage.MAX_RANGE_BYTES = 100;
    t.after(() => { storage.MAX_RANGE_BYTES = max; });
    w.calls.ranges.length = 0;

    // The backup is the titled file: longer than the original, so a read past the original lands in the increment.
    const { leased } = await titleOnce(w, RETITLED, { first: false });
    const version = w.row().pdfTitle.lease.backupVersionId;
    assert.ok(w.store.get(BACKUP).bytes.equals(TITLED));
    assert.ok(w.calls.ranges.length > 1);
    for (const r of w.calls.ranges) {
      assert.deepEqual([r.key, r.versionId], [BACKUP, version]);
      assert.ok(r.offset >= 0 && r.length >= 1 && r.length <= 100, JSON.stringify(r));
      assert.ok(r.offset + r.length <= ORIGINAL.length, `${r.offset}+${r.length} reaches past ${ORIGINAL.length}`);
    }
    assert.equal(leased.body.originalLength, ORIGINAL.length);
  });

  await t.test('a Catalog inside an object stream, revised for XMP at a new number, commits and is recorded titled', async (t) => {
    const original = fixture('objstm-xmp.original.pdf');
    const titledBytes = fixture('objstm-xmp.titled.pdf');
    const w = world(t, { rows: [{ ...DOC, displayName: SECOND }], objects: { [KEY]: original } });
    const { leaseId } = await titleOnce(w, titledBytes, { original });
    assert.equal(w.row().pdfTitle.inFlight.facts.metadata.join(' '), '6 0');
    w.closePutWindow();
    assert.equal((await report({ leaseId })).body.outcome, 'titled');
    assert.equal(w.row().pdfTitle.status, 'titled');
    assert.ok(w.store.get(KEY).bytes.equals(titledBytes));
  });

  await t.test('a backup with no version is refused at lease, before any hash', async (t) => {
    const w = world(t);
    const copy = storage.copyObject;
    t.mock.method(storage, 'copyObject', async (...args) => ({ ...(await copy(...args)), versionId: null }));
    const res = await lease();
    assert.deepEqual([res.status, res.body.reason], [409, 'backup-unversioned']);
    assert.ok(!w.store.has(BACKUP));
    assert.equal(w.row().pdfTitle.lease, undefined);
  });

  await t.test('a backup replaced after the lease is never hashed as the leased one', async (t) => {
    const w = world(t);
    const leased = await lease();
    w.put(BACKUP, ORIGINAL);
    assert.equal((await commit(commitBody(leased.body.leaseId, TITLED))).body.reason, 'backup-changed');
    assert.equal(w.calls.uploads.length, 0);
  });

  await t.test('a retitle the reader now refuses records why, and the file stays titled', async (t) => {
    // Titled before the reader refused an Info that holds a number.
    const original = classicPdf([
      [1, '<< /Title (Old) /ca 0 >>'],
      [2, '<< /Type /Catalog /Pages 3 0 R >>'],
      [3, '<< /Type /Pages /Kids [4 0 R] /Count 1 >>'],
      [4, '<< /Type /Page /Parent 3 0 R /MediaBox [0 0 200 200] >>']
    ], '/Size 5 /Root 2 0 R /Info 1 0 R');
    const titledBytes = Buffer.concat([original, Buffer.from('% titled\n')]);
    const pdfTitle = {
      sourceKey: KEY, status: 'titled', title: 'Old Name', originalLength: original.length,
      originalSha256: sha256(original), originalEtag: md5Hex(original),
      titledLength: titledBytes.length, titledSha256: sha256(titledBytes)
    };
    const w = world(t, { rows: [{ ...DOC, pdfTitle }], objects: { [KEY]: titledBytes } });
    const leased = await lease();
    const res = await commit(commitBody(leased.body.leaseId, Buffer.concat([titledBytes, Buffer.from('\n')]), { first: false }));
    assert.deepEqual([res.status, res.body.reason], [409, 'original-info-value']);
    const record = w.row().pdfTitle;
    assert.deepEqual([record.status, record.reason, record.title, record.lease], ['titled', 'retitle skipped: original-info-value', 'Old Name', undefined]);
  });

  await t.test('a titled file that no longer matches its record is never leased', async (t) => {
    const w = world(t);
    await titled(w);
    w.row().displayName = SECOND;
    w.put(KEY, Buffer.concat([TITLED, Buffer.from('\n')]));
    assert.equal((await lease()).body.reason, 'record-mismatch');
    assert.equal(w.row().pdfTitle.status, 'needs-review');
    assert.equal(w.calls.copies.length, 1, 'only the first titling took a backup');
  });

  await t.test('same size, other bytes: refused at commit by the backup hash', async (t) => {
    const w = world(t);
    await titled(w);
    w.row().displayName = SECOND;
    const same = Buffer.from(TITLED);
    same[same.length - 30] ^= 1;
    w.put(KEY, same);
    const leased = await lease();
    assert.equal((await commit(commitBody(leased.body.leaseId, RETITLED, { first: false }))).body.reason, 'record-mismatch');
    assert.equal(w.calls.uploads.length, 1);
    assert.equal(w.row().pdfTitle.status, 'needs-review');
  });

  await t.test('a name now withheld gets the original restored', async (t) => {
    const w = world(t);
    await titled(w);

    w.row().vis = { displayName: 3 };
    assert.deepEqual(await pending(), [{ id: ID, projectId: 'p1', mode: 'restore', title: null }]);

    const leased = await lease();
    assert.equal(leased.body.mode, 'restore');
    assert.equal(leased.body.title, null);
    const five = Buffer.from('12345');
    const bad = await commit({ leaseId: leased.body.leaseId, newLength: 5, newSha256: sha256(five), newMd5: md5B64(five) });
    assert.equal(bad.status, 400, 'a restore writes the recorded original and nothing else');

    const committed = await commit(commitBody(leased.body.leaseId, ORIGINAL, { first: false }));
    assert.equal(w.workerPut(KEY, ORIGINAL, committed.body.headers), 200);
    w.closePutWindow();
    assert.equal((await report({ leaseId: leased.body.leaseId })).body.outcome, 'restored');
    const record = w.row().pdfTitle;
    assert.equal(record.status, 'restored');
    assert.equal(record.title, null);
    assert.ok(w.store.get(KEY).bytes.equals(ORIGINAL));
    assert.ok(!w.store.has(BACKUP));
  });

  await t.test('a row Eagle sealed after titling is not offered for restore', async (t) => {
    const w = world(t);
    await titled(w);
    Object.assign(w.row(), { vis: { displayName: 3 }, read: ['compliance'] });
    assert.deepEqual(await pending(), []);
    assert.equal((await lease()).body.reason, 'sealed');
  });

  await t.test('an operator restore refuses sealed rows like the automatic path', async (t) => {
    for (const seal of [{ read: ['compliance'] }, { read: ['compliance'], sealedAt: '2026-10-01T00:00:00Z' }]) {
      const w = world(t);
      await titled(w);
      Object.assign(w.row(), seal);
      assert.equal((await lease({ query: { mode: 'restore' } })).body.reason, 'sealed');
      assert.equal(w.calls.copies.length, 1, 'no backup, so no link to sealed bytes');
      t.mock.restoreAll();
      for (const level of ['info', 'warn', 'error']) t.mock.method(logger, level, () => {});
    }
  });

  await t.test('a lease with no recorded principal belongs to nobody', async (t) => {
    const w = world(t);
    const leased = await lease();
    delete w.row().pdfTitle.lease.principal;
    assert.equal((await commit(commitBody(leased.body.leaseId, TITLED))).body.reason, 'no-lease');
  });

  await t.test('an operator restore of a titled file whose name is still public', async (t) => {
    const w = world(t);
    await titled(w);
    assert.equal((await lease({ query: { mode: 'restore' } })).body.mode, 'restore');

    const w2 = world(t);
    assert.equal((await lease({ query: { mode: 'restore' } })).body.reason, 'no-original');
    assert.equal((await lease({ query: { mode: 'title' } })).status, 400);
    assert.equal(w2.calls.copies.length, 0);
  });

  await t.test('sweep of expired leases', async (t) => {
    await t.test('no write in flight: backup deleted by version, lease cleared', async (t) => {
      const w = world(t);
      await lease();
      const version = w.row().pdfTitle.lease.backupVersionId;
      w.expireLease();
      assert.equal((await lease()).body.reason, 'sweep-pending');
      const res = await call(controller.sweep);
      assert.equal(res.body.outcomes.released, 1);
      assert.equal(w.row().pdfTitle.lease, undefined);
      assert.deepEqual(w.calls.removes, [{ key: BACKUP, versionId: version }]);
      assert.equal((await pending()).length, 1, 'offered again');
    });

    await t.test('listing has no side effects', async (t) => {
      const w = world(t);
      await lease();
      w.expireLease();
      await pending();
      assert.ok(w.row().pdfTitle.lease, 'the expired lease is still there');
      assert.equal(w.calls.removes.length, 0);
    });

    await t.test('in flight and the PUT link still live: left waiting, backup kept', async (t) => {
      const w = world(t);
      const leased = await lease();
      await commit(commitBody(leased.body.leaseId, TITLED));
      w.expireLease();
      const res = await call(controller.sweep);
      assert.equal(res.body.outcomes.waiting, 1);
      assert.ok(w.store.has(BACKUP));
      assert.ok(w.row().pdfTitle.inFlight);
    });

    await t.test('in flight and the store holds the new object: verified and titled', async (t) => {
      const w = world(t);
      await titleOnce(w, TITLED);
      w.expireLease();
      w.closePutWindow();
      await call(controller.sweep);
      assert.equal(w.row().pdfTitle.status, 'titled');
      assert.ok(!w.store.has(BACKUP));
    });

    await t.test('in flight and the store holds the source: cleared, backup deleted', async (t) => {
      const w = world(t);
      const leased = await lease();
      await commit(commitBody(leased.body.leaseId, TITLED));
      w.expireLease();
      w.closePutWindow();
      await call(controller.sweep);
      const record = w.row().pdfTitle;
      assert.equal(record.lease, undefined);
      assert.equal(record.inFlight, undefined);
      assert.equal(record.originalSha256, sha256(ORIGINAL), 'the recorded original stays');
      assert.ok(w.store.get(KEY).bytes.equals(ORIGINAL));
      assert.ok(!w.store.has(BACKUP));
    });

    await t.test('in flight and anything else in the store: restored, needs review, backup kept', async (t) => {
      const w = world(t);
      await titleOnce(w, TITLED);
      w.put(KEY, Buffer.from('%PDF-something else'));
      w.expireLease();
      w.closePutWindow();
      await call(controller.sweep);
      const record = w.row().pdfTitle;
      assert.equal(record.status, 'needs-review');
      assert.equal(record.reason, 'unexpected-object');
      assert.ok(record.inFlight, 'the attempted write stays on record');
      assert.ok(w.store.get(KEY).bytes.equals(ORIGINAL));
      assert.ok(w.store.has(BACKUP));
    });

    await t.test('the row\'s key changed mid-lease: the leased key is settled, the new one untouched', async (t) => {
      const fresh = Buffer.from('%PDF-1.7 fresh upload');
      const w = world(t, { objects: { [KEY]: ORIGINAL, 'etl/p1/new.pdf': fresh } });
      await titleOnce(w, TITLED);
      w.row().s3Key = 'etl/p1/new.pdf';
      w.expireLease();
      w.closePutWindow();
      await call(controller.sweep);
      assert.ok(w.store.get('etl/p1/new.pdf').bytes.equals(fresh), 'the new key is never written');
      assert.ok(w.store.get(KEY).bytes.equals(TITLED));
      const record = w.row().pdfTitle;
      assert.equal(record.status, 'titled');
      assert.equal(record.sourceKey, KEY, 'the record names the key it was made for');
    });

    await t.test('every page of one sweep uses the cutoff its first page returned', async (t) => {
      world(t);
      const seen = [];
      t.mock.method(cosmos, 'query', async (container, spec, opts) => {
        seen.push({ now: spec.parameters[0].value, continuation: opts.continuationToken });
        return { items: [], continuationToken: seen.length === 1 ? 'page-2' : undefined };
      });
      const first = await call(controller.sweep);
      assert.equal(first.body.continuation, 'page-2');
      assert.equal(first.body.before, seen[0].now);
      // A cutoff from a sweep that started earlier is read back exactly, not replaced by now.
      const earlier = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const second = await call(controller.sweep, { query: { continuation: 'page-2', before: earlier } });
      assert.equal(second.status, 200);
      assert.equal(second.body.before, earlier);
      assert.equal(seen[1].now, earlier);
      assert.equal(seen[1].continuation, 'page-2');
      assert.equal((await call(controller.sweep, { query: { continuation: 'page-2' } })).status, 400, 'a continuation needs its cutoff');
      assert.equal((await call(controller.sweep, { query: { before: 'yesterday' } })).status, 400);
    });

    await t.test('a row that fails is named and the rest still settle', async (t) => {
      const w = world(t, { rows: [DOC, { ...DOC, id: ID2, s3Key: 'etl/p1/two.pdf' }], objects: { [KEY]: ORIGINAL, 'etl/p1/two.pdf': ORIGINAL } });
      await lease({ id: ID });
      await lease({ id: ID2 });
      w.expireLease(ID);
      w.expireLease(ID2);
      const patch = cosmos.patch;
      t.mock.method(cosmos, 'patch', async (...args) => {
        if (args[1] === ID) throw new Error('Cosmos unavailable');
        return patch(...args);
      });
      const res = await call(controller.sweep);
      assert.deepEqual(res.body.failed, [ID]);
      assert.equal(res.body.outcomes.released, 1);
      assert.equal(w.row(ID2).pdfTitle.lease, undefined);
    });
  });

  await t.test('commit and report need the lease they name', async (t) => {
    world(t);
    assert.equal((await commit({ leaseId: 'nope', newLength: 1, newSha256: 'a', newMd5: 'b' })).body.reason, 'no-lease');
    assert.equal((await report({ leaseId: 'nope' })).body.reason, 'no-lease');
    assert.equal((await commit({ leaseId: 'x' }, { id: 'missing' })).status, 404);
  });
});
