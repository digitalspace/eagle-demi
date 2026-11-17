'use strict';

// GET /projects/:id/works-staff and /sheet-works: who may call them, and what each work carries.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../../../src/config');
const phaseCatalog = require('../../../src/domain/phase-catalog');
const projects = require('../../../src/repositories/projects');
const works = require('../../../src/repositories/works');
const routes = require('../../../src/http/routes');
const authMiddleware = require('../../../src/middleware/auth');
const { getSheetWorks, getWorksStaff } = require('../../../src/controllers/nosql/works-staff');
const { mockRes } = require('../../helpers/mock-res');
const { withServer } = require('../../helpers/with-server');

const EPD = {
  id: 'a1', role: 'epd', name: 'Casey Sample', effectiveFrom: null, effectiveTo: null,
  observedAt: '2026-11-01', source: 'sheet', sheetKey: 'k1', recordedAt: '2026-11-01T00:00:00.000Z'
};
const investment = (id, source) => ({
  id, amountCad: 1000, effectiveFrom: null, effectiveTo: null, observedAt: '2026-11-01',
  workId: null, source, sheetKey: source === 'sheet' ? 'k2' : null, recordedAt: '2026-11-01T00:00:00.000Z'
});

const ROW = {
  id: '412', name: 'Example Gold Mine', read: ['public', 'staff', 'sysadmin'], isPublished: true,
  staffAssignments: [EPD],
  capitalInvestments: [investment('i-sheet', 'sheet'), investment('i-track', 'track'), investment('i-eagle', 'eagle')],
  staffNotes: []
};
const OPEN_WORK = { id: 'track-9001', projectId: '412', title: 'Example assessment', startDate: '2024-03-01', sourceKey: '412:open:1' };
const WORK_1997 = {
  id: 'sheet-00000000-0000-4000-8000-000000000001', projectId: '412', title: 'Example 1997 assessment',
  startDate: '1996-05-01', decisionDate: '1997-08-15', sourceKey: '412:assessment:1'
};
// Closed with no decision date: the work ends with its last phase.
const ENDED_WORK = {
  id: 'track-9002', projectId: '412', title: 'Example withdrawn assessment', startDate: '2019-01-01', workState: 'COMPLETED',
  phases: [{ id: 'p1', startDate: '2019-01-01', endDate: '2021-06-30' }]
};

const STAFF = { realm_access: { roles: ['staff'] } };
const SERVICE_READ = { realm_access: { roles: ['demi-service-read'] } };
const IDIR = { identity_provider: 'idir' };

async function call(t, user, { row = ROW, id = ROW.id } = {}) {
  const read = t.mock.method(projects, 'getById', async () => structuredClone(row));
  t.mock.method(works, 'listForRead', async () => structuredClone([OPEN_WORK, WORK_1997, ENDED_WORK]));
  const res = mockRes();
  await getWorksStaff({ params: { id }, query: {}, user }, res);
  return { res, reads: read.mock.callCount() };
}

const workOf = (body, id) => body.works.find(work => work.workId === id);

test('staff GET returns the EPD for an open work, marked currentAsOf', async (t) => {
  const { res } = await call(t, STAFF);
  assert.strictEqual(res.statusCode, 200);
  const [contact] = workOf(res.body, OPEN_WORK.id).contacts;
  assert.strictEqual(contact.name, EPD.name);
  assert.strictEqual(contact.currentAsOf, EPD.observedAt);
});

test('staff GET returns no unknown-start EPD for a 1997 work', async (t) => {
  const { res } = await call(t, STAFF);
  const work = workOf(res.body, WORK_1997.id);
  assert.strictEqual(work.endDate, '1997-08-15');
  assert.deepStrictEqual(work.contacts, []);
});

test('a work with no decision date ends at its last phase', async (t) => {
  const { res } = await call(t, STAFF);
  const work = workOf(res.body, ENDED_WORK.id);
  assert.strictEqual(work.endDate, '2021-06-30');
  assert.deepStrictEqual(work.contacts, []);
});

test('a demi-service-read key gets the response', async (t) => {
  const { res } = await call(t, SERVICE_READ);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(workOf(res.body, OPEN_WORK.id).contacts.length, 1);
});

test('anonymous and idir calls are refused', async (t) => {
  const route = routes.find(r => r.method === 'get' && r.path === '/projects/:id/works-staff');
  assert.strictEqual(route.guards[0], authMiddleware);
  const anonymous = await call(t, undefined);
  const idir = await call(t, IDIR);
  assert.deepStrictEqual([anonymous.res.statusCode, idir.res.statusCode], [403, 403]);
  assert.deepStrictEqual([anonymous.reads, idir.reads], [0, 0], 'refused before the project is read');
});

test('a malformed project id is refused before any read', async (t) => {
  const { res, reads } = await call(t, STAFF, { id: '412/../x' });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(reads, 0);
});

test('an unreadable project is a 404', async (t) => {
  const { res } = await call(t, STAFF, { row: null });
  assert.strictEqual(res.statusCode, 404);
});

test('response carries no sourceKey or sheetKey', async (t) => {
  const { res } = await call(t, STAFF);
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes('sourceKey'));
  assert.ok(!text.includes('sheetKey'));
});

test('currentInvestment is the open track entry when track, eagle and sheet entries are open', async (t) => {
  const { res } = await call(t, STAFF);
  const { sheetKey: _sheetKey, ...expected } = investment('i-track', 'track');
  assert.deepStrictEqual(res.body.currentInvestment, expected);
});

test('a note tied to one work shows on that work only', async (t) => {
  const note = {
    id: 'n1', text: 'Example note', workId: WORK_1997.id, observedAt: '2026-11-01', source: 'demi',
    sheetKey: null, recordedAt: '2026-11-01T00:00:00.000Z'
  };
  const { res } = await call(t, STAFF, { row: { ...ROW, staffNotes: [note] } });
  const { sheetKey: _sheetKey, ...stored } = note;
  const notesByWork = res.body.works.map(work => [work.workId, work.notes]);
  assert.deepStrictEqual(notesByWork, [
    [OPEN_WORK.id, []], [WORK_1997.id, [{ ...stored, currentAsOf: note.observedAt }]], [ENDED_WORK.id, []]
  ]);
});

test('a row dial narrower than the caller withholds that staff list', async (t) => {
  const { res } = await call(t, SERVICE_READ, { row: { ...ROW, vis: { capitalInvestments: 1 } } });
  assert.strictEqual(res.body.currentInvestment, null);
  assert.deepStrictEqual(workOf(res.body, OPEN_WORK.id).investments, []);
});

const SHEET_WORK = {
  id: 'sheet-00000000-0000-4000-8000-000000000002', projectId: '412', source: 'sheet', owner: 'sheet', workTypeCode: 'amendment',
  title: 'Example 1999 amendment', decisionDate: '1999-04-01', phases: [],
  sourceKey: '412:amendment:1', sheetKey: 'sheet-row-7', provenance: { file: 'sample.xlsx', row: 7 }
};
const TRACK_WORK = { ...OPEN_WORK, source: 'track', trackWorkId: 9001, workTypeId: 7, decisionDate: '2024-06-01', phases: [] };
const MARKER = {
  id: 'sheet-override', projectId: '412', kind: 'override', source: 'sheet', owner: 'sheet', active: true,
  boundaryAtLoad: '2025-01-01', certificates: [{ actYear: 1996, certificateKind: 'EAC', decisionDate: '1998-01-01' }],
  hidden: [{ trackWorkId: TRACK_WORK.id, sheetWorkId: SHEET_WORK.id }],
  trackAlive: [{ trackWorkId: 'track-9003', sourceKey: '412:alive:1' }], untilTrack: [], pairedTrackWorkIds: [TRACK_WORK.id, 'track-9003'],
  batchId: 'batch-1', provenance: {}, schemaVersion: 1
};

async function callSheet(t, user, { id = ROW.id } = {}) {
  const read = t.mock.method(projects, 'getById', async () => structuredClone(ROW));
  t.mock.method(works, 'listForRead', async () => structuredClone([TRACK_WORK, SHEET_WORK]));
  t.mock.method(works, 'get', async () => structuredClone(MARKER));
  t.mock.method(phaseCatalog, 'load', async () => ({}));
  const res = mockRes();
  await getSheetWorks({ params: { id }, query: {}, user }, res);
  return { res, reads: read.mock.callCount() };
}

const ROUTER = require.resolve('../../../src/http/router');
const ROUTES = require.resolve('../../../src/http/routes');

/** Calls a router built as a deployment with ENVIRONMENT `environmentName`: routes.js reads it once at load. */
async function asDeployment(environmentName, fn) {
  const before = config.environmentName;
  const fresh = () => { delete require.cache[ROUTER]; delete require.cache[ROUTES]; };
  config.environmentName = environmentName;
  fresh();
  try {
    await withServer(fn);
  } finally {
    config.environmentName = before;
    fresh();
  }
}

test('sheet-works is not routed outside dev and test, token or not, and reaches auth on dev and test', async (t) => {
  const read = t.mock.method(projects, 'getById', async () => structuredClone(ROW));
  const results = [];
  const before = config.environmentName;
  for (const environmentName of ['prod', 'staging', 'dev', 'test']) {
    await asDeployment(environmentName, async (call) => {
      for (const headers of [{}, { authorization: 'Bearer not-a-token' }]) {
        results.push([environmentName, Boolean(headers.authorization), (await call(`/api/projects/${ROW.id}/sheet-works`, { headers })).status]);
      }
    });
  }
  assert.deepStrictEqual(results, [
    ['prod', false, 404], ['prod', true, 404], ['staging', false, 404], ['staging', true, 404],
    ['dev', false, 401], ['dev', true, 401], ['test', false, 401], ['test', true, 401]
  ]);
  assert.strictEqual(read.mock.callCount(), 0);
  assert.strictEqual(config.environmentName, before);
});

test('sheet-works refuses anonymous and idir calls, and a malformed id, before any read', async (t) => {
  const route = routes.find(r => r.method === 'get' && r.path === '/projects/:id/sheet-works');
  assert.strictEqual(route.guards[0], authMiddleware);
  const results = [];
  for (const [user, id] of [[undefined, ROW.id], [IDIR, ROW.id], [STAFF, '412/../x']]) {
    const { res, reads } = await callSheet(t, user, { id });
    results.push([res.statusCode, reads]);
    t.mock.restoreAll();
  }
  assert.deepStrictEqual(results, [[403, 0], [403, 0], [400, 0]]);
});

test('sheet-works returns only sheet works, with no staff entries, marker detail or source keys', async (t) => {
  const { res } = await callSheet(t, STAFF);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(Object.keys(res.body).sort(), ['boundary', 'overrideActive', 'projectId', 'works']);
  assert.deepStrictEqual(res.body.works.map(work => [work.workId, work.shownAfterFlip, work.replaces.map(r => r.workId)]),
    [[SHEET_WORK.id, true, [TRACK_WORK.id]]]);
  const text = JSON.stringify(res.body);
  for (const key of ['contacts', 'notes', 'investments', 'certificates', 'trackAlive', 'sourceKey', 'sheetKey', 'provenance', 'sample.xlsx', EPD.name]) {
    assert.ok(!text.includes(key), `${key} is left out`);
  }
});
