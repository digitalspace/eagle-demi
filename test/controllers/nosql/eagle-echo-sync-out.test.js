'use strict';

// eagle-api echoes a sync-out send back through the mirror, for any kind sync-out sends. The echo
// must keep the row's sync-out state, or `versionOf` reads 0 and sync-out sends the row again.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const projects = require('../../../src/repositories/projects');
const documents = require('../../../src/repositories/documents');
const lists = require('../../../src/repositories/lists');
const aiSearch = require('../../../src/search/ai-search');
const projectController = require('../../../src/controllers/nosql/project');
const documentController = require('../../../src/controllers/nosql/document');
const organizationController = require('../../../src/controllers/nosql/organization');
const {
  eagleProject, storedEagleProject, projectReadForWriteFromGet, documentReadForWriteFromGet
} = require('../../helpers/eagle-mirror-fixtures');

const STAFF = { sub: 'kc-sub-1', preferred_username: 'push', realm_access: { roles: ['sysadmin'] } };
const PROJECT_EAGLE_ID = '588511d0aaecd9001b825604';
const DOC_EAGLE_ID = '58869abba4acd4014b81f55c';
const ORG_EAGLE_ID = '5c8a8e0c1b3f6a0024a1b2c3';

const SYNC_STATE = Object.freeze({
  syncVersion: 7,
  syncOut: { eagle: { status: 'sent', sentVersion: 7, sentAt: '2026-10-30T00:00:00.000Z' } }
});

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    setHeader() {}
  };
}

const syncStateOf = row => ({ syncVersion: row.syncVersion, syncOut: row.syncOut });

test('an eagle-api echo keeps the sync-out state', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('project', async () => {
    // A Track row with no `epic_guid`, so only the stored row holds its Eagle id.
    const stored = storedEagleProject({ ...structuredClone(SYNC_STATE) });
    delete stored.sources.track.epic_guid;
    projectReadForWriteFromGet(t);
    t.mock.method(projects, 'getByEagleId', async () => structuredClone(stored));
    let saved;
    t.mock.method(projects, 'upsert', async (item) => { saved = item; return item; });
    t.mock.method(aiSearch, 'writeAcls', async (_index, rows) => rows.length);
    t.mock.method(documents, 'setAclForProject', async () => ({ succeeded: 0, failed: 0, rows: [] }));

    const res = mockRes();
    await projectController.upsertFromEagle({
      params: { eagleId: PROJECT_EAGLE_ID }, query: {}, body: { doc: eagleProject() }, user: STAFF
    }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(syncStateOf(saved), SYNC_STATE);
    assert.strictEqual(saved.eagleId, PROJECT_EAGLE_ID);
  });

  await t.test('document', async () => {
    const stored = {
      id: DOC_EAGLE_ID, eagleId: DOC_EAGLE_ID, projectId: '207', sourceSystem: 'eagle',
      read: ['public'], ownRead: ['public'], isPublished: true, ...structuredClone(SYNC_STATE)
    };
    documentReadForWriteFromGet(t);
    t.mock.method(projects, 'getByEagleId', async () => storedEagleProject());
    t.mock.method(documents, 'getById', async () => structuredClone(stored));
    let written;
    t.mock.method(documents, 'upsert', async (item) => { written = item; return item; });
    t.mock.method(aiSearch, 'writeAcls', async (_index, rows) => rows.length);

    const res = mockRes();
    await documentController.upsertFromEagle({
      params: { eagleId: DOC_EAGLE_ID }, query: {}, user: STAFF,
      body: { doc: { _id: DOC_EAGLE_ID, project: PROJECT_EAGLE_ID, displayName: 'Application', read: ['public', 'sysadmin'] } }
    }, res);

    assert.deepStrictEqual(res.body, { id: DOC_EAGLE_ID, action: 'upsert' });
    assert.deepStrictEqual(syncStateOf(written), SYNC_STATE);
  });

  await t.test('organization', async () => {
    const stored = {
      id: ORG_EAGLE_ID, eagleId: ORG_EAGLE_ID, kind: lists.KINDS.ORGANIZATION, name: 'Acme Mining',
      read: ['public'], ...structuredClone(SYNC_STATE)
    };
    t.mock.method(lists, 'readForWrite', async () => structuredClone(stored));
    let written;
    t.mock.method(lists, 'upsert', async (item) => { written = item; return item; });

    await organizationController.mirrorFromEagle(ORG_EAGLE_ID,
      { _id: ORG_EAGLE_ID, name: 'Acme Mining Ltd', read: ['public', 'sysadmin'] });

    assert.strictEqual(written.name, 'Acme Mining Ltd', 'the echo still lands');
    assert.deepStrictEqual(syncStateOf(written), SYNC_STATE);
  });
});
