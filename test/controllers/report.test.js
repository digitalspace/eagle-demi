'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

// First, before anything loads the logger: its uncaughtException handler turns a failed require
// into a passing file.
const controller = require('../../src/controllers/report');
const projects = require('../../src/repositories/projects');

/**
 * Header and two rows of eagle-api's own `GET /api/reports?type=bcgw` (eagle-test, 2026-10-06),
 * byte for byte: one complete row, and one with a comma-bearing description and no decision date.
 */
const EAGLE_CSV = [
  'Latitude,Longitude,Project name,Proponent,Type,Sub-Type,Description,MOE Region,Project Phase,Legislation,Federal Involvement,EA Decision,Decision Date,URL to Epic Project,Project GUID',
  '49.33912,-117.77193,Keenleyside Powerplant,Columbia Power Corporation,Energy-Electricity,Power Plants,Name change. Now known as Arrow Lakes Generating Station.,Kootenay,Post Decision - Operation,1996 Environmental Assessment Act,None,Certificate Issued,04-27-1998,https://projects.eao.gov.bc.ca/p/58850ff0aaecd9001b8089c1/project-details,"""58850ff0aaecd9001b8089c1"""',
  '49.645,-121.053,Coquihalla Pass Resort Development,Westscapes Development Incorporated,Tourist Destination Resorts,Ski Resorts,"Proposed all season resort located near the summit of the Coquihalla Highway. Resort will consist of base village, golf course, ski lifts, alpine trails, and an ecotourism area",Thompson-Nicola,Pre-Application,2002 Environmental Assessment Act,Comp Study - Unconfirmed,In Progress,,https://projects.eao.gov.bc.ca/p/588510ecaaecd9001b817c67/project-details,"""588510ecaaecd9001b817c67"""',
  ''
].join('\n');

/** The same two projects as DEMI stores them after the eagle-api push. */
const DEMI_ROWS = [
  {
    id: '1001', eagleId: '58850ff0aaecd9001b8089c1', read: ['public', 'staff'], isPublished: true,
    centroid: { type: 'Point', coordinates: [-117.77193, 49.33912] },
    name: 'Keenleyside Powerplant', proponentName: 'Columbia Power Corporation',
    projectType: 'Energy-Electricity', sector: 'Power Plants',
    description: 'Name change. Now known as Arrow Lakes Generating Station.', region: 'Kootenay',
    currentPhaseName: { _id: '5cf00c03a266b7e1877504ef', name: 'Post Decision - Operation' },
    legislation: '1996 Environmental Assessment Act',
    CEAAInvolvement: { _id: '5df79dd77b5abbf7da6f51c0', name: 'None' },
    eacDecision: { _id: '5cf00c03a266b7e1877504f5', name: 'Certificate Issued' },
    decisionDate: '1998-04-27T07:00:00.000Z',
    projectLeadEmail: 'lead@example.gov.bc.ca'
  },
  {
    id: '1002', eagleId: '588510ecaaecd9001b817c67', read: ['public', 'staff'], isPublished: true,
    centroid: { type: 'Point', coordinates: [-121.053, 49.645] },
    name: 'Coquihalla Pass Resort Development', proponentName: 'Westscapes Development Incorporated',
    projectType: 'Tourist Destination Resorts', sector: 'Ski Resorts',
    description: 'Proposed all season resort located near the summit of the Coquihalla Highway. ' +
      'Resort will consist of base village, golf course, ski lifts, alpine trails, and an ecotourism area',
    region: 'Thompson-Nicola',
    currentPhaseName: { _id: '5cf00c03a266b7e1877504e9', name: 'Pre-Application' },
    legislation: '2002 Environmental Assessment Act',
    CEAAInvolvement: { _id: '5df79dd77b5abbf7da6f51c4', name: 'Comp Study - Unconfirmed' },
    eacDecision: { _id: '5cf00c03a266b7e1877504f4', name: 'In Progress' },
    decisionDate: null
  }
];

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    json(data) { this.body = data; return this; },
    send(body) { this.body = body; return this; }
  };
}

test('BCGW report', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('matches the eagle-api feed field for field', async () => {
    t.mock.method(projects, 'listPage', async () => structuredClone(DEMI_ROWS));
    const res = mockRes();
    await controller.getReport({ query: { type: 'bcgw' }, headers: {} }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body, EAGLE_CSV);
    assert.strictEqual(res.headers['content-disposition'], 'attachment; filename=export_bcgw.csv');
  });

  await t.test('reads as the public whoever asks', async () => {
    const seen = [];
    t.mock.method(projects, 'listPage', async (access) => { seen.push(access); return []; });
    const res = mockRes();
    await controller.getReport(
      { query: { type: 'bcgw' }, headers: {}, user: { realm_access: { roles: ['sysadmin'] } } }, res);

    assert.strictEqual(seen[0].level, 4);
    assert.deepStrictEqual(seen[0].roles, ['public']);
  });

  await t.test('a missing or unknown type is a 400', async () => {
    const missing = mockRes();
    await controller.getReport({ query: {}, headers: {} }, missing);
    const unknown = mockRes();
    await controller.getReport({ query: { type: 'toString' }, headers: {} }, unknown);

    assert.strictEqual(missing.statusCode, 400);
    assert.strictEqual(unknown.statusCode, 400);
  });
});
