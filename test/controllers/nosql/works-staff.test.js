'use strict';

// GET /projects/:id/works-staff, /projects/:id/sheet-works, /sheet-works/summary and /workplans: who may call them, and what each carries.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../../../src/config');
const phaseCatalog = require('../../../src/domain/phase-catalog');
const projects = require('../../../src/repositories/projects');
const works = require('../../../src/repositories/works');
const { resolveAccess } = require('../../../src/helpers/access-sql');
const { ID_BATCH } = require('../../../src/domain/works-derive');
const routes = require('../../../src/http/routes');
const authMiddleware = require('../../../src/middleware/auth');
const { getSheetWorks, getSheetWorksSummary, getWorkplans, getWorksStaff } = require('../../../src/controllers/nosql/works-staff');
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

const SHEET_INFO = { certificateKind: 'PAC', complexityCode: 'typical', transitionIn: { fromActYear: 1996, date: '1999-01-01' } };
const SHEET_WORK = {
  id: 'sheet-00000000-0000-4000-8000-000000000002', projectId: '412', source: 'sheet', owner: 'sheet', workTypeCode: 'amendment',
  title: 'Example 1999 amendment', decisionDate: '1999-04-01', phases: [], ...SHEET_INFO,
  transitionIn: { ...SHEET_INFO.transitionIn, dateSource: 'split' },
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

test('the sheet-works and workplans paths are not routed outside dev and test, token or not, and reach auth on dev and test', async (t) => {
  const reads = [t.mock.method(projects, 'getById', async () => structuredClone(ROW)),
    t.mock.method(projects, 'listByIds', async () => [structuredClone(ROW)])];
  const results = [];
  const before = config.environmentName;
  const urls = [`/api/projects/${ROW.id}/sheet-works`, '/api/sheet-works/summary', '/api/workplans'];
  for (const url of urls) {
    for (const environmentName of ['prod', 'staging', 'dev', 'test']) {
      await asDeployment(environmentName, async (call) => {
        for (const headers of [{}, { authorization: 'Bearer not-a-token' }]) {
          results.push([url, environmentName, Boolean(headers.authorization), (await call(url, { headers })).status]);
        }
      });
    }
  }
  const expected = [
    ['prod', false, 404], ['prod', true, 404], ['staging', false, 404], ['staging', true, 404],
    ['dev', false, 401], ['dev', true, 401], ['test', false, 401], ['test', true, 401]
  ];
  assert.deepStrictEqual(results, urls.flatMap(url => expected.map(row => [url, ...row])));
  assert.deepStrictEqual(reads.map(read => read.mock.callCount()), [0, 0]);
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

// Project 999 has sheet works the caller's projects read does not return.
async function callSummary(t, user, { handler = getSheetWorksSummary, track = TRACK_WORK, sheet = SHEET_WORK } = {}) {
  const stored = [track, { ...sheet, actYear: 1996 }, { ...SHEET_WORK, projectId: '999', actYear: 2002 }];
  const reads = [t.mock.method(works, 'liveProjectIds', async () => ['412', '999', '412']),
    t.mock.method(projects, 'listByIds', async () => [{ id: ROW.id, name: ROW.name }])];
  t.mock.method(works, 'listForReadAcross', async (ids) => structuredClone(stored.filter(work => ids.includes(work.projectId))));
  t.mock.method(works, 'getEach', async (ids) => [structuredClone(MARKER)].filter(marker => ids.includes(marker.projectId)));
  t.mock.method(phaseCatalog, 'load', async () => ({}));
  const res = mockRes();
  await handler({ params: {}, query: {}, user }, res);
  return { res, reads: reads.map(read => read.mock.callCount()), projectReads: reads[1].mock.calls.map(call => call.arguments) };
}

test('sheet-works summary and workplans refuse anonymous and idir calls before any read', async (t) => {
  const handlers = [['/sheet-works/summary', getSheetWorksSummary], ['/workplans', getWorkplans]];
  const results = [];
  for (const [path, handler] of handlers) {
    const route = routes.find(r => r.method === 'get' && r.path === path);
    for (const user of [undefined, IDIR]) {
      const { res, reads } = await callSummary(t, user, { handler });
      results.push([route.guards[0] === authMiddleware, res.statusCode, reads]);
      t.mock.restoreAll();
    }
  }
  assert.deepStrictEqual(results, handlers.flatMap(() => [[true, 403, [0, 0]], [true, 403, [0, 0]]]));
});

test('sheet-works summary gives counts only, for the projects the caller may read', async (t) => {
  const { res, projectReads } = await callSummary(t, STAFF);
  assert.deepStrictEqual(projectReads.map(([access, ids]) => [access, new Set(ids)]),
    [[resolveAccess({ user: STAFF }), new Set(['412', '999'])]]);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body,
    { projects: [{ projectId: '412', act1996: 1, act2002: 0, hidden: 0, replaces: 1, untilTrack: 0 }] });
  const text = JSON.stringify(res.body);
  for (const key of [SHEET_WORK.title, TRACK_WORK.title, ROW.name, EPD.name]) assert.ok(!text.includes(key), `${key} is left out`);
});

const milestone = (eventType, actualDate, numberOfDays, anticipatedDate = null) =>
  ({ eventType, actualDate, anticipatedDate, numberOfDays });

test('workplans gives every work of the projects the caller may read, Track rows never replacing', async (t) => {
  const done = {
    trackName: 'Early Engagement', startDate: '2024-03-01', endDate: '2024-09-01', numberOfDays: 184, sortOrder: 2,
    isCompleted: true, isSuspended: false, suspendedDate: null, trackPhaseId: 55, interruptions: [],
    milestones: [milestone(10, '2024-04-01', 30), milestone(10, null, 99), milestone(14, '2024-08-01', null, '2024-08-01')]
  };
  const open = {
    trackName: 'Process Planning', startDate: '2024-09-01', endDate: '2025-01-01', numberOfDays: 122, sortOrder: 3,
    isCompleted: false, isSuspended: true, suspendedDate: '2024-11-01', trackPhaseId: 56,
    milestones: [milestone(38, '2024-10-15', 14), milestone(14, null, null, '2025-06-01')],
    interruptions: [{ id: 'x1', kind: 'suspension', typeCode: 'S', legalSection: 's.30', startDate: '2024-05-01', endDate: null, days: null }]
  };
  const sheetPhase = {
    id: 'pre-application', catalogId: 'list-9', name: 'Pre-Application', startDate: '1997-01-01', endDate: '1998-01-01',
    sortOrder: 1, isCompleted: true,
    interruptions: [{ kind: 'extension', days: 20 }, { kind: 'extension', days: 10 }, { kind: 'suspension', days: null }]
  };
  const { res, projectReads } = await callSummary(t, STAFF, { handler: getWorkplans,
    track: { ...TRACK_WORK, ...SHEET_INFO, currentWorkPhaseId: 56, phases: [done, open] }, sheet: { ...SHEET_WORK, phases: [sheetPhase] } });
  assert.deepStrictEqual(projectReads, [[resolveAccess({ user: STAFF }), ['412', '999']]]);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.works.map(work => [work.projectId, work.workId, work.source]),
    [['412', TRACK_WORK.id, 'track'], ['412', SHEET_WORK.id, 'sheet']]);
  const [track, sheet] = res.body.works;
  assert.deepStrictEqual([track.shownAfterFlip, track.untilTrack, track.replaces], [false, false, []]);
  assert.deepStrictEqual(sheet.replaces.map(work => work.workId), [TRACK_WORK.id]);
  assert.deepStrictEqual(Object.keys(track), ['projectId', 'projectName', 'workId', 'source', 'title', 'workTypeCode',
    'workType', 'actYear', 'workState', 'isActive', 'startDate', 'decisionDate', 'anticipatedDecisionDate', 'outcome',
    'transitionOut', 'undated', 'shownAfterFlip', 'untilTrack', 'replaces', 'decisionEventDate', 'certificateKind', 'complexityCode',
    'transitionIn', 'phases']);
  assert.deepStrictEqual([track.decisionEventDate, sheet.decisionEventDate], ['2025-06-01', null]);
  const sheetInfo = (work) => [work.certificateKind, work.complexityCode, work.transitionIn];
  assert.deepStrictEqual([sheetInfo(track), sheetInfo(sheet)], [[null, null, null], Object.values(SHEET_INFO)]);
  assert.deepStrictEqual(track.phases, [{
    name: 'Early Engagement', stage: null, order: 2, startDate: '2024-03-01', endDate: '2024-09-01', numberOfDays: 184,
    isCompleted: true, isSuspended: false, suspendedDate: null, undated: null,
    isCurrent: false, extensionDays: 30, suspendedDays: 0, interruptions: []
  }, {
    name: 'Process Planning', stage: null, order: 3, startDate: '2024-09-01', endDate: '2025-01-01', numberOfDays: 122,
    isCompleted: false, isSuspended: true, suspendedDate: '2024-11-01', undated: null,
    isCurrent: true, extensionDays: 0, suspendedDays: 14,
    interruptions: [{ kind: 'suspension', legalSection: 's.30', startDate: '2024-05-01', endDate: null, days: null }]
  }]);
  assert.deepStrictEqual(sheet.phases.map(p => [p.isCurrent, p.suspendedDate, p.extensionDays, p.suspendedDays]),
    [[null, null, 30, null]]);
});

test('workplans reads every project past the first id batch', async (t) => {
  const ids = Array.from({ length: ID_BATCH * 2 + 1 }, (_, i) => String(1000 + i));
  t.mock.method(works, 'liveProjectIds', async () => ids);
  t.mock.method(projects, 'listByIds', async (access, batch) => batch.map(id => ({ id, name: `Project ${id}` })));
  t.mock.method(works, 'listForReadAcross', async (batch) => batch.map(projectId => ({ ...SHEET_WORK, projectId })));
  t.mock.method(works, 'getEach', async () => []);
  t.mock.method(phaseCatalog, 'load', async () => ({}));
  const res = mockRes();
  await getWorkplans({ params: {}, query: {}, user: STAFF }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.works.map(work => work.projectId), ids);
});
