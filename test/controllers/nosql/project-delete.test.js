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
const { redactForAccess } = require('../../../src/vis/redact');
const {
  mockRes, STAFF, PROJECT_EAGLE_ID, anonymous, staff, eagleProject, storedEagleProject,
  projectReadForWriteFromGet
} = require('../../helpers/eagle-mirror-fixtures');

const STAFF_ONLY = { read: ['staff'], isPublished: false };
const TWIN_ID = `eagle-${PROJECT_EAGLE_ID}`;

/** What eagle-api sends: the raw Mongo record, content under its block, the flag on the top level. */
function rawEagleProject(top = {}) {
  const { _id, read, ...content } = eagleProject();
  return { _id, read, currentLegislationYear: 'legislation_2018', legislation_2018: content, ...top };
}

/** Stub the stored row and the visibility cascade; record what the controller wrote and indexed. */
function stage(t, stored, { twin = null, docsFail = false, losses = 0 } = {}) {
  const seen = { writes: [], indexed: [], cascaded: [], removed: 0, pending: [] };
  t.mock.method(projects, 'getByEagleId', async () => structuredClone(stored));
  t.mock.method(projects, 'getById', async () => structuredClone(stored));
  t.mock.method(projects, 'readForWrite', async (id) => (id === TWIN_ID ? structuredClone(twin) : null));
  t.mock.method(projects, 'upsert', async (item, opts) => {
    if (seen.writes.length < losses) {
      seen.writes.push({ item, opts, lost: true });
      throw Object.assign(new Error('precondition failed'), { code: 412 });
    }
    seen.writes.push({ item, opts });
    return item;
  });
  t.mock.method(projects, 'deleteById', async () => { seen.removed += 1; });
  t.mock.method(projects, 'patchCascadePending', async (id, at) => { seen.pending.push({ id, at }); });
  t.mock.method(aiSearch, 'writeAcls', async (_index, rows) => { seen.indexed.push(...rows); return rows.length; });
  t.mock.method(documents, 'setAclForProject', async (_access, projectId, read) => {
    seen.cascaded.push({ projectId, read });
    return { succeeded: docsFail ? 0 : 1, failed: docsFail ? 1 : 0, rows: [] };
  });
  Object.defineProperty(seen, 'written', { get: () => seen.writes.filter(w => !w.lost).at(0)?.item });
  return seen;
}

async function push(doc) {
  const res = mockRes();
  await projectController.upsertFromEagle({
    params: { eagleId: PROJECT_EAGLE_ID }, query: {}, user: STAFF, body: { doc }
  }, res);
  return res;
}

async function del(id = '207') {
  const res = mockRes();
  await projectController.deleteProject({ params: { id }, query: {}, user: STAFF }, res);
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
    assert.strictEqual(seen.written.sources.eagle.isDeleted, true);
  });

  await t.test('false restores a project Eagle publishes', async () => {
    const seen = stage(t, storedEagleProject({ isDeleted: true, ...STAFF_ONLY }));

    await push(rawEagleProject({ isDeleted: false }));

    assert.ok(seen.written.read.includes('public'));
    assert.strictEqual(seen.written.isPublished, true);
    assert.ok(!('isDeleted' in seen.written));
  });

  await t.test('absent restores a delete Eagle made', async () => {
    const stored = storedEagleProject({ isDeleted: true, ...STAFF_ONLY });
    stored.sources.eagle.isDeleted = true;
    const seen = stage(t, stored);

    await push(rawEagleProject());

    assert.strictEqual(seen.written.id, '207', 'the premise: the Track-matched merge ran');
    assert.ok(seen.written.read.includes('public'));
    assert.ok(!('isDeleted' in seen.written));
  });

  await t.test('absent leaves a DEMI delete standing', async () => {
    const seen = stage(t, storedEagleProject({ isDeleted: true, ...STAFF_ONLY }));

    await push(rawEagleProject());

    assert.strictEqual(seen.written.id, '207', 'the premise: the Track-matched merge ran');
    assert.strictEqual(seen.written.isDeleted, true);
    assert.ok(!seen.written.read.includes('public'));
  });
});

test('DELETE /projects/:id', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('flags the row and leaves public out of read[], guarded on the read revision', async () => {
    const seen = stage(t, storedEagleProject({ _etag: 'rev-1' }));

    const res = await del();

    assert.strictEqual(res.statusCode, 200);
    assertHiddenFromPublic(seen);
    assert.deepStrictEqual(seen.writes[0].opts, { etag: 'rev-1' });
  });

  await t.test('staff see the flag in the body; an anonymous view never carries it', async () => {
    const seen = stage(t, storedEagleProject());

    const res = await del();

    assert.strictEqual(res.body.deleted.isDeleted, true);
    const publicRow = { ...seen.written, read: ['public'], isPublished: true };
    assert.ok(!('isDeleted' in redactForAccess('projects', publicRow, anonymous())));
  });

  await t.test('a lost race rebuilds from the re-read row', async () => {
    const seen = stage(t, storedEagleProject(), { losses: 1 });

    const res = await del();

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(seen.writes.length, 2);
    assert.strictEqual(seen.written.isDeleted, true);
  });

  await t.test('a race lost on every try is a 503', async () => {
    const seen = stage(t, storedEagleProject(), { losses: 99 });

    const res = await del();

    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(seen.written, undefined);
  });

  await t.test('a failed cascade is a 500 and leaves the cascade owed', async () => {
    const seen = stage(t, storedEagleProject(), { docsFail: true });

    const res = await del();

    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(seen.pending.length, 1);
    assert.ok(seen.pending[0].at, 'marked, not cleared');
  });

  await t.test('a repeat writes nothing', async () => {
    const seen = stage(t, storedEagleProject({ isDeleted: true, ...STAFF_ONLY }));

    const res = await del();

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(seen.writes.length, 0);
    assert.strictEqual(seen.cascaded.length, 0);
  });

  await t.test('a repeat retries a cascade the first call left owed', async () => {
    const seen = stage(t, storedEagleProject({ isDeleted: true, ...STAFF_ONLY, cascadePendingAt: '2026-10-30T00:00:00.000Z' }));

    const res = await del();

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(seen.writes.length, 0);
    assert.strictEqual(seen.cascaded.length, 1);
    assert.deepStrictEqual(seen.pending, [{ id: '207', at: null }]);
  });

  await t.test('narrows the Eagle-only twin beside a Track row', async () => {
    const twin = { id: TWIN_ID, eagleId: PROJECT_EAGLE_ID, read: ['public', 'staff'], isPublished: true };
    const seen = stage(t, storedEagleProject(), { twin });

    const res = await del();

    assert.strictEqual(res.statusCode, 200);
    const twinWrite = seen.writes.find(w => w.item.id === TWIN_ID);
    assert.ok(twinWrite, 'the twin was written');
    assert.ok(!twinWrite.item.read.includes('public'));
  });

  await t.test('an unknown project is a 404', async () => {
    t.mock.method(projects, 'getById', async () => null);

    const res = await del('nope');

    assert.strictEqual(res.statusCode, 404);
  });
});

test('PUT /projects/:id/level refuses a deleted project', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const seen = stage(t, storedEagleProject({ isDeleted: true, ...STAFF_ONLY }));

  const res = mockRes();
  await projectController.setLevel({
    params: { id: '207' }, query: {}, user: STAFF, body: { level: 4, confirm: true, reason: 'republish' }
  }, res);

  assert.strictEqual(res.statusCode, 409);
  assert.deepStrictEqual(res.body, { error: 'Project is deleted' });
  assert.strictEqual(seen.writes.length, 0);
});
