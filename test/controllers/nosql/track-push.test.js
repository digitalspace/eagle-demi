'use strict';

// PUT and DELETE /track/projects/:id through the real mapper, row writer and delete body, over an
// in-memory projects container. Assertions are on the answer and the stored row.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const projects = require('../../../src/repositories/projects');
const documents = require('../../../src/repositories/documents');
const links = require('../../../src/repositories/links');
const aiSearch = require('../../../src/search/ai-search');
const projectController = require('../../../src/controllers/nosql/project');
const { putTrackProject, deleteTrackProject } = require('../../../src/controllers/nosql/track-push');
const { TRACK_PUSHED_AT } = require('../../../src/scripts/sync-track-projects');
const { readForLevel } = require('../../../src/helpers/access-sql');
const { DEMI_OWNED_AT } = require('../../../src/ownership/project');
const { logger } = require('../../../src/utils/logger');
const pushPayload = require('../../fixtures/track-push-payload.json');
const {
  mockRes, STAFF, PROJECT_EAGLE_ID, eagleProject, storedEagleProject
} = require('../../helpers/eagle-mirror-fixtures');

const PUSHED_AT = 1762650000000;
const TWIN_ID = `eagle-${PROJECT_EAGLE_ID}`;
const STAFF_ONLY = { read: ['staff'], isPublished: false };
const OWNED = { [DEMI_OWNED_AT]: '2026-10-30T00:00:00.000Z' };

const lost = (code) => Object.assign(new Error('lost the race'), { code });

/** An in-memory projects container. `seen.row(id)` is what is stored now. */
function stage(t, rows = [], { createdBehind = null, losesOn = () => false, docsFail = false, hidden = false } = {}) {
  const store = new Map(rows.map(row => [String(row.id), structuredClone(row)]));
  const read = (id) => structuredClone(store.get(String(id)) || null);
  const seen = { writes: [], cascaded: [], row: read, cascade: null };

  t.mock.method(projects, 'getById', async (_access, id) => (hidden ? null : read(id)));
  t.mock.method(projects, 'readForWrite', async (id) => read(id));
  t.mock.method(projects, 'getByEagleId', async (_access, eagleId) => read('207') && read('207').eagleId === eagleId ? read('207') : null);
  t.mock.method(projects, 'readForWriteByEagleId', async (eagleId) => [...store.values()]
    .find(row => row.eagleId === eagleId && !String(row.id).startsWith('eagle-')) || null);
  t.mock.method(projects, 'upsert', async (item, opts = {}) => {
    if (losesOn(item)) throw lost(412);
    if (opts.create && createdBehind) {
      store.set(String(item.id), structuredClone(createdBehind));
      throw lost(409);
    }
    seen.writes.push(item);
    store.set(String(item.id), structuredClone(item));
    return item;
  });
  t.mock.method(projects, 'patchCascadePending', async (id, at) => {
    const row = read(id);
    if (at) row.cascadePendingAt = at;
    else delete row.cascadePendingAt;
    store.set(String(id), row);
  });
  t.mock.method(links, 'getById', async () => null);
  t.mock.method(links, 'create', async (record) => record);
  t.mock.method(aiSearch, 'writeAcls', async (_index, acls) => acls.length);
  t.mock.method(documents, 'setAclForProject', async (_access, projectId, aclRead) => {
    if (seen.cascade) await seen.cascade();
    seen.cascaded.push({ projectId, read: aclRead });
    return { succeeded: docsFail ? 0 : 1, failed: docsFail ? 1 : 0, rows: [] };
  });
  return seen;
}

/** Log lines at `level` this test wrote, first argument only. */
const logged = (t, level) => {
  const spy = t.mock.method(logger, level, () => {});
  return () => spy.mock.calls.map(call => call.arguments[0]);
};

const put = async (body = { pushedAt: PUSHED_AT, project: pushPayload }, id = '207') => {
  const res = mockRes();
  await putTrackProject({ params: { id }, query: {}, user: STAFF, body }, res);
  return res;
};

const del = async (id = '207') => {
  const res = mockRes();
  await deleteTrackProject({ params: { id }, query: {}, user: STAFF }, res);
  return res;
};

test('PUT /track/projects/:id', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a new project is created at level 1 with its push stamp', async (t) => {
    const seen = stage(t);

    const res = await put();

    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(res.body, { id: '207', action: 'created' });
    assert.deepStrictEqual(seen.row('207').read, readForLevel(1));
    assert.strictEqual(seen.row('207')[TRACK_PUSHED_AT], PUSHED_AT);
  });

  await t.test('a push older than the stored one answers 409 STALE_PUSH and writes nothing', async (t) => {
    const seen = stage(t, [storedEagleProject({ [TRACK_PUSHED_AT]: PUSHED_AT + 1 })]);

    const res = await put();

    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'STALE_PUSH');
    assert.deepStrictEqual(seen.writes, []);
  });

  await t.test('a field staff saved stays while the rest of the push lands', async (t) => {
    const seen = stage(t, [storedEagleProject({ name: 'Staff name', staffEditedAt: { name: '2026-11-01T00:00:00.000Z' } })]);

    const res = await put();

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(seen.row('207').name, 'Staff name');
    assert.strictEqual(seen.row('207').trackProjectId, 207);
    assert.ok(seen.row('207').works.length > 0, 'the works landed');
  });

  await t.test('a held field is named on the [track-push] info line', async (t) => {
    stage(t, [storedEagleProject({ name: 'Staff name', staffEditedAt: { name: '2026-11-01T00:00:00.000Z' } })]);
    const info = t.mock.method(logger, 'info', () => {});

    await put();

    const line = info.mock.calls.find(call => /^\[track-push\] put id=207 /.test(call.arguments[0]));
    assert.deepStrictEqual(line.arguments[1].held, ['name']);
  });

  await t.test('a malformed works list answers 400, logs at error and writes nothing', async (t) => {
    const seen = stage(t);
    const errors = logged(t, 'error');
    const { works: _works, ...bare } = pushPayload;

    const res = await put({ pushedAt: PUSHED_AT, project: bare });

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'PAYLOAD_INVALID');
    assert.match(errors()[0], /^\[track-push\] refused id=207 code=PAYLOAD_INVALID/);
    assert.deepStrictEqual(seen.writes, []);
  });

  await t.test('a body naming another project answers 400', async (t) => {
    const seen = stage(t);
    t.mock.method(logger, 'error', () => {});

    const res = await put(undefined, '999');

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'PROJECT_ID_MISMATCH');
    assert.deepStrictEqual(seen.writes, []);
  });

  await t.test('a push with no numeric stamp answers 400: it could not be ordered', async (t) => {
    stage(t);
    t.mock.method(logger, 'error', () => {});

    const res = await put({ pushedAt: '2026-11-09T00:00:00Z', project: pushPayload });

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'PUSHED_AT_INVALID');
  });

  await t.test('a row created behind the push answers 409 so the send can be repeated', async (t) => {
    stage(t, [], { createdBehind: storedEagleProject() });
    t.mock.method(logger, 'warn', () => {});
    const errors = logged(t, 'error');

    const res = await put();

    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'CREATED_BEHIND');
    assert.match(errors()[0], /^\[track-push\] refused id=207/);
  });

  await t.test('an API row answers 200 with the reason', async (t) => {
    const seen = stage(t, [{ id: '207', sources: {} }]);
    t.mock.method(logger, 'warn', () => {});

    const res = await put();

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { id: '207', action: 'skipped', reason: 'apiRow' });
    assert.deepStrictEqual(seen.writes, []);
  });

  await t.test('a write that loses every race answers 503 and logs at error', async (t) => {
    stage(t, [storedEagleProject()], { losesOn: () => true });
    t.mock.method(logger, 'warn', () => {});
    const errors = logged(t, 'error');

    const res = await put();

    assert.strictEqual(res.statusCode, 503);
    assert.match(errors()[0], /^\[track-push\] write failed id=207 status=conflict/);
  });

  await t.test('an Eagle id held by several rows answers 409 DUPLICATE_ID', async (t) => {
    stage(t);
    t.mock.method(projects, 'readForWriteByEagleId', async () => { throw Object.assign(new Error('dup'), { code: 'DUPLICATE_ID' }); });
    const errors = logged(t, 'error');

    const res = await put();

    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'DUPLICATE_ID');
    assert.match(errors()[0], /^\[track-push\] refused id=207/);
  });
});

test('DELETE /track/projects/:id', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('unpublishes, keeps the row and answers without the marker', async (t) => {
    const seen = stage(t, [storedEagleProject()]);

    const res = await del();

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { id: '207', action: 'deleted' });
    assert.strictEqual(seen.row('207').isDeleted, true);
    assert.ok(!seen.row('207').read.includes('public'));
    assert.ok(!seen.cascaded[0].read.includes('public'), 'the documents follow');
    assert.ok(!('cascadePendingAt' in seen.row('207')), 'cleared once the cascade finished');
  });

  await t.test('does not take an Eagle row over, so sync-out never sends it', async (t) => {
    const seen = stage(t, [storedEagleProject()]);

    await del();

    assert.ok(!(DEMI_OWNED_AT in seen.row('207')));
  });

  await t.test('logs the level the undo restores', async (t) => {
    stage(t, [storedEagleProject()]);
    const info = t.mock.method(logger, 'info', () => {});

    await del();

    const line = info.mock.calls.find(call => /^\[track-push\] deleted id=207/.test(call.arguments[0]));
    assert.strictEqual(line.arguments[1].priorLevel, 4);
  });

  await t.test('finds a row the caller could not read', async (t) => {
    const seen = stage(t, [storedEagleProject()], { hidden: true });

    const res = await del();

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(seen.row('207').isDeleted, true);
  });

  await t.test('an absent row answers 404', async (t) => {
    stage(t);

    const res = await del();

    assert.strictEqual(res.statusCode, 404);
  });

  await t.test('leaves an API row alone', async (t) => {
    const seen = stage(t, [{ id: '207', sources: {}, ...STAFF_ONLY }]);
    t.mock.method(logger, 'warn', () => {});

    const res = await del();

    assert.deepStrictEqual(res.body, { id: '207', action: 'skipped', reason: 'apiRow' });
    assert.deepStrictEqual(seen.writes, []);
  });

  await t.test('leaves a native row alone', async (t) => {
    const seen = stage(t, [{ id: '207', sourceSystem: 'demi', ...STAFF_ONLY }]);
    t.mock.method(logger, 'warn', () => {});

    const res = await del();

    assert.strictEqual(res.body.reason, 'apiRow');
    assert.deepStrictEqual(seen.writes, []);
  });

  await t.test('leaves a DEMI-owned row alone', async (t) => {
    const seen = stage(t, [storedEagleProject(OWNED)]);
    t.mock.method(logger, 'warn', () => {});

    const res = await del();

    assert.deepStrictEqual(res.body, { id: '207', action: 'skipped', reason: 'demiOwned' });
    assert.deepStrictEqual(seen.writes, []);
  });

  await t.test('a cascade killed mid-run leaves a marker that a repeat repays', async (t) => {
    const seen = stage(t, [storedEagleProject()]);
    let started;
    const reached = new Promise(resolve => { started = resolve; });
    seen.cascade = () => { started(); return new Promise(() => {}); };

    del();
    await reached;
    assert.ok(seen.row('207').cascadePendingAt, 'written before the cascade began');

    seen.cascade = null;
    const repeat = await del();

    assert.deepStrictEqual(repeat.body, { id: '207', action: 'unchanged' });
    assert.ok(!seen.cascaded.at(-1).read.includes('public'));
    assert.ok(!('cascadePendingAt' in seen.row('207')), 'the debt is paid');
  });

  await t.test('no marker when visibility does not move', async (t) => {
    const seen = stage(t, [storedEagleProject(STAFF_ONLY)]);

    await del();

    assert.ok(!('cascadePendingAt' in seen.writes[0]));
  });

  await t.test('a failed cascade answers 500 and logs the debt at error', async (t) => {
    const seen = stage(t, [storedEagleProject()], { docsFail: true });
    const errors = logged(t, 'error');

    const res = await del();

    assert.strictEqual(res.statusCode, 500);
    assert.ok(errors().some(line => /^\[track-push\] cascade owed id=207/.test(line)));
    assert.ok(seen.row('207').cascadePendingAt, 'the row still says so');
  });

  await t.test('narrows the twin and carries the delete to it', async (t) => {
    const twin = { id: TWIN_ID, eagleId: PROJECT_EAGLE_ID, read: ['public', 'staff'], isPublished: true };
    const seen = stage(t, [storedEagleProject(), twin]);
    t.mock.method(logger, 'warn', () => {});

    const res = await del();

    assert.strictEqual(res.statusCode, 200);
    assert.ok(!seen.row(TWIN_ID).read.includes('public'));
    assert.strictEqual(seen.row(TWIN_ID).isDeleted, true);
  });

  await t.test('a twin that cannot be narrowed answers 500 and logs the debt at error', async (t) => {
    const twin = { id: TWIN_ID, eagleId: PROJECT_EAGLE_ID, read: ['public', 'staff'], isPublished: true };
    stage(t, [storedEagleProject(), twin], { losesOn: (item) => item.id === TWIN_ID });
    const errors = logged(t, 'error');

    const res = await del();

    assert.strictEqual(res.statusCode, 500);
    assert.ok(errors().some(line => /^\[track-push\] twin owed id=207/.test(line)));
  });

  await t.test('a race lost on every try answers 503 and logs at error', async (t) => {
    stage(t, [storedEagleProject()], { losesOn: () => true });
    t.mock.method(logger, 'warn', () => {});
    const errors = logged(t, 'error');

    const res = await del();

    assert.strictEqual(res.statusCode, 503);
    assert.match(errors()[0], /^\[track-push\] delete lost its etag race id=207/);
  });

  await t.test('an Eagle push cannot republish the row', async (t) => {
    const seen = stage(t, [storedEagleProject()]);
    await del();

    await projectController.upsertFromEagle({
      params: { eagleId: PROJECT_EAGLE_ID }, query: {}, user: STAFF, body: { doc: eagleProject() }
    }, mockRes());

    assert.strictEqual(seen.row('207').isDeleted, true);
    assert.ok(!seen.row('207').read.includes('public'));
  });

  await t.test('restore then level brings the row back to public, documents included', async (t) => {
    const seen = stage(t, [storedEagleProject()]);
    await del();

    await projectController.restoreProject({ params: { id: '207' }, query: {}, user: STAFF }, mockRes());
    assert.ok(!seen.row('207').read.includes('public'), 'restore alone leaves a Track delete at staff');
    const level = mockRes();
    await projectController.setLevel({
      params: { id: '207' }, query: {}, user: STAFF, body: { level: 4, confirm: true, reason: 'Track delete undone' }
    }, level);

    assert.strictEqual(level.statusCode, 200, JSON.stringify(level.body));
    assert.ok(seen.row('207').read.includes('public'));
    assert.ok(seen.cascaded.at(-1).read.includes('public'));
  });
});

test('an Eagle push keeps the stored Track stamp', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const seen = stage(t, [storedEagleProject({ [TRACK_PUSHED_AT]: PUSHED_AT })]);

  await projectController.upsertFromEagle({
    params: { eagleId: PROJECT_EAGLE_ID }, query: {}, user: STAFF, body: { doc: eagleProject() }
  }, mockRes());

  assert.strictEqual(seen.row('207')[TRACK_PUSHED_AT], PUSHED_AT);
});
