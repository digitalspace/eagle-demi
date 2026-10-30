'use strict';

// A deleted project keeps its row for staff and reconcile, but leaves `public` out of read[], so the
// anonymous GET /projects/:id answers 404 and the project drops from public lists and search.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const projects = require('../../../src/repositories/projects');
const documents = require('../../../src/repositories/documents');
const aiSearch = require('../../../src/search/ai-search');
const projectController = require('../../../src/controllers/nosql/project');
const { canRead } = require('../../../src/helpers/access-sql');
const {
  mockRes, STAFF, PROJECT_EAGLE_ID, anonymous, staff, eagleProject, storedEagleProject,
  projectReadForWriteFromGet
} = require('../../helpers/eagle-mirror-fixtures');

/** What eagle-api sends: the raw Mongo record, content under its block, the flag on the top level. */
function rawEagleProject(top = {}) {
  const { _id, read, ...content } = eagleProject();
  return { _id, read, currentLegislationYear: 'legislation_2018', legislation_2018: content, ...top };
}

/** Stub the stored row and the visibility cascade; record what the controller wrote and indexed. */
function stage(t, stored) {
  const seen = { written: null, indexed: [], cascaded: [], removed: 0 };
  t.mock.method(projects, 'getByEagleId', async () => structuredClone(stored));
  t.mock.method(projects, 'getById', async () => structuredClone(stored));
  t.mock.method(projects, 'upsert', async (item) => { seen.written = item; return item; });
  t.mock.method(projects, 'deleteById', async () => { seen.removed += 1; });
  t.mock.method(aiSearch, 'writeAcls', async (_index, rows) => { seen.indexed.push(...rows); return rows.length; });
  t.mock.method(documents, 'setAclForProject', async (_access, projectId, read) => {
    seen.cascaded.push({ projectId, read });
    return { succeeded: 0, failed: 0, rows: [] };
  });
  return seen;
}

async function push(doc) {
  const res = mockRes();
  await projectController.upsertFromEagle({
    params: { eagleId: PROJECT_EAGLE_ID }, query: {}, user: STAFF, body: { doc }
  }, res);
  return res;
}

function assertHiddenFromPublic(seen) {
  assert.strictEqual(seen.written.isDeleted, true);
  assert.strictEqual(seen.written.isPublished, false);
  assert.strictEqual(canRead(seen.written, anonymous()), false, 'the anonymous GET answers 404');
  assert.strictEqual(canRead(seen.written, staff()), true, 'staff still read the row');
  assert.strictEqual(seen.removed, 0, 'never a hard delete');
  assert.deepStrictEqual(seen.indexed[0], { id: '207', read: seen.written.read, isPublished: false },
    'the index row narrows, so public lists and search drop it');
  assert.ok(!seen.cascaded[0].read.includes('public'), 'the documents follow');
}

test('an Eagle push with isDeleted', async (t) => {
  t.beforeEach(() => projectReadForWriteFromGet(t));
  t.afterEach(() => t.mock.restoreAll());

  await t.test('true leaves public out of read[] and keeps the row', async () => {
    const seen = stage(t, storedEagleProject());

    const res = await push(rawEagleProject({ isDeleted: true }));

    assert.strictEqual(res.statusCode, 200);
    assertHiddenFromPublic(seen);
  });

  await t.test('false restores a project Eagle publishes', async () => {
    const seen = stage(t, storedEagleProject({ isDeleted: true, read: ['staff'], isPublished: false }));

    await push(rawEagleProject({ isDeleted: false }));

    assert.ok(seen.written.read.includes('public'));
    assert.strictEqual(seen.written.isPublished, true);
    assert.ok(!('isDeleted' in seen.written));
  });

  await t.test('absent leaves a DEMI delete standing', async () => {
    const seen = stage(t, storedEagleProject({ isDeleted: true, read: ['staff'], isPublished: false }));

    await push(rawEagleProject());

    assert.strictEqual(seen.written.isDeleted, true);
    assert.ok(!seen.written.read.includes('public'));
  });
});

test('DELETE /projects/:id', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('flags the row and leaves public out of read[]', async () => {
    const seen = stage(t, storedEagleProject());

    const res = mockRes();
    await projectController.deleteProject({ params: { id: '207' }, query: {}, user: STAFF }, res);

    assert.strictEqual(res.statusCode, 200);
    assertHiddenFromPublic(seen);
  });

  await t.test('an unknown project is a 404', async () => {
    t.mock.method(projects, 'getById', async () => null);

    const res = mockRes();
    await projectController.deleteProject({ params: { id: 'nope' }, query: {}, user: STAFF }, res);

    assert.strictEqual(res.statusCode, 404);
  });
});
