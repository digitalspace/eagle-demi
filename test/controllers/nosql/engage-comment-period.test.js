'use strict';

/**
 * `PUT /engage/engagements/:engagementId`: the ENGAGE ingest of comment periods.
 *
 * Asserted on the stored row and the response, since the ownership split is silent when it breaks:
 * a push that clobbers Eagle's fields or misses `sources.engage.read` still answers 2xx.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../../src/db/cosmos-nosql');
const commentPeriods = require('../../../src/repositories/comment-periods');
const comments = require('../../../src/repositories/comments');
const notifications = require('../../../src/repositories/notifications');
const projects = require('../../../src/repositories/projects');
const syncOut = require('../../../src/sync-out');
const { levelOfRead } = require('../../../src/helpers/access-sql');
const { logger } = require('../../../src/utils/logger');
const { evaluate } = require('../../helpers/updates-store');
const { upsertFromEngage } = require('../../../src/controllers/nosql/engage-comment-period');
const {
  PROJECT_EAGLE_ID, PERIOD_EAGLE_ID, PRIVATE_ACL, STAFF_PERIOD_FIELDS,
  storedProject, eaglePeriod, mockRes, STAFF
} = require('../../helpers/eagle-mirror-fixtures');

const ENGAGEMENT_ID = '42';
const PUSHED_AT = '2026-10-08T17:00:00.000Z';
const PUSHED_AT_MS = Date.parse(PUSHED_AT);

function engagement(overrides = {}) {
  return {
    // ENGAGE's own shapes: integer ids and status_id, dates as zone-less UTC text
    // (met-api project_service.py _construct_demi_payload). The path carries the id as text.
    id: 42,
    name: 'Nicomen Wind engagement',
    description: 'Share your feedback on Engage.',
    status: 2,
    start: '2026-10-01 07:00:00',
    end: '2026-10-31 06:59:00',
    metURL: 'https://engage.gov.bc.ca/nicomen-wind',
    metURLAdmin: 'https://engage.gov.bc.ca/admin/engagements/42',
    bannerUrl: 'https://engage.gov.bc.ca/banner.jpg',
    projectId: PROJECT_EAGLE_ID,
    trackingId: null,
    isPublished: true,
    isDeleted: false,
    ...overrides
  };
}

/** The Eagle mirror's row for an existing period, as `comment-period.js` stores it. */
function eagleRow() {
  const doc = eaglePeriod();
  return {
    id: PERIOD_EAGLE_ID,
    eagleId: PERIOD_EAGLE_ID,
    projectId: '207',
    sourceSystem: 'eagle',
    informationLabel: 'Eagle label',
    ...STAFF_PERIOD_FIELDS,
    eaglePushedAt: 1757980005000,
    isDeleted: false,
    isPublished: true,
    read: ['staff', 'idir', 'public'],
    sources: { eagle: doc }
  };
}

/**
 * Stage the parent, an in-memory comment period store and the sync-out queue.
 * @returns {{ store: Map, queued: object[], cascades: object[] }}
 */
function stage(t, {
  rows = [], parent = storedProject(), notification = null, enqueue, deleteById, readByEngagement,
  cascade = { succeeded: 0, failed: 0 }
} = {}) {
  const store = new Map(rows.map(row => [row.id, { ...row }]));
  const queued = [];
  const cascades = [];
  t.mock.method(comments, 'setAclForPeriod', async (access, periodId, read) => {
    cascades.push({ periodId, read });
    return cascade;
  });
  t.mock.method(projects, 'getByEagleId', async () => parent);
  t.mock.method(projects, 'readForWriteByEagleId', async () => null);
  t.mock.method(notifications, 'readForWrite', async () => notification);
  // The repository's order: the asked partition, then any other.
  t.mock.method(commentPeriods, 'readForWriteByEngagementId', readByEngagement || (async (engagementId, projectId) => {
    const tied = [...store.values()].filter(r => r.engagementId === engagementId);
    return tied.find(r => r.projectId === projectId) || tied[0] || null;
  }));
  t.mock.method(commentPeriods, 'readForWrite', async (id) => store.get(String(id)) || null);
  t.mock.method(commentPeriods, 'upsert', async (item) => { store.set(item.id, item); return item; });
  t.mock.method(commentPeriods, 'deleteById', deleteById || (async () => {}));
  t.mock.method(syncOut, 'enqueue', enqueue || (async (row) => { queued.push(row); return ['eagle']; }));
  return { store, queued, cascades };
}

async function push(body, { engagementId = ENGAGEMENT_ID } = {}) {
  const res = mockRes();
  await upsertFromEngage({ params: { engagementId }, query: {}, body, user: STAFF }, res);
  return res;
}

const pushOf = (overrides, pushedAt = PUSHED_AT) => ({ engagement: engagement(overrides), pushedAt });

test('PUT /engage/engagements/:engagementId', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a new engagement is stored as engage-<id>, answered 201 and queued', async () => {
    const { store, queued } = stage(t);

    const res = await push(pushOf());

    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body, {
      id: 'engage-42', engagementId: '42', eagleId: null, engagePushedAt: PUSHED_AT_MS, queued: ['eagle']
    });
    const row = store.get('engage-42');
    assert.strictEqual(row.projectId, '207');
    assert.strictEqual(row.sourceSystem, 'engage');
    assert.strictEqual(row.eagleProjectId, PROJECT_EAGLE_ID);
    assert.strictEqual(row.informationLabel, 'Nicomen Wind engagement');
    assert.strictEqual(row.dateStarted, '2026-10-01T07:00:00.000Z', 'zone-less ENGAGE time is read as UTC');
    assert.strictEqual(row.dateCompleted, '2026-10-31T06:59:00.000Z');
    assert.strictEqual(row.syncVersion, 1);
    assert.ok(Date.parse(row.dateAdded) > 0, 'dateAdded set on create');
    assert.strictEqual(row.metBannerImageUrl, 'https://engage.gov.bc.ca/banner.jpg');
    assert.strictEqual('bannerUrl' in row, false, 'the banner lives in metBannerImageUrl and sources.engage only');
    assert.deepStrictEqual(queued.map(r => r.id), ['engage-42']);
  });

  await t.test('a tracking id adopts the Eagle period and keeps its id', async () => {
    const { store } = stage(t, { rows: [eagleRow()] });

    const res = await push(pushOf({ trackingId: PERIOD_EAGLE_ID }));

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.id, PERIOD_EAGLE_ID);
    assert.strictEqual(res.body.eagleId, PERIOD_EAGLE_ID);
    const row = store.get(PERIOD_EAGLE_ID);
    assert.strictEqual(row.engagementId, '42');
    assert.strictEqual(row.sourceSystem, 'engage');
    assert.strictEqual(row.informationLabel, 'Nicomen Wind engagement');
    assert.strictEqual(store.has('engage-42'), false, 'no second row');
  });

  await t.test('adopting leaves the Eagle-owned fields as the mirror stored them', async () => {
    const stored = eagleRow();
    const { store } = stage(t, { rows: [stored] });

    await push(pushOf({ trackingId: PERIOD_EAGLE_ID }));

    const row = store.get(PERIOD_EAGLE_ID);
    assert.deepStrictEqual(row.sources.eagle, stored.sources.eagle);
    assert.strictEqual(row.eaglePushedAt, stored.eaglePushedAt);
    assert.strictEqual(row.commentIdCount, STAFF_PERIOD_FIELDS.commentIdCount);
    assert.deepStrictEqual(row.vettingRoles, STAFF_PERIOD_FIELDS.vettingRoles);
  });

  await t.test('a row already tied to the engagement is updated in place', async () => {
    const stored = {
      id: 'engage-42', projectId: '207', sourceSystem: 'engage', engagementId: '42',
      eagleId: PERIOD_EAGLE_ID, engagePushedAt: PUSHED_AT_MS - 1000, informationLabel: 'Old name'
    };
    const { store } = stage(t, { rows: [stored] });

    const res = await push(pushOf({ name: 'New name' }));

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.eagleId, PERIOD_EAGLE_ID);
    assert.strictEqual(store.get('engage-42').informationLabel, 'New name');
    assert.strictEqual(store.get('engage-42').engagePushedAt, PUSHED_AT_MS);
  });

  await t.test('an older push is refused with 409 and not queued', async () => {
    const stored = {
      id: 'engage-42', projectId: '207', sourceSystem: 'engage', engagementId: '42',
      engagePushedAt: PUSHED_AT_MS + 1000, informationLabel: 'Newer name'
    };
    const { store, queued } = stage(t, { rows: [stored] });

    const res = await push(pushOf({ name: 'Older name' }));

    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'STALE_PUSH');
    assert.strictEqual(store.get('engage-42').informationLabel, 'Newer name');
    assert.deepStrictEqual(queued, []);
  });

  await t.test('a deleted engagement is tombstoned at level 2, still queued', async () => {
    const { store, queued } = stage(t);

    const res = await push(pushOf({ isDeleted: true }));

    assert.strictEqual(res.statusCode, 201);
    const row = store.get('engage-42');
    assert.strictEqual(row.isDeleted, true);
    assert.strictEqual(levelOfRead(row.read), 2);
    assert.strictEqual(row.isPublished, false);
    assert.strictEqual(queued.length, 1, 'sync-out takes the delete to Eagle');
  });

  await t.test('sources.engage carries the engagement and its own read', async () => {
    const { store } = stage(t);

    await push(pushOf());

    const row = store.get('engage-42');
    assert.strictEqual(row.sources.engage.metURL, 'https://engage.gov.bc.ca/nicomen-wind');
    assert.deepStrictEqual(row.sources.engage.read, ['public', 'staff', 'sysadmin']);
    assert.ok(row.read.includes('public'));
  });

  await t.test('a published engagement under a private project is not public, its own read is', async () => {
    const { store } = stage(t, { parent: storedProject(PRIVATE_ACL) });

    await push(pushOf());

    const row = store.get('engage-42');
    assert.strictEqual(row.read.includes('public'), false);
    assert.strictEqual(row.isPublished, false);
    assert.deepStrictEqual(row.sources.engage.read, ['public', 'staff', 'sysadmin'],
      'the ACL cascade re-derives from this when the project publishes');
  });

  await t.test('an unpublished engagement reads staff and sysadmin only', async () => {
    const { store } = stage(t);

    await push(pushOf({ isPublished: false }));

    assert.deepStrictEqual(store.get('engage-42').sources.engage.read, ['staff', 'sysadmin']);
    assert.strictEqual(store.get('engage-42').read.includes('public'), false);
  });

  await t.test('an unknown parent is 404 with a refusal code, nothing written', async () => {
    const { store } = stage(t, { parent: null });

    const res = await push(pushOf());

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.body.code, 'PARENT_NOT_FOUND');
    assert.strictEqual(store.size, 0);
  });

  await t.test('a path id that differs from the body id is 400', async () => {
    const { store } = stage(t);

    const res = await push(pushOf(), { engagementId: '43' });

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'ENGAGEMENT_ID_MISMATCH');
    assert.strictEqual(store.size, 0);
  });

  await t.test('a missing pushedAt is 400', async () => {
    stage(t);

    const res = await push({ engagement: engagement() });

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'PUSHED_AT_INVALID');
  });

  await t.test('a tracking id another engagement owns is 422, its row untouched', async () => {
    const stored = { ...eagleRow(), sourceSystem: 'engage', engagementId: '41' };
    const { store, queued } = stage(t, { rows: [stored] });

    const res = await push(pushOf({ trackingId: PERIOD_EAGLE_ID }));

    assert.strictEqual(res.statusCode, 422);
    assert.strictEqual(res.body.code, 'TRACKING_ID_CLAIMED');
    assert.strictEqual(store.get(PERIOD_EAGLE_ID).engagementId, '41');
    assert.deepStrictEqual(queued, []);
  });

  await t.test('a failed enqueue still answers success and logs an error', async () => {
    const errors = [];
    t.mock.method(logger, 'error', (message, meta) => errors.push({ message, meta }));
    const { store } = stage(t, { enqueue: async () => { throw new Error('queue down'); } });

    const res = await push(pushOf());

    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(res.body.queued, []);
    assert.ok(store.has('engage-42'));
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].meta.error, 'queue down');
  });

  await t.test('unpublishing a stored engagement re-derives the comments under it', async () => {
    const { store, cascades } = stage(t);
    await push(pushOf());
    assert.deepStrictEqual(cascades, [], 'a new row has no comments yet');

    const res = await push(pushOf({ isPublished: false }, new Date(PUSHED_AT_MS + 1000).toISOString()));

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(cascades, [{ periodId: 'engage-42', read: store.get('engage-42').read }]);
    assert.strictEqual(cascades[0].read.includes('public'), false);
  });

  await t.test('a push that keeps the level leaves the comments alone', async () => {
    const { cascades } = stage(t);
    await push(pushOf());

    await push(pushOf({ name: 'Renamed' }, new Date(PUSHED_AT_MS + 1000).toISOString()));

    assert.deepStrictEqual(cascades, []);
  });

  await t.test('a failed comment cascade answers 500, the row still stored and queued', async () => {
    t.mock.method(logger, 'error', () => {});
    const { store, queued } = stage(t, { cascade: { succeeded: 1, failed: 2 } });
    await push(pushOf());

    const res = await push(pushOf({ isPublished: false }, new Date(PUSHED_AT_MS + 1000).toISOString()));

    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(res.body.id, 'engage-42');
    assert.strictEqual(store.get('engage-42').isPublished, false);
    assert.strictEqual(queued.length, 2, 'both pushes queued for sync-out');
  });
  await t.test('every write raises syncVersion, even one that changes nothing, and dateAdded stays', async () => {
    const { store } = stage(t);
    await push(pushOf());
    const added = store.get('engage-42').dateAdded;

    const res = await push(pushOf({}, new Date(PUSHED_AT_MS + 1000).toISOString()));

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(store.get('engage-42').syncVersion, 2);
    assert.strictEqual(store.get('engage-42').dateAdded, added);
  });

  await t.test('zone-less ENGAGE time is UTC whatever zone the host runs in', async (st) => {
    const before = process.env.TZ;
    process.env.TZ = 'America/Vancouver';
    st.after(() => { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; });
    const { store } = stage(t);

    await push(pushOf());

    assert.strictEqual(store.get('engage-42').dateStarted, '2026-10-01T07:00:00.000Z');
  });

  await t.test('dates with a zone are kept to the instant, empty ones stored null', async () => {
    const { store } = stage(t);

    await push(pushOf({ start: '2026-10-01T00:00:00-07:00', end: null }));

    assert.strictEqual(store.get('engage-42').dateStarted, '2026-10-01T07:00:00.000Z');
    assert.strictEqual(store.get('engage-42').dateCompleted, null);
  });

  for (const end of ['next Tuesday', 'October 31, 2026', '2026-10-31 07:00', '2026-13-45 07:00:00']) {
    await t.test(`a date neither ISO 8601 nor YYYY-MM-DD HH:MM:SS is 400 PUSHED_DATES_INVALID: ${end}`, async () => {
      const { store } = stage(t);

      const res = await push(pushOf({ end }));

      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.body.code, 'PUSHED_DATES_INVALID');
      assert.strictEqual(store.size, 0);
    });
  }

  await t.test('an ISO time with no zone is UTC, and a date alone is midnight UTC', async () => {
    const { store } = stage(t);

    await push(pushOf({ start: '2026-10-01T07:00:00', end: '2026-10-31' }));

    assert.strictEqual(store.get('engage-42').dateStarted, '2026-10-01T07:00:00.000Z');
    assert.strictEqual(store.get('engage-42').dateCompleted, '2026-10-31T00:00:00.000Z');
  });

  await t.test('a published engagement with no metURL is 400 METURL_REQUIRED; a draft or delete may lack one', async () => {
    const { store } = stage(t);

    const res = await push(pushOf({ metURL: '' }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'METURL_REQUIRED');
    assert.strictEqual(store.size, 0);

    assert.strictEqual((await push(pushOf({ metURL: '', isPublished: false }))).statusCode, 201);
    const deleted = await push(pushOf({ metURL: '', isDeleted: true }, new Date(PUSHED_AT_MS + 1000).toISOString()));
    assert.strictEqual(deleted.statusCode, 200);
  });

  await t.test('an engagement under a notification is 422 PARENT_KIND_UNSUPPORTED, nothing written', async () => {
    const { store, queued } = stage(t, { parent: null, notification: { id: PROJECT_EAGLE_ID, read: PRIVATE_ACL } });

    const res = await push(pushOf());

    assert.strictEqual(res.statusCode, 422);
    assert.strictEqual(res.body.code, 'PARENT_KIND_UNSUPPORTED');
    assert.strictEqual(store.size, 0);
    assert.deepStrictEqual(queued, []);
  });

  await t.test('a project move writes the row under the new project and deletes the old copy', async () => {
    const stored = {
      id: 'engage-42', projectId: '206', sourceSystem: 'engage', engagementId: '42', eagleProjectId: 'old-eagle',
      eagleId: PERIOD_EAGLE_ID, engagePushedAt: PUSHED_AT_MS - 1000, syncVersion: 4, read: ['staff', 'sysadmin']
    };
    const deletes = [];
    const { store, queued } = stage(t, { rows: [stored], deleteById: async (id, projectId) => deletes.push([id, projectId]) });

    const res = await push(pushOf());

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const row = store.get('engage-42');
    assert.strictEqual(row.projectId, '207');
    assert.strictEqual(row.eagleProjectId, PROJECT_EAGLE_ID);
    assert.strictEqual(row.movedFromProjectId, '206');
    assert.strictEqual(row.eagleId, PERIOD_EAGLE_ID, 'the Eagle id rides; sync-out recreates it under the new project');
    assert.strictEqual(row.syncVersion, 5);
    assert.deepStrictEqual(deletes, [['engage-42', '206']]);
    assert.deepStrictEqual(queued.map(r => r.projectId), ['207']);
  });

  await t.test('a failed old-partition delete is logged, the push still answers and is queued', async () => {
    const errors = [];
    t.mock.method(logger, 'error', (message, meta) => errors.push({ message, meta }));
    const stored = { id: 'engage-42', projectId: '206', sourceSystem: 'engage', engagementId: '42', engagePushedAt: 1 };
    const { queued } = stage(t, { rows: [stored], deleteById: async () => { throw new Error('cosmos down'); } });

    const res = await push(pushOf());

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(queued.length, 1);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /old partition copy not removed/);
  });

  await t.test('an engagement stored more than once is 500 DUPLICATE_ID, never the 409 ENGAGE reads as current', async () => {
    t.mock.method(logger, 'error', () => {});
    stage(t, { readByEngagement: async () => { throw Object.assign(new Error('dup'), { code: 'DUPLICATE_ID' }); } });

    const res = await push(pushOf());

    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(res.body.code, 'DUPLICATE_ID');
  });
});

test('commentPeriods.readForWriteByEngagementId', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('finds the engagement row in the asked partition first, then in any other', async () => {
    const rows = [
      { id: 'engage-42', projectId: '207', engagementId: '42' },
      { id: 'engage-42', projectId: '208', engagementId: '42' },
      { id: 'engage-43', projectId: '207', engagementId: '43' }
    ];
    t.mock.method(cosmos, 'query', async (_container, spec) => {
      const where = /^SELECT \* FROM c WHERE (.+)$/s.exec(spec.query)[1];
      const params = Object.fromEntries(spec.parameters.map(p => [p.name, p.value]));
      return { items: rows.filter(r => evaluate(where, r, params)) };
    });

    assert.deepStrictEqual(await commentPeriods.readForWriteByEngagementId('42', '208'), rows[1]);
    assert.deepStrictEqual(await commentPeriods.readForWriteByEngagementId('43', '300'), rows[2], 'moved project');
    assert.strictEqual(await commentPeriods.readForWriteByEngagementId('44', '207'), null);
    t.mock.method(logger, 'error', () => {});
    await assert.rejects(commentPeriods.readForWriteByEngagementId('42', '300'), { code: 'DUPLICATE_ID' },
      'two unmarked rows in other partitions are a duplicate, not a pick');
  });
});
