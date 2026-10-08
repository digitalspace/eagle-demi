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
    // ENGAGE ids are integers; the path carries the same id as text.
    id: 42,
    name: 'Nicomen Wind engagement',
    description: 'Share your feedback on Engage.',
    status: 'Open',
    start: '2026-10-01T00:00:00.000Z',
    end: '2026-10-31T00:00:00.000Z',
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
function stage(t, { rows = [], parent = storedProject(), enqueue, cascade = { succeeded: 0, failed: 0 } } = {}) {
  const store = new Map(rows.map(row => [row.id, { ...row }]));
  const queued = [];
  const cascades = [];
  t.mock.method(comments, 'setAclForPeriod', async (access, periodId, read) => {
    cascades.push({ periodId, read });
    return cascade;
  });
  t.mock.method(projects, 'getByEagleId', async () => parent);
  t.mock.method(projects, 'readForWriteByEagleId', async () => null);
  t.mock.method(notifications, 'readForWrite', async () => null);
  t.mock.method(commentPeriods, 'readForWriteByEngagementId', async (engagementId, projectId) =>
    [...store.values()].find(r => r.engagementId === engagementId && r.projectId === projectId) || null);
  t.mock.method(commentPeriods, 'readForWrite', async (id) => store.get(String(id)) || null);
  t.mock.method(commentPeriods, 'upsert', async (item) => { store.set(item.id, item); return item; });
  t.mock.method(commentPeriods, 'deleteById', async () => {});
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
    assert.strictEqual(row.dateCompleted, '2026-10-31T00:00:00.000Z');
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

  await t.test('a tracking id another engagement owns is 409, its row untouched', async () => {
    const stored = { ...eagleRow(), sourceSystem: 'engage', engagementId: '41' };
    const { store, queued } = stage(t, { rows: [stored] });

    const res = await push(pushOf({ trackingId: PERIOD_EAGLE_ID }));

    assert.strictEqual(res.statusCode, 409);
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
});

test('commentPeriods.readForWriteByEngagementId', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('finds the engagement row in the asked partition only', async () => {
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
    assert.strictEqual(await commentPeriods.readForWriteByEngagementId('44', '207'), null);
  });
});
