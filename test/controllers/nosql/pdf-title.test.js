'use strict';

/**
 * PDF title lease API against an in-memory row store and object store. The object store keeps
 * versions and honours copy-source If-Match like the NRS bucket, so every assertion about "the
 * original is still whole" reads real bytes back.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Readable } = require('stream');
const { HttpRequest } = require('@azure/functions');

const documents = require('../../../src/repositories/documents');
const cosmos = require('../../../src/db/cosmos-nosql');
const storage = require('../../../src/storage');
const backupCheck = require('../../../src/helpers/backup-check');
const controller = require('../../../src/controllers/nosql/pdf-title');
const { logger } = require('../../../src/utils/logger');
const { makeRes, dispatch } = require('../../../src/http/router');
const { readForLevel } = require('../../../src/helpers/access-sql');

const KEY = 'etl/p1/report.pdf';
const BACKUP = storage.backupKeyFor(KEY);
const ORIGINAL = Buffer.from('%PDF-1.7\nbody\n%%EOF\n');
const INCREMENT = Buffer.from('1 0 obj <</Title (Site C Report)>> endobj\n%%EOF\n');

const DOC = {
  id: 'd1',
  projectId: 'p1',
  s3Key: KEY,
  displayName: 'Site C Report',
  mimeType: 'application/pdf',
  fileExt: 'pdf',
  fileSize: ORIGINAL.length,
  read: readForLevel(4)
};

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const md5Hex = b => crypto.createHash('md5').update(b).digest('hex');
const md5B64 = b => crypto.createHash('md5').update(b).digest('base64');
const clone = v => structuredClone(v);

/** Rows by id, objects by key with a version history, and every call worth asserting on. */
function world(t, { rows = [DOC], objects = { [KEY]: ORIGINAL }, gate = { ok: true } } = {}) {
  const db = new Map(rows.map((row, i) => [row.id, { ...clone(row), _etag: `e${i}` }]));
  const store = new Map();
  let version = 0;
  const put = (key, bytes) => store.set(key, { bytes, etag: md5Hex(bytes), versionId: `v${++version}`, contentType: 'application/pdf' });
  for (const [key, bytes] of Object.entries(objects)) put(key, bytes);

  const calls = { patches: [], removes: [], copies: [], uploads: [], gate: [] };

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
    put(dest, o.bytes);
    return { etag: store.get(dest).etag, versionId: store.get(dest).versionId };
  });
  t.mock.method(storage, 'removeObject', async (key, opts) => {
    calls.removes.push({ key, versionId: opts && opts.versionId });
    if (opts && opts.versionId && store.get(key) && store.get(key).versionId === opts.versionId) store.delete(key);
  });
  t.mock.method(storage, 'getObjectStream', async (key) => Readable.from([store.get(key).bytes]));
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
    if (current && ifMatch !== current.etag) return 412;
    if (headers['Content-MD5'] !== md5B64(bytes)) return 400;
    put(key, bytes);
    return 200;
  }

  return { db, store, calls, put, workerPut, row: (id = 'd1') => db.get(id) };
}

async function call(handler, { id = 'd1', body, query = {} } = {}) {
  const res = makeRes('test');
  await handler({ params: { id }, query, body, headers: {} }, res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

const lease = (opts) => call(controller.lease, opts);
const commit = (body, opts = {}) => call(controller.commit, { ...opts, body });
const report = (body, opts = {}) => call(controller.report, { ...opts, body });

/** Lease, commit and PUT `bytes` as the worker would. Returns every response. */
async function titleOnce(w, bytes, { id = 'd1', first = true } = {}) {
  const leased = await lease({ id });
  assert.equal(leased.status, 201, JSON.stringify(leased.body));
  const body = { leaseId: leased.body.leaseId, newLength: bytes.length, newSha256: sha256(bytes), newMd5: md5B64(bytes) };
  if (first) Object.assign(body, { originalLength: ORIGINAL.length, originalSha256: sha256(ORIGINAL) });
  const committed = await commit(body, { id });
  assert.equal(committed.status, 200, JSON.stringify(committed.body));
  const putStatus = w.workerPut(w.row(id).s3Key, bytes, committed.body.headers);
  return { leased, committed, putStatus, leaseId: leased.body.leaseId };
}

function expireLease(w, id = 'd1') {
  w.row(id).pdfTitle.lease.expiresAt = new Date(Date.now() - 1000).toISOString();
}

test('pdf title lease API', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.beforeEach(() => {
    for (const level of ['info', 'warn', 'error']) t.mock.method(logger, level, () => {});
  });

  await t.test('first titling: list, lease, commit, PUT, report, then titled and backup gone', async (t) => {
    const w = world(t);
    const logged = t.mock.method(logger, 'info', () => {});

    const pending = await call(controller.listPending);
    assert.deepEqual(pending.body.items, [{ id: 'd1', projectId: 'p1', mode: 'title', title: 'Site C Report' }]);

    const titled = Buffer.concat([ORIGINAL, INCREMENT]);
    const { leased, committed, putStatus, leaseId } = await titleOnce(w, titled);

    assert.equal(leased.body.backupUrl, `https://store.test/${BACKUP}?sig=get`);
    assert.equal(leased.body.title, 'Site C Report');
    assert.deepEqual(w.calls.copies[0], { src: KEY, dest: BACKUP, ifSourceEtag: md5Hex(ORIGINAL) });
    assert.deepEqual(w.calls.gate[0], { key: KEY, size: ORIGINAL.length, etag: md5Hex(ORIGINAL) });

    // Content-MD5 is signed into the link; If-Match and Content-MD5 are required on the PUT.
    assert.deepEqual(w.calls.uploads, [{ key: KEY, expirySeconds: 120, contentMd5: md5B64(titled) }]);
    assert.equal(committed.body.headers['If-Match'], `"${md5Hex(ORIGINAL)}"`);
    assert.equal(committed.body.headers['Content-MD5'], md5B64(titled));
    assert.equal(committed.body.headers['Content-Type'], 'application/pdf');
    assert.equal(putStatus, 200);
    assert.ok(logged.mock.calls.some(c => c.arguments[0] === 'pdf-title.original' &&
      c.arguments[1].sha256 === sha256(ORIGINAL) && c.arguments[1].length === ORIGINAL.length));

    const backupVersion = w.row().pdfTitle.lease.backupVersionId;
    const done = await report({ leaseId });
    assert.deepEqual(done.body, { outcome: 'titled', status: 'titled', reason: null });

    const record = w.row().pdfTitle;
    assert.equal(record.status, 'titled');
    assert.equal(record.title, 'Site C Report');
    assert.equal(record.sourceKey, KEY);
    assert.equal(record.originalLength, ORIGINAL.length);
    assert.equal(record.originalSha256, sha256(ORIGINAL));
    assert.equal(record.titledLength, titled.length);
    assert.equal(record.titledSha256, sha256(titled));
    assert.equal(record.lease, undefined);
    assert.equal(record.inFlight, undefined);
    assert.deepEqual(w.calls.removes, [{ key: BACKUP, versionId: backupVersion }], 'backup deleted by versionId');
    assert.ok(!w.store.has(BACKUP));
    assert.ok(w.store.get(KEY).bytes.equals(titled));

    // Only the DEMI-owned record is ever written; size fields keep the original size.
    assert.ok(w.calls.patches.every(ops => ops.every(op => op.path === '/pdfTitle')));
    assert.equal(w.row().fileSize, ORIGINAL.length);

    assert.deepEqual((await call(controller.listPending)).body.items, [], 'a current record is not listed again');
  });

  await t.test('the backup gate refusing stops the lease before any write', async (t) => {
    const w = world(t, { gate: { ok: false, reason: 'no-backup' } });
    const res = await lease();
    assert.equal(res.status, 409);
    assert.equal(res.body.reason, 'no-backup');
    assert.equal(w.calls.copies.length, 0);
    assert.equal(w.calls.patches.length, 0);
  });

  await t.test('an unconfigured backup refuses too', async (t) => {
    const w = world(t, { gate: { ok: false, reason: 'backup-unconfigured' } });
    assert.equal((await lease()).body.reason, 'backup-unconfigured');
    assert.equal(w.calls.copies.length, 0);
  });

  await t.test('a backup whose MD5 no longer matches parks the row for review', async (t) => {
    const w = world(t, { gate: { ok: false, reason: 'md5-mismatch' } });
    assert.equal((await lease()).body.reason, 'md5-mismatch');
    assert.equal(w.row().pdfTitle.status, 'needs-review');
    assert.equal((await lease()).body.reason, 'needs-review');
  });

  await t.test('a file over 256 MiB is skipped and recorded', async (t) => {
    const w = world(t);
    t.mock.method(storage, 'statObject', async () => ({ size: controller.MAX_BYTES + 1, etag: 'aa', contentType: 'application/pdf' }));
    const res = await lease();
    assert.equal(res.status, 409);
    assert.equal(res.body.reason, 'over-cap');
    assert.equal(w.row().pdfTitle.status, 'skipped');
    assert.equal(w.calls.copies.length, 0);
  });

  await t.test('a key stored by two rows is skipped and never listed', async (t) => {
    const w = world(t, { rows: [DOC, { ...DOC, id: 'd2' }] });
    assert.deepEqual((await call(controller.listPending)).body.items, []);
    const res = await lease();
    assert.equal(res.body.reason, 'shared-key');
    assert.equal(w.calls.copies.length, 0);
  });

  await t.test('sealed and non-PDF rows are refused and never listed', async (t) => {
    const w = world(t, {
      rows: [
        { ...DOC, read: ['compliance'], sealedAt: '2026-10-01T00:00:00Z' },
        { ...DOC, id: 'd2', s3Key: 'etl/p1/sheet.xlsx', mimeType: 'application/vnd.ms-excel', fileExt: 'xlsx' }
      ],
      objects: { [KEY]: ORIGINAL, 'etl/p1/sheet.xlsx': Buffer.from('x') }
    });
    assert.deepEqual((await call(controller.listPending)).body.items, []);
    assert.equal((await lease({ id: 'd1' })).body.reason, 'sealed');
    assert.equal((await lease({ id: 'd2' })).body.reason, 'not-pdf');
    assert.equal(w.calls.copies.length, 0);
    assert.equal(w.calls.gate.length, 0);
  });

  await t.test('a live lease refuses a second one, and a lost etag race is 412', async (t) => {
    const w = world(t);
    assert.equal((await lease()).status, 201);
    const second = await lease();
    assert.equal(second.status, 409);
    assert.equal(second.body.reason, 'lease-held');

    const w2 = world(t);
    t.mock.method(cosmos, 'patch', async () => { throw Object.assign(new Error('precondition'), { code: 412 }); });
    const raced = await lease();
    assert.equal(raced.status, 412);
    assert.equal(w2.calls.copies.length, 0);
    assert.ok(w.store.has(KEY));
  });

  await t.test('an orphan backup from a dead run is replaced, deleted by its version', async (t) => {
    const w = world(t, { objects: { [KEY]: ORIGINAL, [BACKUP]: Buffer.from('stale') } });
    const orphan = w.store.get(BACKUP).versionId;
    assert.equal((await lease()).status, 201);
    assert.deepEqual(w.calls.removes[0], { key: BACKUP, versionId: orphan });
    assert.ok(w.store.get(BACKUP).bytes.equals(ORIGINAL));
  });

  await t.test('the source changing before the backup copy releases the lease', async (t) => {
    const w = world(t);
    t.mock.method(storage, 'copyObject', async () => { throw Object.assign(new Error('PreconditionFailed'), { code: 'PreconditionFailed' }); });
    const res = await lease();
    assert.equal(res.body.reason, 'source-changed');
    assert.equal(w.row().pdfTitle.lease, undefined);
  });

  await t.test('the source changing before commit is a 409 and the backup is deleted', async (t) => {
    const w = world(t);
    const leased = await lease();
    w.put(KEY, Buffer.from('%PDF-foreign'));
    const titled = Buffer.concat([ORIGINAL, INCREMENT]);
    const res = await commit({
      leaseId: leased.body.leaseId, newLength: titled.length, newSha256: sha256(titled), newMd5: md5B64(titled),
      originalLength: ORIGINAL.length, originalSha256: sha256(ORIGINAL)
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.reason, 'source-changed');
    assert.equal(w.calls.uploads.length, 0, 'nothing signed');
    assert.ok(!w.store.has(BACKUP));
    assert.equal(w.row().pdfTitle.lease, undefined);
  });

  await t.test('the original is the API\'s own hash of the backup, never the worker\'s word', async (t) => {
    const w = world(t);
    const leased = await lease();
    const titled = Buffer.concat([ORIGINAL, INCREMENT]);
    const res = await commit({
      leaseId: leased.body.leaseId, newLength: titled.length, newSha256: sha256(titled), newMd5: md5B64(titled),
      originalLength: ORIGINAL.length, originalSha256: sha256(Buffer.from('other'))
    });
    assert.equal(res.body.reason, 'original-mismatch');
    assert.equal(w.calls.uploads.length, 0);
    assert.equal(w.row().pdfTitle.originalSha256, undefined);
  });

  await t.test('a PUT that fails If-Match leaves the store as it was', async (t) => {
    const w = world(t);
    const titled = Buffer.concat([ORIGINAL, INCREMENT]);
    const leased = await lease();
    const committed = await commit({
      leaseId: leased.body.leaseId, newLength: titled.length, newSha256: sha256(titled), newMd5: md5B64(titled),
      originalLength: ORIGINAL.length, originalSha256: sha256(ORIGINAL)
    });
    assert.equal(w.workerPut(KEY, titled, { ...committed.body.headers, 'If-Match': '"0000"' }), 412);
    const res = await report({ leaseId: leased.body.leaseId, skipped: true, reason: 'put-412' });
    assert.equal(res.body.outcome, 'skipped');
    assert.ok(w.store.get(KEY).bytes.equals(ORIGINAL));
    assert.ok(!w.store.has(BACKUP));
  });

  await t.test('a hash mismatch on completion restores the backup and keeps it', async (t) => {
    const w = world(t);
    const titled = Buffer.concat([ORIGINAL, INCREMENT]);
    const leased = await lease();
    // The worker reports one hash and writes bytes whose MD5 it also reports: size and ETag pass.
    const wrong = Buffer.concat([ORIGINAL, Buffer.from('X'.repeat(INCREMENT.length))]);
    const committed = await commit({
      leaseId: leased.body.leaseId, newLength: wrong.length, newSha256: sha256(titled), newMd5: md5B64(wrong),
      originalLength: ORIGINAL.length, originalSha256: sha256(ORIGINAL)
    });
    assert.equal(w.workerPut(KEY, wrong, committed.body.headers), 200);

    const res = await report({ leaseId: leased.body.leaseId });
    assert.equal(res.body.outcome, 'needs-review');
    assert.equal(res.body.reason, 'hash-mismatch');
    assert.ok(w.store.get(KEY).bytes.equals(ORIGINAL), 'original copied back');
    assert.ok(w.store.has(BACKUP), 'backup kept for review');
    assert.ok(!w.calls.removes.some(r => r.key === BACKUP));
    assert.deepEqual(w.calls.copies.at(-1), { src: BACKUP, dest: KEY, ifSourceEtag: md5Hex(ORIGINAL) });
    assert.equal((await lease()).body.reason, 'needs-review');
  });

  await t.test('a rename re-titles from the original and never rewrites the recorded original', async (t) => {
    const w = world(t);
    await titleOnce(w, Buffer.concat([ORIGINAL, INCREMENT]));
    await report({ leaseId: w.row().pdfTitle.lease.leaseId });
    const recorded = { ...w.row().pdfTitle };

    w.row().displayName = 'Site C Report, Final';
    const pending = (await call(controller.listPending)).body.items;
    assert.deepEqual(pending.map(i => [i.mode, i.title]), [['title', 'Site C Report, Final']]);

    const retitled = Buffer.concat([ORIGINAL, Buffer.from('1 0 obj <</Title (Site C Report, Final)>> endobj\n')]);
    const { leased } = await titleOnce(w, retitled, { first: false });
    assert.equal(leased.body.originalLength, ORIGINAL.length);
    assert.equal(leased.body.originalSha256, sha256(ORIGINAL));
    // The gate asks after the archived original, not the titled object now stored.
    assert.deepEqual(w.calls.gate.at(-1), { key: KEY, size: ORIGINAL.length, etag: md5Hex(ORIGINAL) });

    assert.equal((await report({ leaseId: leased.body.leaseId })).body.outcome, 'titled');
    const record = w.row().pdfTitle;
    assert.equal(record.title, 'Site C Report, Final');
    assert.equal(record.originalLength, recorded.originalLength);
    assert.equal(record.originalSha256, recorded.originalSha256);
    assert.equal(record.titledSha256, sha256(retitled));
  });

  await t.test('a name now withheld gets the original restored', async (t) => {
    const w = world(t);
    await titleOnce(w, Buffer.concat([ORIGINAL, INCREMENT]));
    await report({ leaseId: w.row().pdfTitle.lease.leaseId });

    w.row().vis = { displayName: 3 };
    const pending = (await call(controller.listPending)).body.items;
    assert.deepEqual(pending, [{ id: 'd1', projectId: 'p1', mode: 'restore', title: null }]);

    const leased = await lease();
    assert.equal(leased.body.mode, 'restore');
    assert.equal(leased.body.title, null);
    const bad = await commit({ leaseId: leased.body.leaseId, newLength: 5, newSha256: sha256(Buffer.from('12345')), newMd5: md5B64(Buffer.from('12345')) });
    assert.equal(bad.status, 400, 'a restore writes the recorded original and nothing else');

    const committed = await commit({
      leaseId: leased.body.leaseId, newLength: ORIGINAL.length, newSha256: sha256(ORIGINAL), newMd5: md5B64(ORIGINAL)
    });
    assert.equal(w.workerPut(KEY, ORIGINAL, committed.body.headers), 200);
    const res = await report({ leaseId: leased.body.leaseId });
    assert.equal(res.body.outcome, 'restored');
    const record = w.row().pdfTitle;
    assert.equal(record.status, 'restored');
    assert.equal(record.title, null);
    assert.equal(record.originalSha256, sha256(ORIGINAL));
    assert.ok(w.store.get(KEY).bytes.equals(ORIGINAL));
    assert.ok(!w.store.has(BACKUP));
  });

  await t.test('sweep of expired leases', async (t) => {
    const titled = Buffer.concat([ORIGINAL, INCREMENT]);

    await t.test('no write in flight: backup deleted by version, lease cleared', async (t) => {
      const w = world(t);
      await lease();
      const version = w.row().pdfTitle.lease.backupVersionId;
      expireLease(w);
      assert.equal((await lease()).body.reason, 'sweep-pending');
      const res = await call(controller.listPending);
      assert.equal(res.body.swept, 1);
      assert.equal(w.row().pdfTitle.lease, undefined);
      assert.deepEqual(w.calls.removes, [{ key: BACKUP, versionId: version }]);
      assert.equal(res.body.items.length, 1, 'offered again');
    });

    await t.test('in flight and the store holds the new object: verified and titled', async (t) => {
      const w = world(t);
      await titleOnce(w, titled);
      expireLease(w);
      await call(controller.listPending);
      assert.equal(w.row().pdfTitle.status, 'titled');
      assert.ok(!w.store.has(BACKUP));
    });

    await t.test('in flight and the store holds the source: cleared, backup deleted', async (t) => {
      const w = world(t);
      const leased = await lease();
      await commit({
        leaseId: leased.body.leaseId, newLength: titled.length, newSha256: sha256(titled), newMd5: md5B64(titled),
        originalLength: ORIGINAL.length, originalSha256: sha256(ORIGINAL)
      });
      expireLease(w);
      await call(controller.listPending);
      const record = w.row().pdfTitle;
      assert.equal(record.lease, undefined);
      assert.equal(record.inFlight, undefined);
      assert.equal(record.originalSha256, sha256(ORIGINAL), 'the recorded original stays');
      assert.ok(w.store.get(KEY).bytes.equals(ORIGINAL));
      assert.ok(!w.store.has(BACKUP));
    });

    await t.test('in flight and anything else in the store: restored, needs review, backup kept', async (t) => {
      const w = world(t);
      await titleOnce(w, titled);
      w.put(KEY, Buffer.from('%PDF-something else'));
      expireLease(w);
      await call(controller.listPending);
      const record = w.row().pdfTitle;
      assert.equal(record.status, 'needs-review');
      assert.equal(record.reason, 'unexpected-object');
      assert.ok(record.inFlight, 'the attempted write stays on record');
      assert.ok(w.store.get(KEY).bytes.equals(ORIGINAL));
      assert.ok(w.store.has(BACKUP));
    });
  });

  await t.test('commit and report need the lease they name', async (t) => {
    world(t);
    assert.equal((await commit({ leaseId: 'nope', newLength: 1, newSha256: 'a', newMd5: 'b' })).body.reason, 'no-lease');
    assert.equal((await report({ leaseId: 'nope' })).body.reason, 'no-lease');
  });
});

test('pdf title routes refuse an anonymous caller with 401', async (t) => {
  const reached = [];
  for (const name of ['listPending', 'lease', 'commit', 'report']) {
    t.mock.method(controller, name, (req, res) => { reached.push(name); res.json({}); });
  }
  const routes = [
    ['GET', '/api/documents/pdf-title/pending'],
    ['POST', '/api/documents/d1/pdf-title/lease'],
    ['POST', '/api/documents/d1/pdf-title/commit'],
    ['PUT', '/api/documents/d1/pdf-title']
  ];
  for (const [method, path] of routes) {
    const res = await dispatch(new HttpRequest({
      method, url: `http://127.0.0.1${path}`, headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : { string: '{}' }
    }), { error: () => {} });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
  assert.deepEqual(reached, []);
});
