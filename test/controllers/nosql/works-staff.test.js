'use strict';

// GET /projects/:id/works-staff: who may call it, and the staff entries each work gets.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const projects = require('../../../src/repositories/projects');
const works = require('../../../src/repositories/works');
const routes = require('../../../src/http/routes');
const authMiddleware = require('../../../src/middleware/auth');
const { getWorksStaff } = require('../../../src/controllers/nosql/works-staff');
const { mockRes } = require('../../helpers/mock-res');

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

const STAFF = { realm_access: { roles: ['staff'] } };
const SERVICE_READ = { realm_access: { roles: ['demi-service-read'] } };
const IDIR = { identity_provider: 'idir' };

async function call(t, user, { row = ROW, id = ROW.id } = {}) {
  const read = t.mock.method(projects, 'getById', async () => structuredClone(row));
  t.mock.method(works, 'listForRead', async () => structuredClone([OPEN_WORK, WORK_1997]));
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

test('response carries no sourceKey or sheetKey', async (t) => {
  const { res } = await call(t, STAFF);
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes('sourceKey'));
  assert.ok(!text.includes('sheetKey'));
});

test('currentInvestment is the open track entry when track, eagle and sheet entries are open', async (t) => {
  const { res } = await call(t, STAFF);
  assert.strictEqual(res.body.currentInvestment.id, 'i-track');
});

test('a note tied to one work shows on that work only', async (t) => {
  const note = {
    id: 'n1', text: 'Example note', workId: WORK_1997.id, effectiveFrom: '1990-01-01', effectiveTo: null,
    observedAt: '2026-11-01', source: 'demi', sheetKey: null, recordedAt: '2026-11-01T00:00:00.000Z'
  };
  const { res } = await call(t, STAFF, { row: { ...ROW, staffNotes: [note] } });
  assert.deepStrictEqual(workOf(res.body, WORK_1997.id).notes.map(entry => entry.id), ['n1']);
  assert.deepStrictEqual(workOf(res.body, OPEN_WORK.id).notes, []);
});

test('a row dial narrower than the caller withholds that staff list', async (t) => {
  const { res } = await call(t, SERVICE_READ, { row: { ...ROW, vis: { capitalInvestments: 1 } } });
  assert.strictEqual(res.body.currentInvestment, null);
  assert.deepStrictEqual(workOf(res.body, OPEN_WORK.id).investments, []);
});
