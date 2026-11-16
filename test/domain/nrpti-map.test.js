'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { mapRecord, mapMine } = require('../../src/domain/nrpti-map');
const { PUBLIC_READ } = require('../../src/domain/_write');

const SYNCED_AT = '2026-11-16T10:30:00.000Z';
const SITE_C = '588511a0aaecd9001b82316d';
const COASTAL_GASLINK = '588511c4aaecd9001b825604';
const KEMESS_UNDERGROUND = '588511e6aaecd9001b8278ae';
const KEMESS_SOUTH = '5885100caaecd9001b80a4b7';
const LINKS = new Map([[COASTAL_GASLINK, 'track-41'], [SITE_C, 'track-7'], [KEMESS_UNDERGROUND, 'track-88']]);

const RECORD_KEYS = ['documents', 'eagleId', 'id', 'issuedAt', 'issuedTo', 'issuingAgency', 'kind', 'projectId', 'read',
  'source', 'subtype', 'summary', 'syncedAt', 'title'];
const MINE_KEYS = ['commodities', 'description', 'eagleId', 'id', 'links', 'location', 'mineId', 'mineNo', 'name',
  'permitNumber', 'permittee', 'projectId', 'read', 'region', 'source', 'status', 'summary', 'syncedAt',
  'tailingsImpoundments', 'type'];

// Real rows from the NRPTI public search, trimmed.
const order = (fields) => ({
  _id: '5ebaecdb0c09f47591a9beb9', _schemaName: 'Order', _epicProjectId: COASTAL_GASLINK, __v: 3,
  _flavourRecords: ['5ebaecdb0c09f47591a9bd3e'], recordName: 'Section 34 Order - Endangered Plants and Ecosystems',
  recordType: 'Order', recordSubtype: '', dateIssued: '2019-02-20T08:00:00.000Z', issuingAgency: 'AGENCY_EAO',
  projectName: 'Coastal Gaslink', dateUpdated: '2020-05-12T18:37:15.975Z', sourceSystemRef: 'lng-csv',
  read: ['sysadmin', 'public', 'admin:lng'], write: ['sysadmin', 'admin:lng'],
  issuedTo: { firstName: 'Unpublished', lastName: 'Unpublished', fullName: 'Unpublished', dateOfBirth: null },
  documents: [{
    _id: '5ebaecda0c09f47591a9bbef', fileName: 'Section 34 Order - Endangered Plants and Ecosystems', key: null,
    url: 'https://projects.eao.gov.bc.ca/api/document/5c89200af6240c00242594d3/fetch',
    read: ['sysadmin', 'public', 'admin:lng'], write: ['sysadmin', 'admin:lng']
  }],
  flavours: [{
    _schemaName: 'OrderLNG', read: ['public', 'sysadmin', 'admin:lng'],
    description: 'Order issued relating to Condition 17 of Schedule B to EAC E14-03.'
  }],
  ...fields
});
const epicInspection = {
  _id: '5ebaed13516bac001aefe5ca', _schemaName: 'Inspection', _epicProjectId: SITE_C, sourceSystemRef: 'epic',
  recordName: 'Inspection Record - 2015-09-23', projectName: 'Site C Clean Energy', dateIssued: '2016-06-21T19:00:00.000Z',
  issuedTo: { companyName: 'BC Hydro and Power Authority', fullName: 'BC Hydro and Power Authority', type: 'Company' }
};
const kemess = (fields) => ({
  _id: '5fa1e4124635c865df00cead', _schemaName: 'MineBCMI', _sourceRefId: '110877b6-7358-4e79-8daa-cee520052a72',
  _epicProjectIds: [KEMESS_SOUTH, KEMESS_UNDERGROUND], name: 'Kemess Mine', permitNumber: 'M-206', showPermitNumber: true,
  status: 'Closed Care & Maintenance', type: 'Metal', commodities: ['Copper', 'Copper', 'Gold'], tailingsImpoundments: 1,
  region: 'NE', location: { coordinates: [-126.7640131, 56.9930695], _id: '5fa33705a2d05f00210dd9c8', type: 'Point' },
  permittee: 'AuRico Metals Inc.', summary: '<p>Kemess property summary.</p>', description: 'Kemess property.',
  mineNo: '1300244', dateUpdated: '2026-11-16T10:04:43.625Z', sourceSystemRef: 'core', __v: 1829,
  links: [{ url: 'https://centerragold.com/operations/kemess/kemess-underground-project', title: 'Kemess Underground Project' }],
  read: ['public', 'sysadmin'], write: ['sysadmin'],
  ...fields
});

test('a linked record maps to a regulatory record on the linked project', () => {
  const { row } = mapRecord(order(), 'Order', LINKS, SYNCED_AT);
  assert.strictEqual(row.id, 'nrpti-5ebaecdb0c09f47591a9beb9');
  assert.strictEqual(row.projectId, 'track-41');
  assert.strictEqual(row.kind, 'order');
  assert.deepStrictEqual(row.documents, [{
    fileName: 'Section 34 Order - Endangered Plants and Ecosystems',
    url: 'https://projects.eao.gov.bc.ca/api/document/5c89200af6240c00242594d3/fetch'
  }]);
});

test('a record row has exactly the DEMI fields, none copied from upstream', () => {
  const { row } = mapRecord(order(), 'Order', LINKS, SYNCED_AT);
  assert.deepStrictEqual(Object.keys(row).sort(), RECORD_KEYS);
});

test('a record is readable by public and staff only, whatever NRPTI says', () => {
  const { row } = mapRecord(order({ read: ['sysadmin', 'admin:lng'] }), 'Order', LINKS, SYNCED_AT);
  assert.deepStrictEqual(row.read, [...PUBLIC_READ]);
});

test('a record copied from Eagle is skipped even when its project is linked', () => {
  assert.deepStrictEqual(mapRecord(epicInspection, 'Inspection', LINKS, SYNCED_AT), { reason: 'eagleOrigin' });
});

test('a record with a project name but no EPIC id is dropped, not matched by name', () => {
  const byName = new Map([...LINKS, ['Coastal Gaslink', 'track-41']]);
  const result = mapRecord(order({ _epicProjectId: null }), 'Order', byName, SYNCED_AT);
  assert.deepStrictEqual(result, { reason: 'noEpicId' });
});

test('a record whose EPIC id has no DEMI project is dropped as unknown', () => {
  const result = mapRecord(order({ _epicProjectId: '000000000000000000000000' }), 'Order', LINKS, SYNCED_AT);
  assert.deepStrictEqual(result, { reason: 'unknownEpicId' });
});

test('NRPTI\'s Unpublished placeholder is not stored as the name a record was issued to', () => {
  const { row } = mapRecord(order(), 'Order', LINKS, SYNCED_AT);
  assert.strictEqual(row.issuedTo, null);
});

test('a mine naming two EPIC projects, one linked, gives one row for that project', () => {
  const { rows } = mapMine(kemess(), LINKS, SYNCED_AT);
  assert.deepStrictEqual(rows.map(r => [r.id, r.projectId, r.eagleId]), [
    ['110877b6-7358-4e79-8daa-cee520052a72:track-88', 'track-88', KEMESS_UNDERGROUND]
  ]);
});

test('a mine row has exactly the DEMI fields and public read', () => {
  const [row] = mapMine(kemess(), LINKS, SYNCED_AT).rows;
  assert.deepStrictEqual(Object.keys(row).sort(), MINE_KEYS);
  assert.deepStrictEqual(row.read, [...PUBLIC_READ]);
  assert.deepStrictEqual(row.location, { type: 'Point', coordinates: [-126.7640131, 56.9930695] });
});

test('a mine with a name but no EPIC ids is dropped', () => {
  assert.deepStrictEqual(mapMine(kemess({ _epicProjectIds: [] }), LINKS, SYNCED_AT), { reason: 'noEpicId' });
});

test('a mine whose EPIC ids all lack a DEMI project is dropped as unknown', () => {
  assert.deepStrictEqual(mapMine(kemess({ _epicProjectIds: [KEMESS_SOUTH] }), LINKS, SYNCED_AT), { reason: 'unknownEpicId' });
});

test('a mine whose owner hid the permit number keeps it hidden', () => {
  const [row] = mapMine(kemess({ showPermitNumber: false }), LINKS, SYNCED_AT).rows;
  assert.strictEqual(row.permitNumber, null);
});
