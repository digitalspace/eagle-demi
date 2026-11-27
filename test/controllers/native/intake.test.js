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
const lists = require('../../../src/repositories/lists');
const intake = require('../../../src/controllers/native/intake');
const { catalogFor } = require('../../../src/vis/catalog');
const { mockRes } = require('../../helpers/mock-res');
const { naturalSortKey } = require('../../../src/helpers/natural-sort');
const routes = require('../../../src/http/routes');
const authMiddleware = require('../../../src/middleware/auth');
const { requireWrite } = require('../../../src/middleware/require-roles');
const { logger } = require('../../../src/utils/logger');
const { readForLevel } = require('../../../src/helpers/access-sql');

const AUTHED = { 'content-type': 'application/json', 'x-api-key': SUITE_KEY };
const PROJECT = { id: '207', read: ['staff', 'idir'], region: 'Peace' };
const SAS_URL = 'https://demiintest.blob.core.windows.net/incoming/x?sig=stub';

/** Intake enabled, the project found, the row and the link captured. */
function wire(t, { account = 'demiintest', project = PROJECT, stored = null, listed = [] } = {}) {
  const previous = process.env.INTAKE_STORAGE_ACCOUNT;
  process.env.INTAKE_STORAGE_ACCOUNT = account;
  t.after(() => {
    if (previous === undefined) delete process.env.INTAKE_STORAGE_ACCOUNT;
    else process.env.INTAKE_STORAGE_ACCOUNT = previous;
  });
  const seen = { rows: [], links: [], listCalls: [] };
  t.mock.method(logger, 'info', () => {});
  t.mock.method(projects, 'getById', async (_access, id) => (project && String(id) === project.id ? project : null));
  t.mock.method(documents, 'upsert', async (row, opts) => {
    seen.rows.push({ row, opts });
    return row;
  });
  t.mock.method(store, 'findById', async (id) => (stored && stored.id === id ? stored : null));
  t.mock.method(store, 'listForProject', async (projectId, statuses, since) => {
    seen.listCalls.push({ projectId, statuses, since });
    return listed.filter(row => row.projectId === projectId);
  });
  t.mock.method(lists, 'listByIds', async (_access, ids) => ids.map(id => ({ id, name: `label ${id}` })));
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

test('status: a released upload the caller cannot read is 404, as on GET /documents/:id', async (t) => {
  wire(t, { stored: { ...PENDING, scanStatus: 'clean', read: readForLevel(0) } });
  await withServer(async (call) => {
    assert.strictEqual((await getStatus(call, 'u1')).status, 404);
  });
});

test('status: a released upload the caller can read answers 200', async (t) => {
  wire(t, { stored: { ...PENDING, scanStatus: 'clean', read: readForLevel(2) }, project: null });
  await withServer(async (call) => {
    const res = await getStatus(call, 'u1');
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).scanStatus, 'clean');
  });
});

test('status: 503 when INTAKE_STORAGE_ACCOUNT is empty', async (t) => {
  wire(t, { stored: PENDING, account: '' });
  await withServer(async (call) => {
    assert.strictEqual((await getStatus(call, 'u1')).status, 503);
  });
});

// Calls the controller directly: the suite key is sysadmin, and these cases need other roles.
const STAFF = { realm_access: { roles: ['staff'] }, preferred_username: 'staff-user', sub: 's-1' };
const SYSADMIN = { realm_access: { roles: ['sysadmin'] }, preferred_username: 'admin-user', sub: 'a-1' };

async function createAs(user, body) {
  const res = mockRes();
  await intake.createUpload({ user, body, headers: {}, query: {}, params: {} }, res);
  return res;
}

const ALL_FIELDS = {
  documentFileName: 'report-final.pdf',
  displayName: 'Final Report',
  documentSource: 'PROJECT',
  milestoneId: 'm1',
  typeId: 't1',
  documentAuthorTypeId: 'a1',
  projectPhaseId: 'p1',
  dateUploaded: '2026-11-01T10:00:00Z',
  datePosted: '2026-11-02T10:00:00.000Z',
  description: 'The final report.',
  legislation: 2018,
  documentAuthor: 'Proponent Ltd'
};

test('every intake field lands on the pending row, List ids beside their labels', async (t) => {
  const seen = wire(t);
  const res = await createAs(STAFF, { projectId: '207', fileName: 'Report.PDF', fileSize: 1234, fields: ALL_FIELDS });
  assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));

  const { row } = seen.rows[0];
  assert.strictEqual(row.documentFileName, 'report-final.pdf');
  assert.strictEqual(row.displayName, 'Final Report');
  assert.strictEqual(row.displayNameSort, naturalSortKey('Final Report'));
  assert.strictEqual(row.documentSource, 'PROJECT');
  assert.deepStrictEqual(
    [row.milestoneId, row.typeId, row.documentAuthorTypeId, row.projectPhaseId], ['m1', 't1', 'a1', 'p1']);
  assert.deepStrictEqual(
    [row.milestone, row.type, row.documentAuthorType, row.projectPhase], ['label m1', 'label t1', 'label a1', 'label p1']);
  assert.strictEqual(row.dateUploaded, '2026-11-01T10:00:00.000Z');
  assert.strictEqual(row.datePosted, '2026-11-02T10:00:00.000Z');
  assert.strictEqual(row.description, 'The final report.');
  assert.strictEqual(row.legislation, 2018);
  assert.strictEqual(row.documentAuthor, 'Proponent Ltd');
  assert.strictEqual(row.fileSize, 1234);
  assert.strictEqual(row.fileExt, 'pdf');
});

test('without fields the file name stands in for documentFileName and displayName', async (t) => {
  const seen = wire(t);
  assert.strictEqual((await createAs(STAFF, { projectId: '207', fileName: 'Report.PDF' })).statusCode, 201);
  assert.strictEqual(seen.rows[0].row.documentFileName, 'Report.PDF');
  assert.strictEqual(seen.rows[0].row.displayName, 'Report.PDF');
});

test('a fileSize over 2 GiB is refused and no row is written', async (t) => {
  const seen = wire(t);
  const res = await createAs(STAFF, { projectId: '207', fileName: 'big.zip', fileSize: 2147483649 });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(seen.rows.length, 0);
});

test('a fileSize of exactly 2 GiB is admitted', async (t) => {
  wire(t);
  assert.strictEqual((await createAs(STAFF, { projectId: '207', fileName: 'big.zip', fileSize: 2147483648 })).statusCode, 201);
});

test('an Update image over 10 MB is refused', async (t) => {
  const seen = wire(t);
  const res = await createAs(STAFF, {
    projectId: '207', fileName: 'photo.jpg', fileSize: 10 * 1024 * 1024 + 1, fields: { documentSource: 'UPDATE' }
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(seen.rows.length, 0);
});

test('a documentSource outside the four values is refused', async (t) => {
  const seen = wire(t);
  const res = await createAs(STAFF, { projectId: '207', fileName: 'a.pdf', fields: { documentSource: 'EAGLE' } });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(seen.rows.length, 0);
});

test('an unparseable date is refused, not stored as null', async (t) => {
  const seen = wire(t);
  const res = await createAs(STAFF, { projectId: '207', fileName: 'a.pdf', fields: { dateUploaded: 'last Tuesday' } });
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error, /dateUploaded/);
  assert.strictEqual(seen.rows.length, 0);
});

test('a null date is stored as null', async (t) => {
  const seen = wire(t);
  assert.strictEqual((await createAs(STAFF, { projectId: '207', fileName: 'a.pdf', fields: { datePosted: null } })).statusCode, 201);
  assert.strictEqual(seen.rows[0].row.datePosted, null);
});

test('a displayName of 255 characters is admitted and one of 256 is refused', async (t) => {
  wire(t);
  const at = await createAs(STAFF, { projectId: '207', fileName: 'a.pdf', fields: { displayName: 'x'.repeat(255) } });
  const over = await createAs(STAFF, { projectId: '207', fileName: 'a.pdf', fields: { displayName: 'x'.repeat(256) } });
  assert.strictEqual(at.statusCode, 201);
  assert.strictEqual(over.statusCode, 400);
});

test('a List id that is not a string is refused', async (t) => {
  const seen = wire(t);
  const res = await createAs(STAFF, { projectId: '207', fileName: 'a.pdf', fields: { milestoneId: 5 } });
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error, /milestoneId/);
  assert.strictEqual(seen.rows.length, 0);
});

test('a fields key staff cannot write is refused, even on the allow-list', async (t) => {
  const seen = wire(t);
  const entry = catalogFor('documents').description;
  const saved = { ...entry };
  Object.assign(entry, { defaultVis: 1, maxVis: 1 });
  t.after(() => Object.assign(entry, saved));

  const res = await createAs(STAFF, { projectId: '207', fileName: 'a.pdf', fields: { description: 'x' } });
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error, /not writable by this caller: description/);
  assert.strictEqual(seen.rows.length, 0);
});

const SERVER_SET = {
  eagleId: 'e1', sourceSystem: 'eagle', contentExtracted: true, isPublished: true, isDeleted: true, id: 'mine',
  projectId: '999', s3Key: '207/abc.pdf', read: ['public'], requestedRead: ['public'], scanStatus: 'clean'
};

for (const [role, user] of [['staff', STAFF], ['sysadmin', SYSADMIN]]) {
  for (const [key, value] of Object.entries(SERVER_SET)) {
    test(`${key} inside fields is refused for ${role} and no row is written`, async (t) => {
      const seen = wire(t);
      const res = await createAs(user, { projectId: '207', fileName: 'a.pdf', fields: { [key]: value } });
      assert.strictEqual(res.statusCode, 400);
      assert.match(res.body.error, new RegExp(`not accepted on upload: ${key}$`));
      assert.strictEqual(seen.rows.length, 0);
      assert.strictEqual(seen.links.length, 0);
    });
  }
}

test('publishOnRelease is stored with who asked, and the row stays unreadable', async (t) => {
  const seen = wire(t);
  const res = await createAs(STAFF, { projectId: '207', fileName: 'a.pdf', publishOnRelease: true });
  assert.strictEqual(res.statusCode, 201);
  const { row } = seen.rows[0];
  assert.strictEqual(row.publishOnRelease, true);
  assert.strictEqual(row.publishRequestedBy, 'staff-user');
  assert.deepStrictEqual(row.read, []);
  assert.strictEqual(row.isPublished, false);
  assert.strictEqual(row.scanStatus, 'pending');
});

test('publishOnRelease that is not a boolean is refused', async (t) => {
  const seen = wire(t);
  assert.strictEqual((await createAs(STAFF, { projectId: '207', fileName: 'a.pdf', publishOnRelease: 'yes' })).statusCode, 400);
  assert.strictEqual(seen.rows.length, 0);
});

const LISTED = [
  { id: 'r1', projectId: '207', requestedRead: readForLevel(2), displayName: 'One', scanStatus: 'pending',
    scanRejectReason: null, createdAt: '2026-11-27T10:00:00.000Z', s3Key: '207/x.pdf' },
  { id: 'r2', projectId: '207', requestedRead: readForLevel(2), displayName: 'Two', scanStatus: 'rejected',
    scanRejectReason: 'malicious', createdAt: '2026-11-26T10:00:00.000Z', scannedAt: '2026-11-26T10:05:00.000Z' },
  { id: 'r3', projectId: '207', requestedRead: readForLevel(1), displayName: 'Team only', scanStatus: 'pending',
    createdAt: '2026-11-27T09:00:00.000Z' },
  { id: 'o1', projectId: '300', requestedRead: readForLevel(2), displayName: 'Other', scanStatus: 'pending',
    createdAt: '2026-11-27T10:00:00.000Z' }
];

async function listAs(user, query) {
  const res = mockRes();
  await intake.listUploads({ user, query, headers: {}, params: {} }, res);
  return res;
}

test('list: a readable project answers its pending and rejected uploads, asked for 30 days back', async (t) => {
  const seen = wire(t, { listed: LISTED });
  const before = Date.now();
  const res = await listAs(SYSADMIN, { projectId: '207' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.map(row => row.id), ['r1', 'r2', 'r3']);
  assert.deepStrictEqual(seen.listCalls[0].statuses, ['pending', 'rejected']);
  const days = (before - Date.parse(seen.listCalls[0].since)) / (24 * 3600 * 1000);
  assert.ok(days > 29.99 && days <= 30.01, String(days));
});

test('list: a project the caller cannot read answers [] without reading uploads', async (t) => {
  const seen = wire(t, { listed: LISTED });
  const res = await listAs(SYSADMIN, { projectId: '300' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, []);
  assert.strictEqual(seen.listCalls.length, 0);
});

test('list: a row requested at level 1 is left out for a caller off the project team', async (t) => {
  wire(t, { listed: LISTED });
  const res = await listAs(STAFF, { projectId: '207' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.map(row => row.id), ['r1', 'r2']);
});

test('list: a listed upload carries only the seven answered fields', async (t) => {
  wire(t, { listed: LISTED });
  const res = await listAs(SYSADMIN, { projectId: '207' });
  assert.deepStrictEqual(res.body[1], {
    id: 'r2', displayName: 'Two', scanStatus: 'rejected', scanRejectReason: 'malicious', publishRefused: null,
    createdAt: '2026-11-26T10:00:00.000Z', scannedAt: '2026-11-26T10:05:00.000Z'
  });
});

test('list: projectId is required', async (t) => {
  wire(t, { listed: LISTED });
  assert.strictEqual((await listAs(SYSADMIN, {})).statusCode, 400);
});

test('list: an unknown query parameter is refused', async (t) => {
  wire(t, { listed: LISTED });
  assert.strictEqual((await listAs(SYSADMIN, { projectId: '207', status: 'clean' })).statusCode, 400);
});

test('list: 503 when INTAKE_STORAGE_ACCOUNT is empty', async (t) => {
  wire(t, { account: '', listed: LISTED });
  assert.strictEqual((await listAs(SYSADMIN, { projectId: '207' })).statusCode, 503);
});

test('list: the route sits behind authMiddleware and requireWrite', () => {
  const route = routes.find(r => r.method === 'get' && r.path === '/intake/uploads');
  assert.deepStrictEqual(route.guards, [authMiddleware, requireWrite]);
});

test('list: a public-tier token without a write role gets 403', () => {
  const route = routes.find(r => r.method === 'get' && r.path === '/intake/uploads');
  const res = { status(code) { this.statusCode = code; return this; }, json() { return this; } };
  let passed = false;

  route.guards[1]({ user: { identity_provider: 'idir', realm_access: { roles: [] } } }, res, () => { passed = true; });

  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(passed, false);
});

test('list: an anonymous caller gets 401 through the route table', async (t) => {
  wire(t, { listed: LISTED });
  await withServer(async (call) => {
    assert.strictEqual((await call('/api/intake/uploads?projectId=207', { headers: {} })).status, 401);
  });
});
