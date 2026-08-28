'use strict';

/**
 * The ladder move routes — `PUT /api/{projects,documents}/:id/level`.
 *
 * Widening is an ACT (docs/rbac-architecture.md §1): these are the only handlers that raise a
 * record's level, level 4 costs a confirmation and a reason, a document may not pass its project,
 * and pulling a record back off level 4 is sysadmin-only incident response. Every assertion below
 * is one of those rules; the audit row is asserted to exist BEFORE the response, because a
 * visibility change nobody can attribute is the failure this endpoint exists to prevent.
 */

process.env.NODE_ENV = 'test';
// Before src/config is first required: the audit writer is inert without the DCR pair, and a batch
// size of 1 makes enqueue flush synchronously, which is what lets the ordering case below read the
// buffer from inside res.json.
process.env.AUDIT_DCR_ENDPOINT = 'https://dcr-test.canadacentral-1.ingest.monitor.azure.com';
process.env.AUDIT_DCR_IMMUTABLE_ID = 'dcr-testimmutableid';
process.env.AUDIT_MAX_BATCH = '1';

const test = require('node:test');
const assert = require('node:assert');

const audit = require('../../../src/utils/audit');
const projects = require('../../../src/repositories/projects');
const documents = require('../../../src/repositories/documents');
const chunksRepo = require('../../../src/repositories/chunks');
const aiSearch = require('../../../src/search/ai-search');
const projectController = require('../../../src/controllers/nosql/project');
const documentController = require('../../../src/controllers/nosql/document');

const SYSADMIN = { sub: 'kc-1', preferred_username: 'sys.admin', realm_access: { roles: ['sysadmin'] } };
const STAFF = { sub: 'kc-2', preferred_username: 'staff.person', realm_access: { roles: ['staff'] } };

let rows = [];
audit._setTransport(async (stream, batch) => { rows.push(...batch); });

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    // The audit rows that existed when the response was written. Captured here rather than after
    // the call, so "audited" cannot be satisfied by a row enqueued on the way out.
    rowsAtResponse: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.rowsAtResponse = rows.slice(); this.body = data; return this; },
    setHeader() {}
  };
}

/** The index and cascade legs, which every successful move runs. */
function stubCascade(t) {
  t.mock.method(aiSearch, 'indexes', () => ({
    chunks: 'chunks', projects: 'projects', documents: 'documents'
  }));
  t.mock.method(aiSearch, 'writeAcls', async () => 1);
  t.mock.method(documents, 'setAclForProject', async () => ({ succeeded: 0, failed: 0, rows: [] }));
  t.mock.method(chunksRepo, 'setAclForDocument', async () => ({ succeeded: 0, failed: 0 }));
}

const PROJECT_AT = (level, read) => ({
  id: '207', trackProjectId: 207, name: 'Skeena LNG', read, isPublished: level === 4
});

test('the ladder move routes', async (t) => {
  t.beforeEach(() => { rows = []; });
  t.afterEach(() => t.mock.restoreAll());
  t.after(() => audit._resetTransport());

  await t.test('level 4 without confirm is 400', async () => {
    t.mock.method(projects, 'getById', async () => PROJECT_AT(2, ['staff']));
    t.mock.method(projects, 'upsert', async () => assert.fail('a refused move must not write'));

    const res = mockRes();
    await projectController.setLevel({
      params: { id: '207' }, query: {}, body: { level: 4, reason: 'approved for release' },
      user: SYSADMIN
    }, res);

    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /confirm/, 'the message names the confirmation it wants');
    assert.strictEqual(rows.length, 0, 'a refused move is not an act');
  });

  await t.test('level 4 without reason is 400', async () => {
    t.mock.method(projects, 'getById', async () => PROJECT_AT(2, ['staff']));
    t.mock.method(projects, 'upsert', async () => assert.fail('a refused move must not write'));

    const res = mockRes();
    // Whitespace, not absence: an empty reason is the same non-answer as none at all.
    await projectController.setLevel({
      params: { id: '207' }, query: {}, body: { level: 4, confirm: true, reason: '   ' },
      user: SYSADMIN
    }, res);

    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /reason/);
  });

  await t.test('a level outside the ladder is 400', async () => {
    t.mock.method(projects, 'upsert', async () => assert.fail('a refused move must not write'));

    for (const level of [0, 5, -1, '4', 2.5, undefined]) {
      const res = mockRes();
      await projectController.setLevel({
        params: { id: '207' }, query: {}, body: { level, confirm: true, reason: 'x' },
        user: SYSADMIN
      }, res);
      assert.strictEqual(res.statusCode, 400, `level ${level} is not a ladder level`);
    }
  });

  await t.test('level 4 with confirm and reason writes public', async () => {
    let saved;
    t.mock.method(projects, 'getById', async () => PROJECT_AT(2, ['staff']));
    t.mock.method(projects, 'upsert', async (item) => { saved = item; return item; });
    stubCascade(t);

    const res = mockRes();
    await projectController.setLevel({
      params: { id: '207' }, query: {},
      body: { level: 4, confirm: true, reason: 'cleared by the EAO for publication' },
      user: SYSADMIN
    }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(saved.read, ['staff', 'idir', 'public']);
    assert.strictEqual(saved.isPublished, true, 'isPublished mirrors read[]');
  });

  await t.test('a widen is audited before the response', async () => {
    t.mock.method(projects, 'getById', async () => PROJECT_AT(1, ['team']));
    t.mock.method(projects, 'upsert', async (item) => item);
    stubCascade(t);

    const res = mockRes();
    await projectController.setLevel({
      params: { id: '207' }, query: {}, body: { level: 3 }, user: SYSADMIN
    }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.rowsAtResponse.length, 1, 'the row exists when res.json runs');
    const row = res.rowsAtResponse[0];
    assert.strictEqual(row.Action, 'record.widen');
    assert.strictEqual(row.TargetId, '207');
    assert.strictEqual(row.ProjectId, '207');
    assert.strictEqual(row.Detail.from, 1);
    assert.strictEqual(row.Detail.to, 3);
    assert.strictEqual(row.Detail.confirmed, false, 'level 3 needs no confirmation');
  });

  await t.test('a project level change re-derives its documents', async () => {
    // The cascade is what stops a document out-ranking the project it moved under. Asserted
    // through `setAclForProject`, which is the only observable the module-local cascade has.
    let cascadedWith = null;
    t.mock.method(projects, 'getById', async () => PROJECT_AT(2, ['staff']));
    t.mock.method(projects, 'upsert', async (item) => item);
    t.mock.method(aiSearch, 'indexes', () => ({
      chunks: 'chunks', projects: 'projects', documents: 'documents'
    }));
    t.mock.method(aiSearch, 'writeAcls', async () => 1);
    t.mock.method(documents, 'setAclForProject', async (access, projectId, read) => {
      cascadedWith = { projectId, read };
      return { succeeded: 1, failed: 0, rows: [] };
    });

    const moved = mockRes();
    await projectController.setLevel({
      params: { id: '207' }, query: {}, body: { level: 3 }, user: SYSADMIN
    }, moved);

    assert.strictEqual(moved.statusCode, 200);
    assert.deepStrictEqual(cascadedWith, { projectId: '207', read: ['staff', 'idir'] },
      'the documents are re-derived against the level the project just moved to');

    // A no-op move touches nothing: re-running the cascade would rewrite every document in the
    // partition for a request that changed no visibility at all.
    cascadedWith = null;
    const same = mockRes();
    await projectController.setLevel({
      params: { id: '207' }, query: {}, body: { level: 2 }, user: SYSADMIN
    }, same);

    assert.strictEqual(same.statusCode, 200);
    assert.strictEqual(cascadedWith, null, 'level equal to from runs no cascade');
  });

  await t.test('a document cannot pass its project', async () => {
    t.mock.method(documents, 'getById', async () => ({ id: 'd1', projectId: '207', read: ['staff'] }));
    t.mock.method(projects, 'getById', async () => PROJECT_AT(2, ['staff']));
    t.mock.method(documents, 'setPublished', async () => assert.fail('a refused move must not write'));

    const res = mockRes();
    await documentController.setLevel({
      params: { id: 'd1' }, query: {},
      body: { level: 4, confirm: true, reason: 'requested by the proponent' }, user: SYSADMIN
    }, res);

    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(rows.length, 0);
  });

  await t.test('nothing widens implicitly', async () => {
    // The two write paths that touch a whole record: neither may move it up the ladder. The level
    // route is the only door, so a `level` key in an ordinary update body must do nothing at all.
    const level1 = PROJECT_AT(1, ['team']);
    let saved;
    t.mock.method(projects, 'getById', async () => structuredClone(level1));
    t.mock.method(projects, 'getByEagleId', async () => structuredClone(level1));
    t.mock.method(projects, 'upsert', async (item) => { saved = item; return item; });
    stubCascade(t);

    await projectController.updateProject({
      params: { id: '207' }, query: {}, body: { description: 'edited' }, user: SYSADMIN
    }, mockRes());
    assert.deepStrictEqual(saved.read, ['team'], 'PUT /:id leaves the level alone');
    assert.strictEqual(saved.isPublished, false);

    saved = undefined;
    const refused = mockRes();
    await projectController.updateProject({
      params: { id: '207' }, query: {}, body: { level: 4, confirm: true }, user: SYSADMIN
    }, refused);
    assert.strictEqual(refused.statusCode, 400, 'a level key in an ordinary update body is refused');
    assert.strictEqual(saved, undefined, 'and nothing is written');

    saved = undefined;
    await projectController.upsertFromEagle({
      params: { eagleId: 'eag-1' }, query: {},
      body: { doc: { _id: 'eag-1', name: 'Skeena LNG', read: ['team'] } }, user: SYSADMIN
    }, mockRes());
    assert.deepStrictEqual(saved.read, ['team'], 'the mirror carries Eagle read[], it never raises it');

    assert.ok(!rows.some(r => r.Action === 'record.widen'), 'neither path is a ladder move');
  });

  await t.test('a staff caller cannot narrow', async () => {
    t.mock.method(projects, 'getById', async () => PROJECT_AT(4, ['staff', 'idir', 'public']));
    t.mock.method(projects, 'upsert', async () => assert.fail('a refused takedown must not write'));

    const res = mockRes();
    await projectController.setLevel({
      params: { id: '207' }, query: {}, body: { level: 2, reason: 'published in error' }, user: STAFF
    }, res);

    assert.strictEqual(res.statusCode, 403);
    assert.match(res.body.error, /takedown-runbook/, 'the refusal points at the runbook');
    assert.strictEqual(rows.length, 0);
  });

  await t.test('sysadmin narrowing is audited as record.takedown', async () => {
    let saved;
    t.mock.method(projects, 'getById', async () => PROJECT_AT(4, ['staff', 'idir', 'public']));
    t.mock.method(projects, 'upsert', async (item) => { saved = item; return item; });
    stubCascade(t);

    const res = mockRes();
    await projectController.setLevel({
      params: { id: '207' }, query: {},
      body: { level: 2, reason: 'personal information published in error' }, user: SYSADMIN
    }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(saved.read, ['staff']);
    assert.strictEqual(saved.isPublished, false);
    assert.strictEqual(res.rowsAtResponse.length, 1);
    assert.strictEqual(res.rowsAtResponse[0].Action, 'record.takedown',
      'a takedown is not a routine narrow, and the table has to say so');
    assert.strictEqual(res.rowsAtResponse[0].Detail.from, 4);
    assert.strictEqual(res.rowsAtResponse[0].Detail.to, 2);
    assert.strictEqual(res.rowsAtResponse[0].Detail.reason, 'personal information published in error');
  });

  await t.test('the published alias still works', async () => {
    // eagle-admin-console sends `{ isPublished }` and nothing else. It must keep working, and it
    // must not be a way around the guards the level route applies.
    const doc = { id: 'd1', projectId: '207', read: ['staff'], isPublished: false };
    let args;
    t.mock.method(documents, 'getById', async () => structuredClone(doc));
    t.mock.method(projects, 'getById', async () => PROJECT_AT(4, ['staff', 'idir', 'public']));
    t.mock.method(documents, 'setPublished', async (...a) => {
      args = a;
      return { ...doc, read: ['staff', 'idir', 'public'], isPublished: true };
    });
    stubCascade(t);

    const res = mockRes();
    await documentController.setDocumentPublished({
      params: { id: 'd1' }, query: {}, body: { isPublished: true }, user: SYSADMIN
    }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(args, ['d1', '207', 4], 'isPublished: true is level 4');
    assert.strictEqual(res.rowsAtResponse[0].Action, 'record.widen');
    assert.strictEqual(res.rowsAtResponse[0].Detail.to, 4);
    // The alias synthesises `confirm: true` to clear the level-4 guard. Filing that as a
    // confirmation would put a decision in the audit table that nobody made.
    assert.strictEqual(res.rowsAtResponse[0].Detail.confirmed, false);
    assert.strictEqual(res.rowsAtResponse[0].Detail.reason, 'legacy PUT /documents/:id/published');

    // And the level route itself still records a real confirmation as one — otherwise the fix
    // above would be satisfied by never recording any.
    const direct = mockRes();
    await documentController.setLevel({
      params: { id: 'd1' }, query: {},
      body: { level: 4, confirm: true, reason: 'cleared by the EAO' }, user: SYSADMIN
    }, direct);
    assert.strictEqual(direct.rowsAtResponse.at(-1).Detail.confirmed, true);
  });

  await t.test('the alias is not a way around the takedown gate', async () => {
    t.mock.method(documents, 'getById', async () => ({
      id: 'd1', projectId: '207', read: ['staff', 'idir', 'public'], isPublished: true
    }));
    t.mock.method(projects, 'getById', async () => PROJECT_AT(4, ['staff', 'idir', 'public']));
    t.mock.method(documents, 'setPublished', async () => assert.fail('a refused takedown must not write'));

    const res = mockRes();
    await documentController.setDocumentPublished({
      params: { id: 'd1' }, query: {}, body: { isPublished: false }, user: STAFF
    }, res);

    assert.strictEqual(res.statusCode, 403);
  });
});
