'use strict';

/**
 * Uploads the document intake has not released (`scanStatus` `pending` or `rejected`) never reach a
 * reader; rows with `clean` or no `scanStatus` do. No Cosmos runs here, so the SQL sent and the
 * point-read answer are the observable surface.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const documentsRepo = require('../../src/repositories/documents');
const datasource = require('../../azure/search/datasources/demi-documents-ds.json');

const { SCAN_CLEARED_CLAUSE, isScanCleared } = documentsRepo;
const PUBLIC = { tier: 'public', roles: ['public'] };
const ROW = { id: 'd1', projectId: '207', read: ['public'] };

function captureQueries(t) {
  const specs = [];
  t.mock.method(cosmos, 'query', async (_container, spec) => {
    specs.push(spec);
    return { items: [] };
  });
  t.mock.method(cosmos, 'queryValue', async (_container, spec) => {
    specs.push(spec);
    return 0;
  });
  t.mock.method(cosmos, 'queryFirst', async (_container, spec) => {
    specs.push(spec);
    return null;
  });
  return specs;
}

const pointRead = (t, row) => t.mock.method(cosmos, 'readItem', async () => row);

test('the clause and its JS twin agree on which rows are released', () => {
  assert.strictEqual(isScanCleared({ ...ROW }), true, 'no scanStatus: never went through intake');
  assert.strictEqual(isScanCleared({ ...ROW, scanStatus: null }), true);
  assert.strictEqual(isScanCleared({ ...ROW, scanStatus: 'clean' }), true);
  assert.strictEqual(isScanCleared({ ...ROW, scanStatus: 'pending' }), false);
  assert.strictEqual(isScanCleared({ ...ROW, scanStatus: 'rejected' }), false);
  assert.match(SCAN_CLEARED_CLAUSE, /NOT IS_STRING\(c\.scanStatus\) OR c\.scanStatus = 'clean'/);
});

test('the search datasource indexes only released rows, with the same clause', () => {
  assert.ok(datasource.container.query.includes(`WHERE c._ts >= @HighWaterMark AND ${SCAN_CLEARED_CLAUSE}`),
    datasource.container.query);
});

test('listVisible leaves unreleased uploads out', async (t) => {
  const specs = captureQueries(t);
  await documentsRepo.listVisible(PUBLIC, { projectId: '207' });
  assert.ok(specs[0].query.includes(SCAN_CLEARED_CLAUSE), specs[0].query);
});

test('countVisible counts what listVisible lists', async (t) => {
  const specs = captureQueries(t);
  await documentsRepo.countVisible(PUBLIC, {});
  assert.ok(specs[0].query.includes(SCAN_CLEARED_CLAUSE), specs[0].query);
});

test('the recent-uploads project ranking leaves them out', async (t) => {
  const specs = captureQueries(t);
  await documentsRepo.projectUploadMaxima(PUBLIC);
  assert.ok(specs[0].query.includes(SCAN_CLEARED_CLAUSE), specs[0].query);
});

test('the recent-uploads rows of a project leave them out', async (t) => {
  const specs = captureQueries(t);
  await documentsRepo.newestUploads(PUBLIC, '207');
  assert.ok(specs[0].query.includes(SCAN_CLEARED_CLAUSE), specs[0].query);
});

test('the chunk parent lookup leaves them out', async (t) => {
  const specs = captureQueries(t);
  await documentsRepo.listByIds(PUBLIC, ['d1'], ['207']);
  assert.ok(specs[0].query.includes(SCAN_CLEARED_CLAUSE), specs[0].query);
});

test('the bulk-download lookup leaves them out', async (t) => {
  const specs = captureQueries(t);
  await documentsRepo.listByIdsUnscoped(PUBLIC, ['d1'], 'c.id');
  assert.ok(specs[0].query.includes(SCAN_CLEARED_CLAUSE), specs[0].query);
});

test('getById by id alone leaves them out', async (t) => {
  const specs = captureQueries(t);
  await documentsRepo.getById(PUBLIC, 'd1');
  assert.ok(specs[0].query.includes(SCAN_CLEARED_CLAUSE), specs[0].query);
});

test('getById point read answers null for a pending upload', async (t) => {
  pointRead(t, { ...ROW, scanStatus: 'pending' });
  assert.strictEqual(await documentsRepo.getById(PUBLIC, 'd1', '207'), null);
});

test('getById point read answers null for a rejected upload', async (t) => {
  pointRead(t, { ...ROW, scanStatus: 'rejected' });
  assert.strictEqual(await documentsRepo.getById(PUBLIC, 'd1', '207'), null);
});

test('getById point read returns a clean upload', async (t) => {
  pointRead(t, { ...ROW, scanStatus: 'clean' });
  assert.strictEqual((await documentsRepo.getById(PUBLIC, 'd1', '207')).id, 'd1');
});

test('getById point read returns a row that never went through intake', async (t) => {
  pointRead(t, { ...ROW });
  assert.strictEqual((await documentsRepo.getById(PUBLIC, 'd1', '207')).id, 'd1');
});

test('the intake itself still finds the pending row it settles', async (t) => {
  const specs = captureQueries(t);
  await documentsRepo.getById(PUBLIC, 'd1', undefined, { includeUnscanned: true });
  assert.ok(!specs[0].query.includes(SCAN_CLEARED_CLAUSE), specs[0].query);
});
