'use strict';

// Projects created in DEMI or taken over from Eagle, sent to Eagle through the real projects adapter over an in-memory
// container.

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
const cosmos = require('../../src/db/cosmos-nosql');
const lists = require('../../src/repositories/lists');
const eagleProjectConsumer = require('../../src/sync-out/eagle-project');
const { readForLevel } = require('../../src/helpers/access-sql');
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
const STRAY_ID = '6720b3c0a1b2c3d4e5f607fe';
const LEAD_ID = '5cf00c03a266b7e1877504aa';
const EAGLE_PROPONENT_ID = '5cf00c03a266b7e1877504bb';
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

/** A project as `createProject` makes it: no `sources.track`, level 1. */
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
    read: readForLevel(1),
    isPublished: false,
    sources: {},
    syncVersion: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides
  };
}

/** Eagle's copy as the mirror stores it: flat fields plus every block, the current one holding what its PUT rewrites. */
const eagleCopy = block => ({
  _id: EAGLE_ID, read: PRIVATE_ACL, currentLegislationYear: 'legislation_2002', legislation_2002: block
});
const EAGLE_BLOCK = Object.freeze({
  name: 'Eagle name', region: 'Peace', dispute: true, disputeDate: '2025-03-01T00:00:00.000Z',
  intake: { investment: 12, investmentNotes: 'Phase one' }, projectLeadId: LEAD_ID, currentPhaseName: PHASE_ID,
  type: 'Energy-Electricity', location: 'Near Hudson\'s Hope', centroid: [-121, 51]
});

/** A Track-matched project DEMI took over from Eagle: it keeps the Eagle id and Eagle's raw copy. */
const ownedProject = (overrides = {}) => nativeProject({
  eagleId: EAGLE_ID,
  demiOwnedAt: '2026-11-01T00:00:00.000Z',
  sources: { track: { track_project_id: 1234 }, eagle: { _id: EAGLE_ID, read: PRIVATE_ACL } },
  ...overrides
});

const proponent = (eagleId = ORG_EAGLE_ID) =>
  ({ container: 'lists', id: ORG_ID, kind: 'Organization', sourceSystem: 'demi', eagleId, read: PRIVATE_ACL });

const message = (overrides = {}) =>
  ({ kind: PROJECT, consumer: 'eagle', id: ROW_ID, projectId: ROW_ID, attempt: 1, ...overrides });
const run = (msg = message(), maxAttempts = 3) => syncOut.run(msg, { maxAttempts });
const accept = body => ({ body: { _id: body._id } });
const logged = (level, text) => logger[level].mock.calls.filter(c => String(c.arguments[0]).includes(text));
const rowOf = store => store.rows('projects').find(r => r.id === ROW_ID);

/** eagle-api's push of `eagleId` at `read`, through the real mirror; eagle-api awaits it before it answers. */
async function echo(eagleId, read) {
  const res = mockRes();
  await projectController.upsertFromEagle({
    params: { eagleId }, query: {}, user: STAFF,
    body: { doc: eagleProject({ _id: eagleId, read, proponent: ORG_EAGLE_ID }), pushedAt: Date.now() }
  }, res);
  assert.strictEqual(res.statusCode, 200, 'the echo is accepted');
}

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
    const calls = wireEagle(tt, {
      'POST /project': async (body) => {
        posted = body._id;
        before = rowOf(store);
        await echo(posted, PRIVATE_ACL);
        echoed = rowOf(store);
        return accept(body);
      },
      'PUT *': async () => {
        await echo(posted, PUBLIC_ACL);
        return {};
      }
    });

    const result = await run();

    assert.match(posted, OBJECT_ID);
    assert.deepStrictEqual(keys(calls), ['POST /project', `PUT /project/${posted}/publish`]);
    assert.deepStrictEqual(store.rows('projects').map(r => r.id), [ROW_ID], 'the echo made no eagle-<id> row');
    const kept = ['id', 'eagleId', 'sourceSystem', 'name', 'syncOut', 'syncVersion', 'centroid', 'read', 'isPublished'];
    for (const field of kept) {
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

  await t.test('the echo of the create leaves a level-1 project at level 1', async (tt) => {
    const store = mirrorStore(tt, [nativeProject(), proponent()]);
    wireQueue(tt);
    const calls = wireEagle(tt, {
      'POST /project': async (body) => {
        await echo(body._id, PRIVATE_ACL);
        return accept(body);
      }
    });

    await run();

    assert.deepStrictEqual(keys(calls), ['POST /project'], 'no level call for a project that is not public');
    assert.deepStrictEqual(rowOf(store).read, readForLevel(1));
    assert.deepStrictEqual(rowOf(store).sources.eagle.read, PRIVATE_ACL, 'Eagle\'s level stays in its raw copy');
  });

  await t.test('a publish that fails after the create is made by the retry', async (tt) => {
    const store = mirrorStore(tt, [nativeProject({ read: [...PUBLIC_ACL], isPublished: true }), proponent()]);
    wireQueue(tt);
    let posted = null;
    wireEagle(tt, {
      'POST /project': async (body) => {
        posted = body._id;
        await echo(posted, PRIVATE_ACL);
        return accept(body);
      },
      'PUT *': { status: 500 }
    });

    assert.deepStrictEqual(await run(), { retryQueued: 2 });
    assert.deepStrictEqual(rowOf(store).read, PUBLIC_ACL);

    const retry = wireEagle(tt, { 'PUT *': {} });
    assert.strictEqual((await run(message({ attempt: 2 }))).status, 'sent');
    assert.deepStrictEqual(keys(retry), [`PUT /project/${posted}`, `PUT /project/${posted}/publish`]);
  });

  await t.test('an Eagle id staff link after the send read the row stops the create', async (tt) => {
    const store = mirrorStore(tt, [nativeProject(), proponent()]);
    wireQueue(tt);
    const calls = wireEagle(tt, {});
    // Read between the send's first read and its claim write: the proponent lookup.
    const readOrg = lists.readForWrite.bind(lists);
    tt.mock.method(lists, 'readForWrite', async (...args) => {
      rowOf(store).eagleId = EAGLE_ID;
      return readOrg(...args);
    });

    assert.deepStrictEqual(await run(), { status: 'skipped' });

    assert.deepStrictEqual(calls, [], 'no POST under the staff-owned id');
    assert.strictEqual(rowOf(store).eagleId, EAGLE_ID);
    assert.strictEqual(logged('warn', `holds Eagle id ${EAGLE_ID}, which sync-out did not create`).length, 1);
  });

  await t.test('an echo that made an eagle-<id> twin is logged and the create still counts as sent', async (tt) => {
    mirrorStore(tt, [nativeProject(), proponent()]);
    wireQueue(tt);
    wireEagle(tt, {
      'POST /project': async (body) => {
        await cosmos.create('projects', { id: `eagle-${body._id}`, eagleId: body._id, sourceSystem: 'eagle' });
        return accept(body);
      }
    });

    assert.strictEqual((await run()).status, 'sent');

    assert.strictEqual(logged('error', 'echo created mirror twin').length, 1);
  });

  await t.test('a POST stored under another id names the eagle-<id> mirror row in the error line', async (tt) => {
    const store = mirrorStore(tt, [nativeProject(), proponent()]);
    wireQueue(tt);
    wireEagle(tt, { 'POST /project': { body: { _id: STRAY_ID } } });

    await run(message(), 1);

    assert.strictEqual(rowOf(store).syncOut.eagle.strayEagleId, STRAY_ID);
    assert.strictEqual(logged('error', `Its echo made the DEMI mirror row eagle-${STRAY_ID}`).length, 1);
  });

  await t.test('a PUT answered 404 POSTs the same minted id, with ref fields as bare ids', async (tt) => {
    const store = mirrorStore(tt, [nativeProject({
      eagleId: EAGLE_ID, syncOut: { eagle: { mintedId: EAGLE_ID } }, legislationYear: 2018,
      currentPhaseName: { _id: PHASE_ID, name: 'Proposed' }, eacDecision: { _id: null, name: null }
    }), proponent()]);
    wireQueue(tt);
    const put = `PUT /project/${EAGLE_ID}`;
    const calls = wireEagle(tt, { [put]: { status: 404 }, 'POST /project': accept });

    const result = await run();

    assert.deepStrictEqual(keys(calls), [put, 'POST /project']);
    assert.strictEqual(calls[0].body.legislationYear, undefined, 'a PUT naming a year Eagle lacks answers 404');
    assert.strictEqual(calls[1].body.legislationYear, 2018, 'the create carries the year');
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

  await t.test('a DEMI-owned Eagle project PUTs bodyFor to /project/<eagleId>', async (tt) => {
    const row = ownedProject({
      read: [...PUBLIC_ACL], isPublished: true, currentLegislationYear: 'legislation_2002',
      sources: { track: { track_project_id: 1234 }, eagle: eagleCopy({ ...EAGLE_BLOCK, proponent: EAGLE_PROPONENT_ID }) }
    });
    mirrorStore(tt, [row, proponent()]);
    wireQueue(tt);
    const expected = await eagleProjectConsumer.bodyFor(row, {});
    const put = `PUT /project/${EAGLE_ID}`;
    const calls = wireEagle(tt, { [put]: {}, [`${put}/publish`]: {} });

    const result = await run();

    assert.deepStrictEqual(keys(calls), [put, `${put}/publish`], 'one PUT and the level sync, no POST');
    assert.deepStrictEqual(calls[0].body, expected);
    assert.strictEqual(calls[0].body.proponent, ORG_EAGLE_ID, 'the DEMI org wins over Eagle\'s proponent');
    assert.deepStrictEqual(result, { status: 'sent', eagleId: EAGLE_ID }, 'the same legislation year on both sides sends');
    assert.strictEqual(logged('info', 'sending DEMI-owned Eagle project').length, 1);
  });

  await t.test('a DEMI-owned Eagle project whose DEMI org has no Eagle id yet sends nothing and fails with the error line',
    async (tt) => {
      const store = mirrorStore(tt, [ownedProject({
        sources: { track: { track_project_id: 1234 }, eagle: eagleCopy({ ...EAGLE_BLOCK, proponent: EAGLE_PROPONENT_ID }) }
      }), proponent(null)]);
      wireQueue(tt);
      const calls = wireEagle(tt, {});

      await run(message(), 1);

      assert.deepStrictEqual(calls, [], 'Eagle\'s old proponent is not sent over the row\'s');
      assert.strictEqual(rowOf(store).syncOut.eagle.status, 'failed');
      assert.strictEqual(logged('error', `[sync-out eagle] proponent ${ORG_ID} of project ${ROW_ID} has no eagleId`).length, 1);
    });

  await t.test('a DEMI-owned Eagle project whose PUT misses never POSTs', async (tt) => {
    const store = mirrorStore(tt, [ownedProject(), proponent()]);
    wireQueue(tt);
    const put = `PUT /project/${EAGLE_ID}`;
    const calls = wireEagle(tt, { [put]: { status: 404 } });

    assert.deepStrictEqual(await run(), { status: 'skipped' });

    assert.deepStrictEqual(keys(calls), [put]);
    assert.strictEqual(rowOf(store).eagleId, EAGLE_ID, 'no id minted over the Eagle one');
  });

  await t.test('with SYNC_OUT_EAGLE_NATIVE_ENABLED off a DEMI-owned project whose PUT misses is skipped, not held',
    async (tt) => {
      useEnv(tt, { SYNC_OUT_EAGLE_NATIVE_ENABLED: 'false' });
      mirrorStore(tt, [ownedProject(), proponent()]);
      wireQueue(tt);
      wireEagle(tt, { [`PUT /project/${EAGLE_ID}`]: { status: 404 } });

      assert.deepStrictEqual(await run(), { status: 'skipped' });

      assert.strictEqual(logged('warn', `Eagle has no project ${EAGLE_ID} for DEMI-owned ${ROW_ID}; not sent`).length, 1);
    });

  await t.test('a DEMI-owned project whose legislation year moved off Eagle\'s is skipped with no call', async (tt) => {
    mirrorStore(tt, [ownedProject({
      currentLegislationYear: 'legislation_2018',
      sources: { track: { track_project_id: 1234 }, eagle: eagleCopy(EAGLE_BLOCK) }
    }), proponent()]);
    wireQueue(tt);
    const calls = wireEagle(tt, {});

    assert.deepStrictEqual(await run(), { status: 'skipped' });

    assert.deepStrictEqual(calls, [], 'a PUT would write the new year\'s values over Eagle\'s old block');
    assert.strictEqual(logged('warn', `DEMI-owned project ${ROW_ID} changed legislation year`).length, 1);
  });

  await t.test('a DEMI-owned project switched to another Act through /level is then skipped with no call', async (tt) => {
    const block2018 = { name: 'Nicomen Wind Energy 2018', legislationYear: 2018 };
    const store = mirrorStore(tt, [ownedProject({
      currentLegislationYear: 'legislation_2002', legislationYearList: [2002, 2018],
      legislation_2002: { name: 'Nicomen Wind Energy', legislationYear: 2002 }, legislation_2018: block2018,
      sources: { track: { track_project_id: 1234 }, eagle: { ...eagleCopy(EAGLE_BLOCK), legislationYearList: [2002, 2018] } }
    }), proponent()]);
    wireQueue(tt);
    const calls = wireEagle(tt, {});
    const res = mockRes();
    await projectController.setLevel({
      params: { id: ROW_ID }, query: {}, user: STAFF, body: { level: 4, confirm: true, reason: 'switch Act', legislationYear: 2018 }
    }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(rowOf(store).currentLegislationYear, 'legislation_2018', 'the premise: the switch landed');

    assert.deepStrictEqual(await run(), { status: 'skipped' });

    assert.deepStrictEqual(calls, [], 'a PUT would write the 2018 values over Eagle\'s 2002 block');
  });

  await t.test('restore of an Eagle-mirrored project, then a PUT, sends a body that keeps Eagle\'s level', async (tt) => {
    const store = mirrorStore(tt, [ownedProject({
      demiOwnedAt: undefined, isDeleted: true, read: ['staff'], isPublished: false,
      sources: { track: { track_project_id: 1234 }, eagle: { ...eagleCopy(EAGLE_BLOCK), read: [...PUBLIC_ACL] } }
    }), proponent()]);
    wireQueue(tt);
    const put = `PUT /project/${EAGLE_ID}`;
    const calls = wireEagle(tt, { [put]: {} });
    const call = async (handler, body) => {
      const res = mockRes();
      await projectController[handler]({ params: { id: ROW_ID }, query: {}, user: STAFF, body }, res);
      assert.strictEqual(res.statusCode, 200, handler);
    };

    await call('restoreProject');
    await call('updateProject', { description: 'Edited in DEMI' });
    assert.ok(rowOf(store).demiOwnedAt, 'the premise: restore took the project over');

    assert.deepStrictEqual(await run(), { status: 'sent', eagleId: EAGLE_ID });
    assert.deepStrictEqual(keys(calls), [put], 'no unpublish of Eagle\'s live copy');
  });

  await t.test('a DEMI-owned Eagle project sends Eagle\'s value for each field the row lacks, and its own where it has one',
    async (tt) => {
      mirrorStore(tt, [proponent()]);
      const row = ownedProject({
        region: null,
        centroid: undefined,
        sources: { track: { track_project_id: 1234 }, eagle: eagleCopy(EAGLE_BLOCK) }
      });

      const body = await eagleProjectConsumer.bodyFor(row, {});

      assert.strictEqual(body.dispute, true);
      assert.strictEqual(body.disputeDate, EAGLE_BLOCK.disputeDate);
      assert.deepStrictEqual(body.intake, { investment: 12, notes: 'Phase one' }, 'in the shape eagle-api\'s PUT reads');
      assert.strictEqual(body.projectLeadId, LEAD_ID);
      assert.strictEqual(body.currentPhaseName, PHASE_ID);
      assert.strictEqual(body.type, EAGLE_BLOCK.type, 'a renamed field falls back under Eagle\'s name');
      assert.strictEqual(body.location, EAGLE_BLOCK.location);
      assert.deepStrictEqual(body.centroid, [-121, 51]);
      assert.strictEqual(body.name, 'Nicomen Wind Energy (DEMI)', 'a field the row holds is sent from the row');
      assert.strictEqual(body.region, null, 'a blank the row holds still wins');
    });

  await t.test('a DEMI-owned Eagle project sends the [lng, lat] centroid the mirror stored', async (tt) => {
    mirrorStore(tt, [proponent()]);
    const row = ownedProject({ centroid: [-122.5, 52.1], sources: { track: { track_project_id: 1234 }, eagle: eagleCopy(EAGLE_BLOCK) } });

    const body = await eagleProjectConsumer.bodyFor(row, {});

    assert.deepStrictEqual(body.centroid, [-122.5, 52.1], 'eagle-api clears a centroid the PUT leaves out');
  });

  await t.test('a DEMI-owned Eagle project with a flat Eagle copy falls back to its flat fields', async (tt) => {
    mirrorStore(tt, [proponent()]);
    const row = ownedProject({ sources: { track: { track_project_id: 1234 }, eagle: { _id: EAGLE_ID, ...EAGLE_BLOCK } } });

    const body = await eagleProjectConsumer.bodyFor(row, {});

    assert.strictEqual(body.disputeDate, EAGLE_BLOCK.disputeDate);
  });

  await t.test('a DEMI-owned Eagle project whose proponent DEMI lacks sends Eagle\'s, with no error line', async (tt) => {
    mirrorStore(tt, []);
    const row = ownedProject({
      sources: { track: { track_project_id: 1234 }, eagle: eagleCopy({ ...EAGLE_BLOCK, proponent: EAGLE_PROPONENT_ID }) }
    });

    const body = await eagleProjectConsumer.bodyFor(row, {});

    assert.strictEqual(body.proponent, EAGLE_PROPONENT_ID);
    assert.strictEqual(logged('error', 'has no eagleId').length, 0);
  });

  await t.test('an intake held as eagle-admin\'s { investment, notes } keeps its notes', async (tt) => {
    mirrorStore(tt, [proponent()]);
    const row = ownedProject({ intake: { investment: 5, notes: 'Row notes' } });

    const body = await eagleProjectConsumer.bodyFor(row, {});

    assert.deepStrictEqual(body.intake, { investment: 5, notes: 'Row notes' });
  });

  await t.test('a native project\'s body takes nothing from its Eagle copy', async (tt) => {
    mirrorStore(tt, [proponent()]);
    const row = nativeProject({
      eagleId: EAGLE_ID, syncOut: { eagle: { mintedId: EAGLE_ID } }, sources: { eagle: eagleCopy(EAGLE_BLOCK) }
    });

    const body = await eagleProjectConsumer.bodyFor(row, {});

    assert.deepStrictEqual(Object.keys(body).sort(), ['centroid', 'description', 'name', 'proponent']);
  });

  await t.test('with SYNC_OUT_EAGLE_NATIVE_ENABLED off a project with no eagleId is held, its sync state untouched',
    async (tt) => {
      useEnv(tt, { SYNC_OUT_EAGLE_NATIVE_ENABLED: 'false' });
      // A proponent Eagle lacks: held must answer before the body lookup that would fail on it.
      const store = mirrorStore(tt, [nativeProject(), proponent(null)]);
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
