'use strict';

// Projects created in DEMI, sent to Eagle through the real projects adapter over an in-memory container.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const audit = require('../../src/utils/audit');
const { logger } = require('../../src/utils/logger');
const aiSearch = require('../../src/search/ai-search');
const documents = require('../../src/repositories/documents');
const syncOut = require('../../src/sync-out');
const eagle = require('../../src/sync-out/eagle');
const { PROJECT } = require('../../src/sync-out/kinds');
const projectController = require('../../src/controllers/nosql/project');
const { mirrorStore } = require('../helpers/mirror-store');
const { mockRes, STAFF, PRIVATE_ACL, ORG_EAGLE_ID, eagleProject } = require('../helpers/eagle-mirror-fixtures');
const { API, useEnv, wireQueue, wireEagle, keys } = require('../helpers/sync-out-eagle');

audit._setTransport(async () => {});

const ROW_ID = '1234';
const ORG_ID = 'org-native-1';
const EAGLE_ID = '6720b3c0a1b2c3d4e5f60719';
const OBJECT_ID = /^[0-9a-f]{24}$/;

const ENV = {
  SYNC_OUT_QUEUE: 'sync-out',
  SYNC_OUT_EAGLE_ENABLED: 'true',
  SYNC_OUT_EAGLE_PROJECT_ENABLED: 'true',
  SYNC_OUT_EAGLE_NATIVE_ENABLED: 'true',
  EAGLE_PROTECTED_API_BASE: API,
  EAGLE_KC_CLIENT_ID: 'demi-sync-out',
  EAGLE_KC_CLIENT_SECRET: 'not-a-real-value'
};

/** A project as `createProject` makes it: no `sources.track`, staff-only. */
function nativeProject(overrides = {}) {
  return {
    container: 'projects',
    id: ROW_ID,
    trackProjectId: 1234,
    eagleId: null,
    sourceSystem: 'track',
    name: 'Nicomen Wind Energy (DEMI)',
    description: 'A wind farm',
    centroid: { type: 'Point', coordinates: [-120.4, 50.6] },
    proponentId: ORG_ID,
    read: [...PRIVATE_ACL],
    isPublished: false,
    sources: {},
    syncVersion: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides
  };
}

const proponent = (eagleId = ORG_EAGLE_ID) =>
  ({ container: 'lists', id: ORG_ID, kind: 'Organization', sourceSystem: 'demi', eagleId, read: PRIVATE_ACL });

const message = (overrides = {}) =>
  ({ kind: PROJECT, consumer: 'eagle', id: ROW_ID, projectId: ROW_ID, attempt: 1, ...overrides });
const run = (msg = message(), maxAttempts = 3) => syncOut.run(msg, { maxAttempts });
const accept = body => ({ body: { _id: body._id } });
const logged = (level, text) => logger[level].mock.calls.filter(c => String(c.arguments[0]).includes(text));
const rowOf = store => store.rows('projects').find(r => r.id === ROW_ID);

test('sync-out of DEMI-created projects', async (t) => {
  t.beforeEach((tt) => {
    useEnv(tt, ENV);
    eagle.clearToken();
    for (const level of ['info', 'warn', 'error']) tt.mock.method(logger, level, () => {});
    tt.mock.method(aiSearch, 'writeAcls', async (_index, rows) => rows.length);
    tt.mock.method(documents, 'setAclForProject', async () => ({ succeeded: 0, failed: 0, rows: [] }));
  });

  await t.test('the echo of the create lands on the row and leaves its sync state alone', async (tt) => {
    const store = mirrorStore(tt, [nativeProject(), proponent()]);
    const sent = wireQueue(tt);
    let echo = null;
    let before = null;
    let echoed = null;
    const calls = wireEagle(tt, {
      'POST /project': async (body) => {
        before = rowOf(store);
        echo = mockRes();
        await projectController.upsertFromEagle({
          params: { eagleId: body._id }, query: {}, user: STAFF,
          body: { doc: eagleProject({ _id: body._id, name: body.name, read: PRIVATE_ACL }), pushedAt: Date.now() }
        }, echo);
        echoed = rowOf(store);
        return accept(body);
      }
    });

    const result = await run();

    const posted = calls[0].body._id;
    assert.match(posted, OBJECT_ID);
    assert.strictEqual(echo.statusCode, 200, 'the echo is accepted');
    assert.deepStrictEqual(store.rows('projects').map(r => r.id), [ROW_ID], 'the echo made no eagle-<id> row');
    for (const field of ['id', 'eagleId', 'sourceSystem', 'name', 'syncOut', 'syncVersion', 'centroid']) {
      assert.deepStrictEqual(echoed[field], before[field], `the echo kept ${field}`);
    }
    assert.strictEqual(echoed.sources.eagle._id, posted, 'the echo landed on this row');
    assert.strictEqual(result.eagleId, posted);
    assert.deepStrictEqual(sent, [], 'the echo queues nothing');

    const again = wireEagle(tt, {});
    assert.deepStrictEqual(await run(), { skipped: 'current' });
    assert.deepStrictEqual(again, [], 'no second send');
  });

  await t.test('a PUT answered 404 POSTs the same id with the proponent\'s Eagle id', async (tt) => {
    const store = mirrorStore(tt, [nativeProject({ eagleId: EAGLE_ID }), proponent()]);
    wireQueue(tt);
    const put = `PUT /project/${EAGLE_ID}`;
    const calls = wireEagle(tt, { [put]: { status: 404 }, 'POST /project': accept });

    const result = await run();

    assert.deepStrictEqual(keys(calls), [put, 'POST /project']);
    assert.strictEqual(calls[1].body._id, EAGLE_ID);
    assert.strictEqual(calls[1].body.proponent, ORG_EAGLE_ID);
    assert.deepStrictEqual(calls[1].body.centroid, [-120.4, 50.6]);
    assert.deepStrictEqual(result, { status: 'sent', eagleId: EAGLE_ID });
    assert.strictEqual(rowOf(store).syncOut.eagle.status, 'sent');
  });

  await t.test('a proponent with no eagleId makes no POST and ends failed with the error line', async (tt) => {
    const store = mirrorStore(tt, [nativeProject(), proponent(null)]);
    wireQueue(tt);
    const calls = wireEagle(tt, {});

    await run(message(), 1);

    assert.deepStrictEqual(calls, []);
    assert.strictEqual(rowOf(store).syncOut.eagle.status, 'failed');
    assert.strictEqual(logged('error', `[sync-out eagle] proponent ${ORG_ID} of project ${ROW_ID} has no eagleId`).length, 1);
  });

  await t.test('featuredDocuments sends only the documents that hold an Eagle id', async (tt) => {
    mirrorStore(tt, [
      nativeProject({ featuredDocuments: ['doc-sent', 'doc-unsent', 'doc-gone'] }),
      proponent(),
      { container: 'documents', id: 'doc-sent', projectId: ROW_ID, eagleId: '6720b3c0a1b2c3d4e5f6071a', read: PRIVATE_ACL },
      { container: 'documents', id: 'doc-unsent', projectId: ROW_ID, eagleId: null, read: PRIVATE_ACL }
    ]);
    wireQueue(tt);
    const calls = wireEagle(tt, { 'POST /project': accept });

    await run();

    assert.deepStrictEqual(calls[0].body.featuredDocuments, ['6720b3c0a1b2c3d4e5f6071a']);
  });

  await t.test('two concurrent deliveries make one POST with one minted id; the losing claim re-reads', async (tt) => {
    const store = mirrorStore(tt, [nativeProject(), proponent()]);
    wireQueue(tt);
    const calls = wireEagle(tt, { 'POST /project': accept });

    const results = await Promise.all([run(), run()]);

    assert.deepStrictEqual(keys(calls), ['POST /project']);
    const minted = calls[0].body._id;
    assert.deepStrictEqual(results.filter(r => r.status), [{ status: 'sent', eagleId: minted }]);
    assert.deepStrictEqual(results.filter(r => !r.status), [{ retryQueued: 2 }]);
    assert.strictEqual(rowOf(store).eagleId, minted);
  });
});
