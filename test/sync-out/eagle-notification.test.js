'use strict';

// Project notifications created in DEMI, sent to Eagle through the real notifications adapter over an
// in-memory container, and the Eagle mirror's handling of their echo.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const audit = require('../../src/utils/audit');
const { logger } = require('../../src/utils/logger');
const notifications = require('../../src/repositories/notifications');
const syncOut = require('../../src/sync-out');
const eagle = require('../../src/sync-out/eagle');
const { NOTIFICATION } = require('../../src/sync-out/kinds');
const notificationController = require('../../src/controllers/nosql/notification');
const {
  mockRes, STAFF, PUBLIC_ACL, PRIVATE_ACL, eagleNotification
} = require('../helpers/eagle-mirror-fixtures');
const { API, useEnv, wireQueue, wireEagle, keys } = require('../helpers/sync-out-eagle');
const { mirrorStore } = require('../helpers/mirror-store');
const { fakeWhereQuery } = require('../helpers/updates-store');

audit._setTransport(async () => {});

const ROW_ID = '7d1e2f40-0000-4000-8000-0000000000bb';
const EAGLE_ID = '6720b3c0a1b2c3d4e5f60719';
const OBJECT_ID = /^[0-9a-f]{24}$/;

const ENV = {
  SYNC_OUT_QUEUE: 'sync-out',
  SYNC_OUT_EAGLE_ENABLED: 'true',
  SYNC_OUT_EAGLE_NOTIFICATION_ENABLED: 'true',
  SYNC_OUT_EAGLE_NATIVE_ENABLED: 'true',
  EAGLE_PROTECTED_API_BASE: API,
  EAGLE_KC_CLIENT_ID: 'demi-sync-out',
  EAGLE_KC_CLIENT_SECRET: 'not-a-real-value'
};

/** A notification as `domain/notifications.js` creates it, after one write. */
function nativeNotification(overrides = {}) {
  return {
    container: 'notifications',
    id: ROW_ID,
    eagleId: null,
    sourceSystem: 'demi',
    syncVersion: 1,
    name: 'Sunny Ridge Quarry',
    type: 'Mines',
    region: 'Thompson-Nicola',
    notificationReceivedDate: '2026-06-01T00:00:00.000Z',
    centroid: [-120.8, 50.1],
    notificationThresholdValue: 250000,
    pcp: 'none',
    isMet: false,
    isPublished: true,
    read: [...PUBLIC_ACL],
    ...overrides
  };
}

const message = (overrides = {}) =>
  ({ kind: NOTIFICATION, consumer: 'eagle', id: ROW_ID, projectId: null, attempt: 1, ...overrides });
const run = (msg = message()) => syncOut.run(msg, { maxAttempts: 3 });
const rowOf = store => store.rows('notifications').find(r => r.id === ROW_ID);
const push = async (eagleId, doc) => {
  const res = mockRes();
  await notificationController.upsertFromEagle(
    { params: { eagleId }, query: {}, user: STAFF, body: { doc, pushedAt: Date.now() } }, res);
  return res;
};

test('sync-out of DEMI-created notifications', async (t) => {
  t.beforeEach((tt) => {
    useEnv(tt, ENV);
    eagle.clearToken();
    for (const level of ['info', 'warn', 'error']) tt.mock.method(logger, level, () => {});
  });

  await t.test('the echo of the create lands on the row and leaves its fields and sync state alone', async (tt) => {
    const store = mirrorStore(tt, [nativeNotification()]);
    const sent = wireQueue(tt);
    let echo = null;
    let before = null;
    let echoed = null;
    const calls = wireEagle(tt, {
      // eagle-api awaits its push to DEMI before it answers the POST.
      'POST /projectNotification?publish=true': async (body) => {
        before = rowOf(store);
        echo = await push(body._id, eagleNotification({ ...body, read: PUBLIC_ACL }));
        echoed = rowOf(store);
        return { body: { ...body } };
      }
    });

    const result = await run();

    const posted = calls[0].body._id;
    assert.match(posted, OBJECT_ID);
    assert.strictEqual(echo.statusCode, 200, 'the echo is accepted');
    const { sources, _etag, eaglePushedAt: _pushedAt, ...fields } = echoed;
    const { sources: _s, _etag: _e, ...was } = before;
    assert.deepStrictEqual(fields, was, 'the echo changed no DEMI field, syncOut or syncVersion');
    assert.strictEqual(sources.eagle._id, posted, 'the echo landed on this row');
    assert.strictEqual(store.rows('notifications').length, 1, 'the echo made no second row');
    assert.strictEqual(result.eagleId, posted);
    assert.strictEqual(rowOf(store).syncOut.eagle.sentVersion, 1);
    assert.deepStrictEqual(sent, [], 'the echo queues nothing');

    const again = wireEagle(tt, {});
    assert.deepStrictEqual(await run(), { skipped: 'current' });
    assert.deepStrictEqual(again, [], 'no second send');
  });

  await t.test('an Eagle push for a native notification keeps every DEMI-owned field', async (tt) => {
    const row = nativeNotification({
      eagleId: EAGLE_ID, syncVersion: 3, syncOut: { eagle: { sentVersion: 3, status: 'sent' } }
    });
    const store = mirrorStore(tt, [row]);
    const doc = eagleNotification({ _id: EAGLE_ID, name: 'Renamed in Eagle', region: 'Skeena', read: PRIVATE_ACL });

    const res = await push(EAGLE_ID, doc);

    assert.strictEqual(res.statusCode, 200);
    const stored = rowOf(store);
    assert.strictEqual(stored.name, 'Sunny Ridge Quarry');
    assert.strictEqual(stored.region, 'Thompson-Nicola');
    assert.deepStrictEqual(stored.read, PUBLIC_ACL);
    assert.strictEqual(stored.isPublished, true);
    assert.strictEqual(stored.sourceSystem, 'demi');
    assert.strictEqual(stored.syncVersion, 3);
    assert.strictEqual(stored.sources.eagle.name, 'Renamed in Eagle', 'the raw copy is kept');
    assert.strictEqual(store.rows('notifications').length, 1, 'no row under the Eagle id');
  });

  await t.test('a push whose Eagle id two DEMI rows hold is refused with 409 and writes nothing', async (tt) => {
    const store = mirrorStore(tt,
      [nativeNotification({ eagleId: EAGLE_ID }), nativeNotification({ id: 'other', eagleId: EAGLE_ID })]);

    const res = await push(EAGLE_ID, eagleNotification({ _id: EAGLE_ID }));

    assert.strictEqual(res.statusCode, 409);
    assert.deepStrictEqual(store.writes, []);
  });

  await t.test('a staff-only notification Eagle holds is PUT with publish=false', async (tt) => {
    mirrorStore(tt, [nativeNotification({ eagleId: EAGLE_ID, isPublished: false, read: [...PRIVATE_ACL] })]);
    wireQueue(tt);
    const calls = wireEagle(tt, { 'PUT *': { body: { _id: EAGLE_ID } } });

    assert.deepStrictEqual(await run(), { status: 'sent', eagleId: EAGLE_ID });

    assert.deepStrictEqual(keys(calls), [`PUT /projectNotification/${EAGLE_ID}?publish=false`]);
    assert.strictEqual(calls[0].body.notificationThresholdValue, 250000);
  });

  await t.test('with SYNC_OUT_EAGLE_NATIVE_ENABLED off a notification with no eagleId is held, its sync state untouched',
    async (tt) => {
      useEnv(tt, { SYNC_OUT_EAGLE_NATIVE_ENABLED: 'false' });
      const store = mirrorStore(tt, [nativeNotification()]);
      wireQueue(tt);
      const calls = wireEagle(tt, {});

      assert.deepStrictEqual(await run(), { status: 'held' });

      assert.deepStrictEqual(calls, []);
      assert.strictEqual(rowOf(store).syncOut, undefined);
    });

  await t.test('with SYNC_OUT_EAGLE_NOTIFICATION_ENABLED off nothing is queued or sent', async (tt) => {
    useEnv(tt, { SYNC_OUT_EAGLE_NOTIFICATION_ENABLED: 'false' });
    mirrorStore(tt, [nativeNotification()]);
    const sent = wireQueue(tt);
    const calls = wireEagle(tt, {});

    assert.deepStrictEqual(await syncOut.enqueue(nativeNotification(), { kind: NOTIFICATION }), []);
    assert.deepStrictEqual(await run(), { skipped: 'disabled' });

    assert.deepStrictEqual(sent, []);
    assert.deepStrictEqual(calls, []);
  });

  await t.test('listSyncPending lists the DEMI rows past their sent version', async (tt) => {
    const row = (id, syncVersion, sentVersion, sourceSystem = 'demi') => ({
      id, sourceSystem, syncVersion, ...(sentVersion === undefined ? {} : { syncOut: { eagle: { sentVersion } } })
    });
    fakeWhereQuery(tt, [
      row('behind', 2, 1), row('sent', 2, 2), row('never-sent', 1), row('never-changed', 0), row('eagle-owned', 2, 1, 'eagle')
    ]);

    const rows = await notifications.listSyncPending();

    assert.deepStrictEqual(rows.map(r => r.id).sort(), ['behind', 'never-sent']);
  });
});
