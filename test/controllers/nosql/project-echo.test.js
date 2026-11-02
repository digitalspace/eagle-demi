'use strict';

// A project made by `POST /projects` has no `sources.track`; once staff give it an Eagle id, Eagle's
// pushes for that id must land on it, not on a new `eagle-<id>` row beside it.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const audit = require('../../../src/utils/audit');
const projects = require('../../../src/repositories/projects');
const documents = require('../../../src/repositories/documents');
const aiSearch = require('../../../src/search/ai-search');
const projectController = require('../../../src/controllers/nosql/project');
const { deletedBy } = require('../../../src/merge/project');
const {
  mockRes, STAFF, PROJECT_EAGLE_ID, PUBLIC_ACL, eagleProject, projectReadForWriteFromGet
} = require('../../helpers/eagle-mirror-fixtures');

audit._setTransport(async () => {});

const SYNC_OUT = Object.freeze({ eagle: { status: 'sent', sentVersion: 1, sentAt: '2026-11-01T00:00:00.000Z' } });
const CENTROID = Object.freeze({ type: 'Point', coordinates: [-123.1, 49.2] });
const CREATED_AT = '2026-10-01T00:00:00.000Z';

/** The `createProject` shape, after a staff PUT gave it the Eagle id. */
function nativeRow(overrides = {}) {
  return {
    id: '1234',
    trackProjectId: 1234,
    eagleId: PROJECT_EAGLE_ID,
    sourceSystem: 'track',
    name: 'Nicomen Wind Energy (DEMI)',
    description: '',
    centroid: structuredClone(CENTROID),
    read: [...PUBLIC_ACL],
    isPublished: true,
    sources: {},
    syncOut: structuredClone(SYNC_OUT),
    syncVersion: 1,
    createdAt: CREATED_AT,
    ...overrides
  };
}

/** Serve `stored` as the only row on the Eagle id; record every row the controller wrote. */
function stage(t, stored) {
  const writes = [];
  t.mock.method(projects, 'getByEagleId', async () => structuredClone(stored));
  t.mock.method(projects, 'getById', async () => structuredClone(stored));
  t.mock.method(projects, 'readForWrite', async () => null);
  t.mock.method(projects, 'upsert', async (item) => { writes.push(item); return item; });
  t.mock.method(projects, 'patchCascadePending', async () => {});
  t.mock.method(aiSearch, 'writeAcls', async (_index, rows) => rows.length);
  t.mock.method(documents, 'setAclForProject', async () => ({ succeeded: 1, failed: 0, rows: [] }));
  return writes;
}

async function push(doc) {
  const res = mockRes();
  await projectController.upsertFromEagle({
    params: { eagleId: PROJECT_EAGLE_ID }, query: {}, user: STAFF, body: { doc }
  }, res);
  return res;
}

test('an Eagle push for a DEMI-created project', async (t) => {
  t.beforeEach(() => projectReadForWriteFromGet(t));
  t.afterEach(() => t.mock.restoreAll());

  await t.test('lands on the DEMI row, which keeps the fields DEMI owns', async () => {
    const writes = stage(t, nativeRow());

    const res = await push(eagleProject({
      description: 'Eagle text', status: 'Under Construction', eacDecision: 'Certificate Issued'
    }));

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(writes.map(row => row.id), ['1234'], `no eagle-${PROJECT_EAGLE_ID} row`);
    const [row] = writes;
    assert.strictEqual(row.sourceSystem, 'track');
    assert.strictEqual(row.trackProjectId, 1234);
    assert.strictEqual(row.eagleId, PROJECT_EAGLE_ID);
    assert.strictEqual(row.name, 'Nicomen Wind Energy (DEMI)', 'DEMI value beats Eagle value');
    assert.strictEqual(row.description, '', 'an empty DEMI value is not filled from Eagle');
    assert.ok(!('projectState' in row), 'an absent DEMI value is not filled from Eagle');
    assert.deepStrictEqual(row.centroid, CENTROID);
    assert.strictEqual(row.createdAt, CREATED_AT);
    assert.strictEqual(row.eacDecision, 'Certificate Issued', 'Eagle-only fields merge on top');
    assert.deepStrictEqual(Object.keys(row.sources), ['eagle']);
    assert.deepStrictEqual({ syncOut: row.syncOut, syncVersion: row.syncVersion },
      { syncOut: SYNC_OUT, syncVersion: 1 });
  });

  await t.test('with isDeleted marks the DEMI row deleted by Eagle', async () => {
    const writes = stage(t, nativeRow());

    await push(eagleProject({ isDeleted: true }));

    const [row] = writes;
    assert.strictEqual(row.id, '1234');
    assert.strictEqual(row.isDeleted, true);
    assert.strictEqual(deletedBy(row), 'eagle');
    assert.ok(!row.read.includes('public'));
  });

  await t.test('without isDeleted restores a row Eagle deleted', async () => {
    const writes = stage(t, nativeRow({
      isDeleted: true, read: ['staff', 'sysadmin'], isPublished: false,
      sources: { eagle: { _id: PROJECT_EAGLE_ID, isDeleted: true } }
    }));

    await push(eagleProject());

    const [row] = writes;
    assert.strictEqual(row.id, '1234');
    assert.strictEqual(deletedBy(row), null);
    assert.ok(row.read.includes('public'));
  });

  await t.test('keeps a DEMI delete standing', async () => {
    const writes = stage(t, nativeRow({ isDeleted: true, read: ['staff', 'sysadmin'], isPublished: false }));

    await push(eagleProject());

    const [row] = writes;
    assert.strictEqual(row.id, '1234');
    assert.strictEqual(deletedBy(row), 'demi');
    assert.ok(!row.read.includes('public'));
  });
});

test('a legislation year switch on a DEMI-created project keeps the fields DEMI owns', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const eagle = {
    _id: PROJECT_EAGLE_ID,
    read: [...PUBLIC_ACL],
    currentLegislationYear: 'legislation_2002',
    legislationYearList: [2002, 2018],
    legislation_2002: { name: 'Mine 2002', legislationYear: 2002 },
    legislation_2018: { name: 'Mine 2018', legislationYear: 2018 }
  };
  const writes = stage(t, nativeRow({ legislationYear: 2002, sources: { eagle }, _etag: '"0x1"' }));

  const res = mockRes();
  await projectController.setLevel({
    params: { id: '1234' }, query: {}, user: { realm_access: { roles: ['demi-service-write'] } },
    body: { level: 4, confirm: true, reason: 'switch Act', legislationYear: 2018 }
  }, res);

  assert.strictEqual(res.statusCode, 200);
  const [row] = writes;
  assert.strictEqual(row.legislationYear, 2018);
  assert.strictEqual(row.name, 'Nicomen Wind Energy (DEMI)');
  assert.strictEqual(row.sourceSystem, 'track');
});
