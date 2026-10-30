'use strict';

// eagle-api echoes a DEMI-created period back under the id DEMI minted; the echo must land on the
// native row, not mirror a second one beside it.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const commentPeriods = require('../../../src/repositories/comment-periods');
const comments = require('../../../src/repositories/comments');
const notifications = require('../../../src/repositories/notifications');
const projects = require('../../../src/repositories/projects');
const commentPeriodController = require('../../../src/controllers/nosql/comment-period');
const {
  PERIOD_EAGLE_ID, STAFF, storedProject, eaglePeriod, mockRes
} = require('../../helpers/eagle-mirror-fixtures');

const NATIVE_ID = '3f2b8c1e-7a4d-4e9b-9c61-2d5e8f0a1b37';
const NATIVE_READ = ['staff', 'idir'];
const SYNC_OUT = { eagle: { status: 'sent', sentVersion: 1, claim: null } };

function nativePeriod() {
  return {
    id: NATIVE_ID,
    eagleId: PERIOD_EAGLE_ID,
    projectId: '207',
    sourceSystem: 'demi',
    informationLabel: 'DEMI label',
    isDeleted: false,
    isPublished: false,
    read: NATIVE_READ,
    syncOut: SYNC_OUT,
    syncVersion: 1,
    sources: {}
  };
}

/** One in-memory container keyed by partition and id, behind the repository calls the mirror makes. */
function stage(t, rows) {
  const store = new Map(rows.map(row => [`${row.projectId}/${row.id}`, { ...row }]));
  t.mock.method(projects, 'getByEagleId', async () => storedProject());
  t.mock.method(projects, 'readForWriteByEagleId', async () => null);
  t.mock.method(notifications, 'readForWrite', async () => null);
  t.mock.method(comments, 'setAclForPeriod', async () => ({ succeeded: 0, failed: 0 }));
  t.mock.method(commentPeriods, 'readForWrite', async (id, projectId) =>
    store.get(`${projectId}/${id}`) || null);
  t.mock.method(commentPeriods, 'readForWriteByEagleId', async (eagleId) =>
    [...store.values()].find(row => row.eagleId === eagleId) || null);
  t.mock.method(commentPeriods, 'readForWriteEngageByMetUrl', async () => null);
  t.mock.method(commentPeriods, 'readForWriteEngageByDroppedEagleId', async () => null);
  t.mock.method(commentPeriods, 'upsert', async (item) => {
    store.set(`${item.projectId}/${item.id}`, item);
    return item;
  });
  t.mock.method(commentPeriods, 'deleteById', async (id, projectId) => store.delete(`${projectId}/${id}`));
  return { rowsIn: (projectId) => [...store.values()].filter(row => row.projectId === projectId) };
}

async function push(doc) {
  const res = mockRes();
  await commentPeriodController.upsertFromEagle(
    { params: { eagleId: doc._id }, query: {}, body: { doc }, user: STAFF }, res);
  return res;
}

test('PUT /eagle/commentperiod/:eagleId on a DEMI-native period', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('the echo of a native period answers 2xx and leaves one row in the partition', async (st) => {
    const { rowsIn } = stage(st, [nativePeriod()]);

    const res = await push(eaglePeriod({ informationLabel: 'Eagle label' }));

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(rowsIn('207').map(row => row.id), [NATIVE_ID]);
  });

  await t.test('the row the echo wrote keeps the native id, owner, ACL and sync-out state', async (st) => {
    const { rowsIn } = stage(st, [nativePeriod()]);

    await push(eaglePeriod({ informationLabel: 'Eagle label' }));

    const [row] = rowsIn('207').filter(stored => stored.sources.eagle);
    assert.strictEqual(row.id, NATIVE_ID);
    assert.strictEqual(row.sourceSystem, 'demi');
    assert.deepStrictEqual(row.read, NATIVE_READ);
    assert.strictEqual(row.isPublished, false);
    assert.deepStrictEqual(row.syncOut, SYNC_OUT);
    assert.strictEqual(row.syncVersion, 1);
    assert.strictEqual(row.informationLabel, 'DEMI label');
  });

  await t.test('the echo records the Eagle copy on the native row', async (st) => {
    const { rowsIn } = stage(st, [nativePeriod()]);

    await push(eaglePeriod());

    const row = rowsIn('207').find(stored => stored.id === NATIVE_ID);
    assert.strictEqual(row.eagleId, PERIOD_EAGLE_ID);
    assert.strictEqual(row.sources.eagle._id, PERIOD_EAGLE_ID);
  });

  await t.test('a push of an id no row holds still mirrors a new Eagle row', async (st) => {
    const { rowsIn } = stage(st, []);

    const res = await push(eaglePeriod());

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const [row] = rowsIn('207');
    assert.strictEqual(row.id, PERIOD_EAGLE_ID);
    assert.strictEqual(row.sourceSystem, 'eagle');
  });
});
