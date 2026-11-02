'use strict';

// A project DEMI created reaches Eagle through sync-out under the id it minted, and eagle-api pushes
// it back. That echo must land on the DEMI row, not on a new `eagle-<id>` one beside it.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const projects = require('../../../src/repositories/projects');
const documents = require('../../../src/repositories/documents');
const aiSearch = require('../../../src/search/ai-search');
const projectController = require('../../../src/controllers/nosql/project');
const { deletedBy } = require('../../../src/merge/project');
const {
  mockRes, STAFF, PROJECT_EAGLE_ID, PUBLIC_ACL, eagleProject, projectReadForWriteFromGet
} = require('../../helpers/eagle-mirror-fixtures');

const SYNC_OUT = Object.freeze({ eagle: { status: 'sent', sentVersion: 1, sentAt: '2026-11-01T00:00:00.000Z' } });

function nativeRow() {
  return {
    id: '1234',
    sourceSystem: 'demi',
    trackProjectId: null,
    eagleId: PROJECT_EAGLE_ID,
    name: 'Nicomen Wind Energy (DEMI)',
    read: [...PUBLIC_ACL],
    isPublished: true,
    sources: {},
    syncOut: structuredClone(SYNC_OUT),
    syncVersion: 1
  };
}

/** Serve `stored` as the only row on the Eagle id; record every row the controller wrote. */
function stage(t, stored) {
  const writes = [];
  t.mock.method(projects, 'getByEagleId', async () => structuredClone(stored));
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

test('the Eagle echo of a DEMI-created project', async (t) => {
  t.beforeEach(() => projectReadForWriteFromGet(t));
  t.afterEach(() => t.mock.restoreAll());

  await t.test('lands on the DEMI row with its identity and sync-out state', async () => {
    const writes = stage(t, nativeRow());

    const res = await push(eagleProject({ name: 'Nicomen Wind Energy', eacDecision: 'Certificate Issued' }));

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(writes.map(row => row.id), ['1234'], `no eagle-${PROJECT_EAGLE_ID} row`);
    const [row] = writes;
    assert.strictEqual(row.sourceSystem, 'demi');
    assert.strictEqual(row.trackProjectId, null);
    assert.strictEqual(row.eagleId, PROJECT_EAGLE_ID);
    assert.strictEqual(row.name, 'Nicomen Wind Energy (DEMI)', 'DEMI holds the Track-owned fields');
    assert.strictEqual(row.eacDecision, 'Certificate Issued', 'Eagle-only fields merge on top');
    assert.strictEqual(row.sources.eagle._id, PROJECT_EAGLE_ID);
    assert.deepStrictEqual({ syncOut: row.syncOut, syncVersion: row.syncVersion },
      { syncOut: SYNC_OUT, syncVersion: 1 });
  });

  await t.test('with isDeleted marks the DEMI row deleted by Eagle', async () => {
    const writes = stage(t, nativeRow());

    const res = await push(eagleProject({ isDeleted: true }));

    assert.strictEqual(res.statusCode, 200);
    const [row] = writes;
    assert.strictEqual(row.id, '1234');
    assert.strictEqual(row.isDeleted, true);
    assert.strictEqual(deletedBy(row), 'eagle');
    assert.ok(!row.read.includes('public'));
  });
});
