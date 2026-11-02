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
const {
  mockRes, STAFF, PRIVATE_ACL, PUBLIC_ACL, ORG_EAGLE_ID, eagleProject
} = require('../helpers/eagle-mirror-fixtures');
const { API, useEnv, wireQueue, wireEagle, keys } = require('../helpers/sync-out-eagle');

audit._setTransport(async () => {});

const ROW_ID = '1234';
const ORG_ID = 'org-native-1';
const EAGLE_ID = '6720b3c0a1b2c3d4e5f60719';
const PHASE_ID = '5cf00c03a266b7e1877504ff';
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

  await t.test('a published project\'s create and its echoes leave it public, and a later send PUTs', async (tt) => {
    const store = mirrorStore(tt, [nativeProject({ read: [...PUBLIC_ACL], isPublished: true }), proponent()]);
    const sent = wireQueue(tt);
    let posted = null;
    let before = null;
    let echoed = null;
    // eagle-api awaits its push to DEMI before it answers; it stores a new project staff-only.
    const echo = async (read) => {
      const res = mockRes();
      await projectController.upsertFromEagle({
        params: { eagleId: posted }, query: {}, user: STAFF,
        body: { doc: eagleProject({ _id: posted, read, proponent: ORG_EAGLE_ID }), pushedAt: Date.now() }
      }, res);
      assert.strictEqual(res.statusCode, 200, 'the echo is accepted');
    };
    const calls = wireEagle(tt, {
      'POST /project': async (body) => {
        posted = body._id;
        before = rowOf(store);
        await echo(PRIVATE_ACL);
        echoed = rowOf(store);
        return accept(body);
      },
      'PUT *': async () => {
        await echo(PUBLIC_ACL);
        return {};
      }
    });

    const result = await run();

    assert.match(posted, OBJECT_ID);
    assert.deepStrictEqual(keys(calls), ['POST /project', `PUT /project/${posted}/publish`]);
    assert.deepStrictEqual(store.rows('projects').map(r => r.id), [ROW_ID], 'the echo made no eagle-<id> row');
    for (const field of ['id', 'eagleId', 'sourceSystem', 'name', 'syncOut', 'syncVersion', 'centroid']) {
      assert.deepStrictEqual(echoed[field], before[field], `the echo kept ${field}`);
    }
    assert.strictEqual(result.eagleId, posted);
    assert.deepStrictEqual(rowOf(store).read, PUBLIC_ACL, 'the publish echo leaves the row public');
    assert.deepStrictEqual(sent, [], 'the echoes queue nothing');
    assert.deepStrictEqual(await run(), { skipped: 'current' });

    // A staff edit, as writeRow stores it: the stored row in place, one version on.
    const stored = rowOf(store);
    Object.assign(stored, { name: 'Nicomen Wind Energy (renamed)', syncVersion: stored.syncVersion + 1 });
    const later = wireEagle(tt, { [`PUT /project/${posted}`]: {} });

    assert.strictEqual((await run()).status, 'sent');
    assert.deepStrictEqual(keys(later), [`PUT /project/${posted}`], 'no level call: Eagle is already public');
    assert.strictEqual(later[0].body.proponent, ORG_EAGLE_ID, 'the proponent is found by the Eagle id the echo stored');
    assert.strictEqual(later[0].body.name, 'Nicomen Wind Energy (renamed)');
  });

  await t.test('a PUT answered 404 POSTs the same minted id, with ref fields as bare ids', async (tt) => {
    const store = mirrorStore(tt, [nativeProject({
      eagleId: EAGLE_ID, syncOut: { eagle: { mintedId: EAGLE_ID } },
      currentPhaseName: { _id: PHASE_ID, name: 'Proposed' }, eacDecision: { _id: null, name: null }
    }), proponent()]);
    wireQueue(tt);
    const put = `PUT /project/${EAGLE_ID}`;
    const calls = wireEagle(tt, { [put]: { status: 404 }, 'POST /project': accept });

    const result = await run();

    assert.deepStrictEqual(keys(calls), [put, 'POST /project']);
    assert.strictEqual(calls[1].body._id, EAGLE_ID);
    assert.strictEqual(calls[1].body.proponent, ORG_EAGLE_ID);
    assert.strictEqual(calls[1].body.currentPhaseName, PHASE_ID);
    assert.strictEqual(calls[1].body.eacDecision, null);
    assert.deepStrictEqual(calls[1].body.centroid, [-120.4, 50.6]);
    assert.deepStrictEqual(result, { status: 'sent', eagleId: EAGLE_ID });
    assert.strictEqual(rowOf(store).syncOut.eagle.status, 'sent');
  });

  await t.test('an Eagle id sync-out did not mint is not sent: skipped and warned, no call', async (tt) => {
    const store = mirrorStore(tt, [nativeProject({ eagleId: EAGLE_ID }), proponent()]);
    wireQueue(tt);
    const calls = wireEagle(tt, {});

    assert.deepStrictEqual(await run(), { status: 'skipped' });

    assert.deepStrictEqual(calls, []);
    assert.strictEqual(rowOf(store).eagleId, EAGLE_ID);
    assert.strictEqual(logged('warn', 'which sync-out did not create; not sent').length, 1);
  });

  await t.test('with SYNC_OUT_EAGLE_NATIVE_ENABLED off a project with no eagleId is held, its sync state untouched',
    async (tt) => {
      useEnv(tt, { SYNC_OUT_EAGLE_NATIVE_ENABLED: 'false' });
      const store = mirrorStore(tt, [nativeProject(), proponent()]);
      wireQueue(tt);
      const calls = wireEagle(tt, {});

      assert.deepStrictEqual(await run(), { status: 'held' });

      assert.deepStrictEqual(calls, []);
      assert.strictEqual(rowOf(store).syncOut, undefined);
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
