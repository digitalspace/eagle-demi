'use strict';

process.env.NODE_ENV = 'test';
// Before src/config is first required: the audit writer is inert without both, so the rows this
// file asserts on would never be produced. Same pattern as audit-cud-coverage.test.js.
process.env.AUDIT_DCR_ENDPOINT = 'https://dcr-test.canadacentral-1.ingest.monitor.azure.com';
process.env.AUDIT_DCR_IMMUTABLE_ID = 'dcr-testimmutableid';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../../src/config');
const audit = require('../../src/utils/audit');
const cosmos = require('../../src/db/cosmos-nosql');
const storage = require('../../src/storage');
const documents = require('../../src/repositories/documents');
const bulkDownloads = require('../../src/repositories/bulk-downloads');
const queue = require('../../src/jobs/bulk-download-queue');
const controller = require('../../src/controllers/nosql/bulk-download');
const { makeRes } = require('../../src/http/router');

// The queue name is what switches the feature on; Azure drops an empty app setting, so an
// environment without one must refuse rather than enqueue into nothing.
const QUEUE = 'bulk-downloads';
config.bulkDownloadsQueue = QUEUE;

// A real job id: the GET route refuses anything that is not one, and the container also holds
// `quota:<requester>` rows no request may reach.
const JOB = '6f1c4b9e-0d2a-4d9d-9c3e-1f5f9a2b7c40';

// The router's own response object, not a `{ status, json }` double: it serialises the body and
// refuses a second send, so a handler that answered twice or handed back a non-JSON value fails
// here instead of passing against a stub that is more forgiving than production.
function res() {
  return makeRes('test-request');
}

/** What the caller actually received. */
function body(response) {
  return JSON.parse(response.body);
}

// Set for the whole file and reset in the LAST suite only: a reset between suites puts the real
// ingestion transport back, and every later event then spends its retries failing to reach Azure.
let rows = [];
audit._setTransport(async (stream, batch) => { rows.push(...batch.map(row => ({ stream, row }))); });

async function eventsFrom(fn) {
  rows = [];
  await fn();
  await audit.flush();
  return {
    audited: rows.filter(r => r.stream === audit.AUDIT_STREAM).map(r => r.row),
    analytics: rows.filter(r => r.stream === audit.EVENTS_STREAM).map(r => r.row)
  };
}

const ANON = { headers: {}, query: {}, params: {} };
// A Keycloak-shaped principal: `sub` is what binds a job to its owner.
const STAFF = { sub: 'kc-sub-1', preferred_username: 'staff.person', realm_access: { roles: ['sysadmin'] } };

function post(documentIds, user) {
  return { ...ANON, body: { documentIds }, user };
}

function ids(count, prefix = 'd') {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}

function visibleRows(count) {
  return ids(count).map(id => ({
    id, projectId: '207', fileSize: 1000, isPublished: true, s3Key: `etl/site-c/${id}.pdf`
  }));
}

/** The happy path every POST test needs: a slot, a manifest and a queue that accepts. */
function allow(t, { manifest = visibleRows(3), stored = {} } = {}) {
  t.mock.method(bulkDownloads, 'acquireSlot', async () => true);
  t.mock.method(bulkDownloads, 'releaseSlot', async () => true);
  t.mock.method(documents, 'listByIdsUnscoped', async () => manifest);
  t.mock.method(bulkDownloads, 'create', async (job) => { Object.assign(stored, job); return job; });
  t.mock.method(queue, 'enqueue', async () => {});
  return stored;
}

test('POST /bulk-downloads', async (t) => {
  t.afterEach(() => {
    t.mock.restoreAll();
    config.bulkDownloadsQueue = QUEUE;
  });

  await t.test('one id answers with a direct download instead of a job', async () => {
    t.mock.method(documents, 'getById', async () => ({
      id: 'd1', projectId: '207', s3Key: 'etl/site-c/part-a.pdf', displayName: 'Part A', isPublished: true
    }));
    t.mock.method(storage, 'getDownloadUrl', async () => 'https://nrs.example/presigned');
    const created = t.mock.method(bulkDownloads, 'create', async job => job);

    const response = res();
    const { analytics } = await eventsFrom(() => controller.createBulkDownload(post(['d1']), response));

    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(body(response).url, 'https://nrs.example/presigned');
    assert.strictEqual(body(response).fileName, 'part-a.pdf');
    assert.strictEqual(body(response).single, true);
    assert.strictEqual(created.mock.callCount(), 0, 'a single file must not create a job');
    // Both events: the shared helper records the document download, this route records the request.
    assert.deepStrictEqual(analytics.map(row => row.EventName).sort(),
      ['bulk.request', 'document.download']);
  });

  await t.test('one id the caller may not see answers 404 and counts nothing', async () => {
    t.mock.method(documents, 'getById', async () => null);

    const response = res();
    const { analytics } = await eventsFrom(() => controller.createBulkDownload(post(['d1']), response));

    assert.strictEqual(response.statusCode, 404);
    assert.deepStrictEqual(analytics, [], 'a refused request is not a bulk request');
  });

  await t.test('an unknown body key is refused', async () => {
    const response = res();
    await controller.createBulkDownload(
      { ...ANON, body: { documentIds: ['d1', 'd2'], projectId: '207' } }, response
    );

    assert.strictEqual(response.statusCode, 400);
    assert.match(body(response).error, /projectId/);
  });

  await t.test('a request over the cap is refused on its LENGTH, before the elements are read', async () => {
    // Every element is the wrong type, so the "non-empty strings only" message is what a scan-first
    // implementation would answer. The cap message is what proves the length was checked first.
    const listed = t.mock.method(documents, 'listByIdsUnscoped', async () => []);
    const slot = t.mock.method(bulkDownloads, 'acquireSlot', async () => true);

    const response = res();
    await controller.createBulkDownload(
      post(Array.from({ length: config.bulkAnonMaxDocuments + 1 }, () => 7)), response
    );

    assert.strictEqual(response.statusCode, 400);
    assert.match(body(response).error, /authenticated/);
    assert.strictEqual(listed.mock.callCount(), 0, 'nothing is read for a refused request');
    assert.strictEqual(slot.mock.callCount(), 0, 'a refused request takes no quota slot');
  });

  await t.test('an authenticated request over the authenticated cap is refused', async () => {
    const created = t.mock.method(bulkDownloads, 'create', async job => job);

    const response = res();
    await controller.createBulkDownload(
      post(ids(config.bulkMaxDocuments + 1), STAFF), response
    );

    assert.strictEqual(response.statusCode, 400);
    assert.match(body(response).error, new RegExp(String(config.bulkMaxDocuments)));
    assert.strictEqual(created.mock.callCount(), 0);
  });

  await t.test('a requester at a quota gets 429, straight from the failed precondition', async () => {
    // The real repository runs: Cosmos rejects the conditional patch with 412 when the counter is
    // at its cap, and 412 is what has to become a 429 rather than a 500.
    t.mock.method(cosmos, 'patch', async () => { throw Object.assign(new Error('precondition'), { code: 412 }); });
    const created = t.mock.method(bulkDownloads, 'create', async job => job);
    const listed = t.mock.method(documents, 'listByIdsUnscoped', async () => visibleRows(2));

    const response = res();
    await controller.createBulkDownload(post(['d0', 'd1']), response);

    assert.strictEqual(response.statusCode, 429);
    assert.match(body(response).error, new RegExp(String(config.bulkMaxPerDay)));
    assert.strictEqual(created.mock.callCount(), 0);
    assert.strictEqual(listed.mock.callCount(), 0, 'the manifest read is behind the quota');
  });

  await t.test('a selection over the total byte limit is refused and gives the slot back', async () => {
    const released = t.mock.method(bulkDownloads, 'releaseSlot', async () => true);
    t.mock.method(bulkDownloads, 'acquireSlot', async () => true);
    t.mock.method(documents, 'listByIdsUnscoped', async () => ([
      { id: 'd0', projectId: '207', fileSize: config.bulkMaxTotalBytes, isPublished: true, s3Key: 'a' },
      { id: 'd1', projectId: '207', fileSize: 1, isPublished: true, s3Key: 'b' }
    ]));
    const created = t.mock.method(bulkDownloads, 'create', async job => job);

    const response = res();
    await controller.createBulkDownload(post(['d0', 'd1']), response);

    assert.strictEqual(response.statusCode, 400);
    assert.strictEqual(created.mock.callCount(), 0);
    assert.strictEqual(released.mock.callCount(), 1, 'a refused request must not hold a slot');
  });

  await t.test('ids nobody may see answer 404 and give the slot back', async () => {
    const released = t.mock.method(bulkDownloads, 'releaseSlot', async () => true);
    t.mock.method(bulkDownloads, 'acquireSlot', async () => true);
    t.mock.method(documents, 'listByIdsUnscoped', async () => []);

    const response = res();
    await controller.createBulkDownload(post(['d0', 'd1']), response);

    assert.strictEqual(response.statusCode, 404);
    assert.strictEqual(released.mock.callCount(), 1);
  });

  await t.test('a document with no stored file is not part of the job', async () => {
    const stored = allow(t, {
      manifest: [
        { id: 'd0', projectId: '207', fileSize: 10, isPublished: true, s3Key: 'etl/a.pdf' },
        { id: 'd1', projectId: '207', fileSize: 10, isPublished: true, s3Key: '' },
        { id: 'd2', projectId: '207', fileSize: 10, isPublished: true, s3Key: 'etl/c.pdf' }
      ]
    });

    const response = res();
    await controller.createBulkDownload(post(['d0', 'd1', 'd2']), response);

    assert.strictEqual(response.statusCode, 202);
    assert.strictEqual(body(response).documentCount, 2, 'a row with no key cannot be zipped');
    assert.strictEqual(stored.estimatedBytes, 20);
    // The worker still gets every id asked for, so it can report the missing one in errors.txt.
    assert.deepStrictEqual(stored.documentIds, ['d0', 'd1', 'd2']);
  });

  await t.test('a queued job is written before its message is sent', async () => {
    const order = [];
    t.mock.method(bulkDownloads, 'acquireSlot', async () => true);
    t.mock.method(documents, 'listByIdsUnscoped', async () => visibleRows(3));
    t.mock.method(bulkDownloads, 'create', async (job) => { order.push('create'); return job; });
    t.mock.method(queue, 'enqueue', async () => { order.push('enqueue'); });

    const response = res();
    await controller.createBulkDownload(post(['d0', 'd1', 'd2', 'd0']), response);

    assert.strictEqual(response.statusCode, 202);
    assert.strictEqual(body(response).status, 'queued');
    assert.strictEqual(body(response).documentCount, 3);
    assert.strictEqual(body(response).estimatedPartCount, 1);
    assert.strictEqual(body(response).statusUrl, `/api/bulk-downloads/${body(response).id}`);
    // A worker that dequeues an id with no row can only give up; the reverse order is recoverable.
    assert.deepStrictEqual(order, ['create', 'enqueue']);
  });

  await t.test('a job that cannot be queued is marked failed and gives the slot back', async () => {
    allow(t, { manifest: visibleRows(2) });
    // After allow(), which mocks releaseSlot itself — a spy installed first would be replaced.
    const patched = t.mock.method(bulkDownloads, 'patch', async () => ({}));
    const released = t.mock.method(bulkDownloads, 'releaseSlot', async () => true);
    t.mock.method(queue, 'enqueue', async () => { throw new Error('storage queue unreachable'); });

    const response = res();
    await controller.createBulkDownload(post(['d0', 'd1']), response);

    assert.strictEqual(response.statusCode, 503);
    assert.strictEqual(released.mock.callCount(), 1);
    assert.strictEqual(patched.mock.callCount(), 1, 'the row must not sit queued for its whole TTL');
    assert.strictEqual(patched.mock.calls[0].arguments[1].status, 'failed');
    assert.strictEqual(patched.mock.calls[0].arguments[1].error, 'enqueue failed');
  });

  await t.test('the stored job carries the ids asked for and the access to re-check them with', async () => {
    const stored = allow(t, { manifest: visibleRows(2) });

    await controller.createBulkDownload(post(['d0', 'd1'], STAFF), res());

    assert.deepStrictEqual(stored.documentIds, ['d0', 'd1']);
    assert.strictEqual(stored.requesterId, 'kc-sub-1');
    assert.strictEqual(stored.requesterKey, 'kc-sub-1');
    assert.strictEqual(stored.access.authenticated, true);
    assert.strictEqual(stored.restricted, false, 'every document here is public');
    assert.strictEqual(stored.ttl, config.bulkJobTtlDays * 86400);
  });

  await t.test('the job carries every party a credential could be granted to', async (t2) => {
    const stored = allow(t2, { manifest: visibleRows(2) });
    const user = { ...STAFF, groups: ['group-A'] };

    await controller.createBulkDownload(post(['d0', 'd1'], user), res());

    assert.deepStrictEqual(stored.parties, ['kc-sub-1', 'group-A'],
      'the worker re-checks the snapshot grants against these; the subject alone drops a ' +
      'group-held grant and the zip silently omits documents');
  });

  await t.test('a request that blows up gives the slot back exactly once', async (t2) => {
    t2.mock.method(bulkDownloads, 'acquireSlot', async () => true);
    const released = t2.mock.method(bulkDownloads, 'releaseSlot', async () => true);
    t2.mock.method(documents, 'listByIdsUnscoped', async () => { throw new Error('cosmos down'); });

    const response = res();
    await controller.createBulkDownload(post(['d0', 'd1']), response);

    assert.strictEqual(response.statusCode, 500);
    assert.strictEqual(released.mock.callCount(), 1,
      'a slot held after a transient failure locks this requester out for the two-day quota TTL');
  });

  await t.test('an anonymous job is bound to nobody', async () => {
    const stored = allow(t, { manifest: visibleRows(2) });

    await controller.createBulkDownload(post(['d0', 'd1']), res());

    assert.strictEqual(stored.requesterId, '');
    assert.strictEqual(stored.requesterType, 'anonymous');
  });

  await t.test('a big selection is split into parts rather than refused', async () => {
    const half = Math.ceil(config.bulkMaxBytes / 2) + 1;
    const stored = allow(t, {
      manifest: ['d0', 'd1', 'd2'].map(id => ({
        id, projectId: '207', fileSize: half, isPublished: true, s3Key: `etl/${id}.pdf`
      }))
    });

    const response = res();
    await controller.createBulkDownload(post(['d0', 'd1', 'd2']), response);

    assert.strictEqual(response.statusCode, 202);
    assert.strictEqual(stored.estimatedPartCount, 3);
  });

  await t.test('the audit row names the restricted documents, and only those', async () => {
    const stored = allow(t, {
      manifest: [
        { id: 'd0', projectId: '207', fileSize: 1, isPublished: false, s3Key: 'etl/a.pdf' },
        { id: 'd1', projectId: '207', fileSize: 1, isPublished: true, s3Key: 'etl/b.pdf' }
      ]
    });

    const { audited } = await eventsFrom(
      () => controller.createBulkDownload(post(['d0', 'd1'], STAFF), res())
    );

    assert.strictEqual(audited.length, 1);
    assert.strictEqual(audited[0].Action, 'bulk.request');
    assert.strictEqual(audited[0].TargetType, 'bulkDownload');
    assert.strictEqual(audited[0].TargetId, stored.id);
    assert.deepStrictEqual(audited[0].Detail.restrictedIds, ['d0'], 'the public one is not an access');
    assert.strictEqual(audited[0].Detail.restrictedCount, 1);
    assert.strictEqual(audited[0].Detail.documentCount, 2);
    assert.strictEqual(stored.restricted, true, 'the hand-out is audited too');
  });

  await t.test('a job of public documents writes no audit row', async () => {
    allow(t, { manifest: visibleRows(2) });

    const { audited, analytics } = await eventsFrom(
      () => controller.createBulkDownload(post(['d0', 'd1']), res())
    );

    assert.deepStrictEqual(audited, [], 'public downloads are a usage statistic, not an access');
    assert.deepStrictEqual(analytics.map(row => row.EventName), ['bulk.request']);
    assert.strictEqual(analytics[0].ResultCount, 2);
  });

  await t.test('no queue configured answers 503 and writes nothing', async () => {
    config.bulkDownloadsQueue = '';
    const created = t.mock.method(bulkDownloads, 'create', async job => job);
    const slot = t.mock.method(bulkDownloads, 'acquireSlot', async () => true);

    const response = res();
    await controller.createBulkDownload(post(['d0', 'd1']), response);

    assert.strictEqual(response.statusCode, 503);
    assert.match(body(response).error, /disabled/);
    assert.strictEqual(created.mock.callCount(), 0);
    assert.strictEqual(slot.mock.callCount(), 0);
  });
});

test('GET /bulk-downloads/:id', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.after(() => audit._resetTransport());

  await t.test('an id that is not a job id is 404 without a read', async () => {
    // `quota:127.0.0.1` is a real row in this container. Nothing may read one through the route.
    const read = t.mock.method(bulkDownloads, 'getById', async () => ({ id: 'quota:127.0.0.1' }));

    const response = res();
    await controller.getBulkDownload({ ...ANON, params: { id: 'quota:127.0.0.1' } }, response);

    assert.strictEqual(response.statusCode, 404);
    assert.strictEqual(read.mock.callCount(), 0);
  });

  await t.test('an unknown id is 404', async () => {
    t.mock.method(bulkDownloads, 'getById', async () => null);

    const response = res();
    await controller.getBulkDownload({ ...ANON, params: { id: JOB } }, response);

    assert.strictEqual(response.statusCode, 404);
  });

  await t.test("another caller's job is 404, never 403", async () => {
    t.mock.method(bulkDownloads, 'getById', async () => ({
      id: JOB, status: 'ready', requesterId: 'kc-sub-other', parts: [{ key: 'zips/j1-part1.zip' }]
    }));
    const presign = t.mock.method(storage, 'getDownloadUrl', async () => 'https://nrs.example/x');

    const response = res();
    await controller.getBulkDownload({ ...ANON, params: { id: JOB }, user: STAFF }, response);

    assert.strictEqual(response.statusCode, 404);
    assert.strictEqual(presign.mock.callCount(), 0, 'a foreign job hands out no download URL');
  });

  await t.test('a ready job hands back one attachment URL per part', async () => {
    t.mock.method(bulkDownloads, 'getById', async () => ({
      id: JOB,
      status: 'ready',
      requesterId: '',
      documentCount: 4,
      includedCount: 4,
      partCount: 2,
      bytes: 300,
      errors: [],
      errorCount: 0,
      parts: [
        { n: 1, key: 'zips/j1-part1.zip', bytes: 200, count: 3 },
        { n: 2, key: 'zips/j1-part2.zip', bytes: 100, count: 1 }
      ]
    }));
    const presign = t.mock.method(storage, 'getDownloadUrl', async key => `https://nrs.example/${key}`);

    const response = res();
    const { audited, analytics } = await eventsFrom(
      () => controller.getBulkDownload({ ...ANON, params: { id: JOB } }, response)
    );

    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(body(response).status, 'ready');
    assert.strictEqual(body(response).partsReady, 2);
    assert.deepStrictEqual(body(response).parts.map(p => p.url), [
      'https://nrs.example/zips/j1-part1.zip',
      'https://nrs.example/zips/j1-part2.zip'
    ]);
    // Safari ignores `<a download>` cross-origin, so the name has to be baked into the presign.
    assert.deepStrictEqual(presign.mock.calls[1].arguments[1], {
      expirySeconds: 300, fileName: `epic-documents-${JOB}-part2.zip`
    });
    assert.deepStrictEqual(analytics.map(row => row.EventName), ['bulk.download']);
    assert.strictEqual(analytics[0].ResultCount, 4);
    assert.deepStrictEqual(audited, [], 'nothing restricted went into this job');
  });

  await t.test('handing out a job that carried a restricted document is audited', async () => {
    t.mock.method(bulkDownloads, 'getById', async () => ({
      id: JOB, status: 'ready', requesterId: 'kc-sub-1', restricted: true,
      documentCount: 2, includedCount: 2, parts: [{ n: 1, key: 'zips/j1-part1.zip' }]
    }));
    t.mock.method(storage, 'getDownloadUrl', async () => 'https://nrs.example/x');

    const { audited } = await eventsFrom(() => controller.getBulkDownload(
      { ...ANON, params: { id: JOB }, user: STAFF }, res()
    ));

    assert.strictEqual(audited.length, 1);
    assert.strictEqual(audited[0].Action, 'bulk.download');
    assert.strictEqual(audited[0].TargetType, 'bulkDownload');
    assert.strictEqual(audited[0].TargetId, JOB);
    assert.strictEqual(audited[0].ActorId, 'kc-sub-1');
  });

  await t.test('a running job whose worker stopped reporting is failed', async () => {
    t.mock.method(bulkDownloads, 'getById', async () => ({
      id: JOB,
      status: 'running',
      requesterId: '',
      startedAt: new Date(Date.now() - config.bulkStaleRunningMs - 1000).toISOString(),
      parts: []
    }));

    const response = res();
    await controller.getBulkDownload({ ...ANON, params: { id: JOB } }, response);

    assert.strictEqual(body(response).status, 'failed');
  });

  await t.test('a running job inside the visibility timeout still reports progress', async () => {
    t.mock.method(bulkDownloads, 'getById', async () => ({
      id: JOB,
      status: 'running',
      requesterId: '',
      partCount: 3,
      startedAt: new Date(Date.now() - 60 * 1000).toISOString(),
      parts: [{ n: 1, key: 'zips/j1-part1.zip' }]
    }));
    const presign = t.mock.method(storage, 'getDownloadUrl', async () => 'https://nrs.example/x');

    const response = res();
    await controller.getBulkDownload({ ...ANON, params: { id: JOB } }, response);

    assert.strictEqual(body(response).status, 'running');
    assert.strictEqual(body(response).partsReady, 1);
    assert.strictEqual(body(response).parts, undefined, 'a job that is not ready hands out no URLs');
    assert.strictEqual(presign.mock.callCount(), 0, 'and signs nothing');
  });
});
