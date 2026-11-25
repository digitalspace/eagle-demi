'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const documents = require('../../../src/repositories/documents');
const cosmos = require('../../../src/db/cosmos-nosql');
const storage = require('../../../src/storage');
const backupCheck = require('../../../src/helpers/backup-check');
const controller = require('../../../src/controllers/nosql/pdf-title');
const { logger } = require('../../../src/utils/logger');
const { makeRes } = require('../../../src/http/router');
const { readForLevel } = require('../../../src/helpers/access-sql');
const { MAX_WORKER_FAILURES, REFUSAL_BACKOFF_MS } = require('../../../src/helpers/pdf-title');

const ID = '5f1d7a3c9b2e4d6f8a0b1c2d';
const KEY = 'etl/p1/report.pdf';
const DOC = {
  id: ID, projectId: 'p1', s3Key: KEY, displayName: 'Site C Report',
  mimeType: 'application/pdf', fileExt: 'pdf', fileSize: 1000, read: readForLevel(4)
};
const STAT = { size: 1000, etag: 'aa', versionId: 'v1', contentType: 'application/pdf' };
const ago = ms => new Date(Date.now() - ms).toISOString();

/** One stored row behind etag-guarded patches, the only row on the work list; the store holds `stat`. */
function world(t, row, { stat = STAT, gate = { ok: true } } = {}) {
  const db = { row: { ...structuredClone(row), _etag: 'e0' } };
  t.mock.method(documents, 'readForWrite', async () => structuredClone(db.row));
  t.mock.method(cosmos, 'patch', async (container, id, pk, ops, condition, etag) => {
    if (etag !== db.row._etag) throw Object.assign(new Error('precondition'), { code: 412 });
    for (const op of ops) db.row[op.path.slice(1)] = structuredClone(op.value);
    db.row._etag += '+';
    return structuredClone(db.row);
  });
  t.mock.method(cosmos, 'query', async (container, spec) => (spec.query.includes('ARRAY_CONTAINS(@keys')
    ? { items: [{ id: db.row.id, s3Key: db.row.s3Key }] }
    : { items: [structuredClone(db.row)] }));
  t.mock.method(storage, 'statObject', async () => stat);
  t.mock.method(storage, 'copyObject', async () => ({ etag: STAT.etag, versionId: 'v2' }));
  t.mock.method(storage, 'getDownloadUrl', async (key) => `https://store.test/${key}?sig=get`);
  t.mock.method(backupCheck, 'assertBackedUp', async () => gate);
  return db;
}

async function call(handler, body) {
  const res = makeRes('test');
  await handler({ params: { id: ID }, query: {}, body, headers: {}, user: { keyId: 'worker' } }, res);
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

const pendingIds = async () => (await call(controller.listPending)).body.items.map(i => i.id);

/** A row leased by this worker with no write in flight, after `workerFailures` reported failures. */
const leasedAfter = workerFailures => ({
  ...DOC,
  pdfTitle: {
    sourceKey: KEY, workerFailures,
    lease: { leaseId: 'L1', mode: 'title', title: DOC.displayName, key: KEY, principal: 'worker', expiresAt: ago(-60000) }
  }
});

test('pdf title give-up rules', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.beforeEach((t) => {
    for (const level of ['info', 'warn', 'error']) t.mock.method(logger, level, () => {});
  });

  await t.test('a worker failure below the cap is counted and the row offered again', async (t) => {
    const db = world(t, leasedAfter(MAX_WORKER_FAILURES - 2));
    const res = await call(controller.report, { leaseId: 'L1', reason: 'upload: HTTP 403' });
    assert.equal(res.body.outcome, 'released');
    assert.equal(db.row.pdfTitle.workerFailures, MAX_WORKER_FAILURES - 1);
    assert.equal(db.row.pdfTitle.status, undefined);
    assert.deepEqual(await pendingIds(), [ID]);
  });

  await t.test('the failure that reaches the cap parks the row for review with its text', async (t) => {
    const db = world(t, leasedAfter(MAX_WORKER_FAILURES - 1));
    const logged = t.mock.method(logger, 'error', () => {});
    const res = await call(controller.report, { leaseId: 'L1', reason: "TypeError: argument of type 'NoneType' is not iterable" });
    assert.equal(res.body.outcome, 'needs-review');
    assert.equal(db.row.pdfTitle.status, 'needs-review');
    assert.equal(db.row.pdfTitle.reason, "worker-failure: TypeError: argument of type 'NoneType' is not iterable");
    assert.equal(db.row.pdfTitle.workerFailures, null);
    assert.deepEqual(logged.mock.calls.map(c => c.arguments[0]), ['[pdf-title] worker failed too often; needs review']);
    assert.deepEqual(await pendingIds(), []);
  });

  await t.test('a missing object is recorded as a refusal and left off the work list for a day', async (t) => {
    const db = world(t, DOC, { stat: null });
    assert.equal((await call(controller.lease)).body.reason, 'no-object');
    assert.equal(db.row.pdfTitle.refused.reason, 'no-object');
    assert.deepEqual(await pendingIds(), [], 'inside the back-off');
    db.row.pdfTitle.refused.at = ago(REFUSAL_BACKOFF_MS + 1000);
    assert.deepEqual(await pendingIds(), [ID], 'listed again after it');
  });

  await t.test('a lease that passes the gate clears an earlier refusal', async (t) => {
    const refused = { reason: 'size-mismatch', at: ago(REFUSAL_BACKOFF_MS + 1000) };
    const db = world(t, { ...DOC, pdfTitle: { sourceKey: KEY, refused } });
    assert.equal((await call(controller.lease)).status, 201);
    assert.equal(db.row.pdfTitle.refused, undefined);
    assert.ok(db.row.pdfTitle.lease);
  });
});
