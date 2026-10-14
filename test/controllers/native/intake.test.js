'use strict';

/**
 * POST and GET /api/intake/uploads through the real route table: the stored row and the answer are
 * the observable surface. Cosmos and the intake account are stubbed.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { SUITE_KEY } = require('../../helpers/suite-key');
const { withServer } = require('../../helpers/with-server');

const documents = require('../../../src/repositories/documents');
const projects = require('../../../src/repositories/projects');
const blobs = require('../../../src/intake/blobs');
const store = require('../../../src/intake/store');
const routes = require('../../../src/http/routes');
const authMiddleware = require('../../../src/middleware/auth');
const { requireWrite } = require('../../../src/middleware/require-roles');
const { logger } = require('../../../src/utils/logger');

const AUTHED = { 'content-type': 'application/json', 'x-api-key': SUITE_KEY };
const PROJECT = { id: '207', read: ['staff', 'idir'], region: 'Peace' };
const SAS_URL = 'https://demiintest.blob.core.windows.net/incoming/x?sig=stub';

/** Intake enabled, the project found, the row and the link captured. */
function wire(t, { account = 'demiintest', project = PROJECT, stored = null } = {}) {
  const previous = process.env.INTAKE_STORAGE_ACCOUNT;
  process.env.INTAKE_STORAGE_ACCOUNT = account;
  t.after(() => {
    if (previous === undefined) delete process.env.INTAKE_STORAGE_ACCOUNT;
    else process.env.INTAKE_STORAGE_ACCOUNT = previous;
  });
  const seen = { rows: [], links: [] };
  t.mock.method(logger, 'info', () => {});
  t.mock.method(projects, 'getById', async (_access, id) => (project && String(id) === project.id ? project : null));
  t.mock.method(documents, 'upsert', async (row, opts) => {
    seen.rows.push({ row, opts });
    return row;
  });
  t.mock.method(store, 'findById', async (id) => (stored && stored.id === id ? stored : null));
  t.mock.method(blobs, 'staging', () => ({
    getUploadUrl: async (key, opts) => {
      seen.links.push({ key, opts });
      return SAS_URL;
    }
  }));
  return seen;
}

const post = (call, body, headers = AUTHED) =>
  call('/api/intake/uploads', { method: 'POST', headers, body: JSON.stringify(body) });

test('an anonymous caller gets 401 and no row', async (t) => {
  const seen = wire(t);
  await withServer(async (call) => {
    const res = await post(call, { projectId: '207', fileName: 'a.pdf' }, { 'content-type': 'application/json' });
    assert.strictEqual(res.status, 401);
  });
  assert.strictEqual(seen.rows.length, 0);
});

test('the route sits behind authMiddleware and requireWrite', () => {
  const route = routes.find(r => r.method === 'post' && r.path === '/intake/uploads');
  assert.deepStrictEqual(route.guards, [authMiddleware, requireWrite]);
});

test('a read-only credential is refused with 403', () => {
  const route = routes.find(r => r.method === 'post' && r.path === '/intake/uploads');
  const guard = route.guards[1];
  const res = { status(code) { this.statusCode = code; return this; }, json() { return this; } };
  let passed = false;

  guard({ user: { realm_access: { roles: ['demi-service-read'] } } }, res, () => { passed = true; });

  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(passed, false);
});

test('201 answers the document id, a link for incoming/<id> and its expiry', async (t) => {
  const seen = wire(t);
  const before = Date.now();
  await withServer(async (call) => {
    const res = await post(call, { projectId: '207', fileName: 'Report.PDF' });
    assert.strictEqual(res.status, 201);
    const body = await res.json();

    assert.strictEqual(body.documentId, seen.rows[0].row.id);
    assert.strictEqual(body.uploadUrl, SAS_URL);
    assert.strictEqual(seen.links[0].key, body.documentId);
    assert.strictEqual(seen.links[0].opts.expirySeconds, 900);
    const ttl = Date.parse(body.expiresAt) - before;
    assert.ok(ttl >= 900 * 1000 && ttl < 905 * 1000, body.expiresAt);
  });
});

test('the row is created pending, unreadable, with the fields the scan handler reads', async (t) => {
  const seen = wire(t);
  await withServer(async (call) => {
    assert.strictEqual((await post(call, { projectId: '207', fileName: 'Report.PDF' })).status, 201);
  });

  const { row, opts } = seen.rows[0];
  assert.strictEqual(opts.create, true);
  assert.strictEqual(row.scanStatus, 'pending');
  assert.deepStrictEqual(row.read, []);
  assert.strictEqual(row.isPublished, false);
  assert.strictEqual(row.projectId, '207');
  assert.strictEqual(row.fileExt, 'pdf');
  assert.strictEqual(row.displayName, 'Report.PDF');
  assert.strictEqual(row.s3Key, undefined, 'the handler derives the object key on release');
  assert.ok(!Number.isNaN(Date.parse(row.createdAt)));
  assert.deepStrictEqual(row.requestedRead, ['team'], 'level 1 when none is asked for');
});

test('requestedRead is capped at the project level', async (t) => {
  const seen = wire(t, { project: { ...PROJECT, read: ['team'] } });
  await withServer(async (call) => {
    const res = await post(call, { projectId: '207', fileName: 'a.pdf', requestedRead: ['staff', 'idir'] });
    assert.strictEqual(res.status, 201);
  });
  assert.deepStrictEqual(seen.rows[0].row.requestedRead, ['team']);
});

test('requestedRead cannot publish', async (t) => {
  const seen = wire(t);
  await withServer(async (call) => {
    const res = await post(call, { projectId: '207', fileName: 'a.pdf', requestedRead: ['public'] });
    assert.strictEqual(res.status, 400);
  });
  assert.strictEqual(seen.rows.length, 0);
});

test('an unknown body parameter is refused', async (t) => {
  const seen = wire(t);
  await withServer(async (call) => {
    const res = await post(call, { projectId: '207', fileName: 'a.pdf', read: ['public'] });
    assert.strictEqual(res.status, 400);
  });
  assert.strictEqual(seen.rows.length, 0);
});

test('a project the caller cannot see is 404', async (t) => {
  const seen = wire(t, { project: null });
  await withServer(async (call) => {
    assert.strictEqual((await post(call, { projectId: '207', fileName: 'a.pdf' })).status, 404);
  });
  assert.strictEqual(seen.links.length, 0);
});

test('503 and no row when INTAKE_STORAGE_ACCOUNT is empty', async (t) => {
  const seen = wire(t, { account: '' });
  await withServer(async (call) => {
    assert.strictEqual((await post(call, { projectId: '207', fileName: 'a.pdf' })).status, 503);
  });
  assert.strictEqual(seen.rows.length, 0);
  assert.strictEqual(seen.links.length, 0);
});

test('one log line per issued link', async (t) => {
  wire(t);
  await withServer(async (call) => {
    await post(call, { projectId: '207', fileName: 'a.pdf' });
  });
  const lines = logger.info.mock.calls.filter(c => /upload link issued/.test(c.arguments[0]));
  assert.strictEqual(lines.length, 1);
  assert.ok(lines[0].arguments[1].documentId);
});

const PENDING = { id: 'u1', projectId: '207', scanStatus: 'pending', read: [], createdAt: '2026-10-14T17:00:00.000Z' };

const getStatus = (call, id, headers = AUTHED) => call(`/api/intake/uploads/${id}`, { headers });

test('status: an anonymous caller gets 401', async (t) => {
  wire(t, { stored: PENDING });
  await withServer(async (call) => {
    assert.strictEqual((await getStatus(call, 'u1', {})).status, 401);
  });
});

test('status: a pending upload answers 200 with null reason and scan time', async (t) => {
  wire(t, { stored: PENDING });
  await withServer(async (call) => {
    const res = await getStatus(call, 'u1');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), {
      documentId: 'u1', scanStatus: 'pending', scanRejectReason: null, scannedAt: null,
      createdAt: '2026-10-14T17:00:00.000Z'
    });
  });
});

test('status: a rejected upload answers its reason and scan time', async (t) => {
  wire(t, { stored: { ...PENDING, scanStatus: 'rejected', scanRejectReason: 'malicious', scannedAt: '2026-10-14T17:05:00.000Z' } });
  await withServer(async (call) => {
    const body = await (await getStatus(call, 'u1')).json();
    assert.strictEqual(body.scanStatus, 'rejected');
    assert.strictEqual(body.scanRejectReason, 'malicious');
    assert.strictEqual(body.scannedAt, '2026-10-14T17:05:00.000Z');
  });
});

test('status: a document that never went through intake is 404', async (t) => {
  const { scanStatus: _scanStatus, ...ordinary } = PENDING;
  wire(t, { stored: { ...ordinary, read: ['public'] } });
  await withServer(async (call) => {
    assert.strictEqual((await getStatus(call, 'u1')).status, 404);
  });
});

test('status: an upload in a project the caller cannot see is 404', async (t) => {
  wire(t, { stored: PENDING, project: null });
  await withServer(async (call) => {
    assert.strictEqual((await getStatus(call, 'u1')).status, 404);
  });
});

test('status: 503 when INTAKE_STORAGE_ACCOUNT is empty', async (t) => {
  wire(t, { stored: PENDING, account: '' });
  await withServer(async (call) => {
    assert.strictEqual((await getStatus(call, 'u1')).status, 503);
  });
});
