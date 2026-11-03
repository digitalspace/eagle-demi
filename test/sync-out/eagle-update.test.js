'use strict';

// Updates created in DEMI, sent to Eagle through the real updates adapter over an in-memory container, and the
// Eagle mirror's handling of their echo.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const audit = require('../../src/utils/audit');
const { logger } = require('../../src/utils/logger');
const syncOut = require('../../src/sync-out');
const eagle = require('../../src/sync-out/eagle');
const { UPDATE } = require('../../src/sync-out/kinds');
const updateController = require('../../src/controllers/nosql/update');
const {
  mockRes, STAFF, PUBLIC_ACL, PRIVATE_ACL, PROJECT_EAGLE_ID, DOCUMENT_EAGLE_ID, eagleUpdate, storedProject, storedDocument
} = require('../helpers/eagle-mirror-fixtures');
const { API, useEnv, wireQueue, wireEagle, keys } = require('../helpers/sync-out-eagle');
const { mirrorStore } = require('../helpers/mirror-store');

audit._setTransport(async () => {});

const ROW_ID = '7d1e2f40-0000-4000-8000-0000000000cc';
const EAGLE_ID = '6720b3c0a1b2c3d4e5f6071a';
const NATIVE_NOTIFICATION_ID = '7d1e2f40-0000-4000-8000-0000000000dd';
const NOTIFICATION_EAGLE_ID = '6720b3c0a1b2c3d4e5f6071b';
const NATIVE_DOCUMENT_ID = '7d1e2f40-0000-4000-8000-0000000000ee';
const OBJECT_ID = /^[0-9a-f]{24}$/;

const ENV = {
  SYNC_OUT_QUEUE: 'sync-out',
  SYNC_OUT_EAGLE_ENABLED: 'true',
  SYNC_OUT_EAGLE_UPDATE_ENABLED: 'true',
  SYNC_OUT_EAGLE_NATIVE_ENABLED: 'true',
  EAGLE_PROTECTED_API_BASE: API,
  EAGLE_KC_CLIENT_ID: 'demi-sync-out',
  EAGLE_KC_CLIENT_SECRET: 'not-a-real-value'
};

/** A published Update as `domain/updates.js` creates it, after one write. */
function nativeUpdate(overrides = {}) {
  return {
    container: 'updates',
    id: ROW_ID,
    eagleId: null,
    sourceSystem: 'demi',
    syncVersion: 1,
    projectId: PROJECT_EAGLE_ID,
    headline: 'Open house in Merritt',
    content: '<p>Come and ask questions.</p>',
    type: 'News',
    pinned: false,
    status: 'published',
    active: true,
    publishDate: '2026-10-01T00:00:00.000Z',
    featuredImage: null,
    images: [],
    attachments: [],
    regions: ['Thompson-Nicola'],
    read: [...PUBLIC_ACL],
    isPublished: true,
    sources: { demi: { read: [...PUBLIC_ACL], status: 'published' } },
    ...overrides
  };
}

const parent = () => ({ container: 'projects', ...storedProject() });
const message = () => ({ kind: UPDATE, consumer: 'eagle', id: ROW_ID, projectId: PROJECT_EAGLE_ID, attempt: 1 });
const run = () => syncOut.run(message(), { maxAttempts: 3 });
const rowOf = store => store.rows('updates').find(r => r.id === ROW_ID);
const push = async (eagleId, doc) => {
  const res = mockRes();
  await updateController.upsertFromEagle(
    { params: { eagleId }, query: {}, user: STAFF, body: { doc, pushedAt: Date.now() } }, res);
  return res;
};

test('sync-out of DEMI-created Updates', async (t) => {
  t.beforeEach((tt) => {
    useEnv(tt, ENV);
    eagle.clearToken();
    for (const level of ['info', 'warn', 'error', 'debug']) tt.mock.method(logger, level, () => {});
  });

  await t.test('a create is POSTed under a minted id and its echo lands on the row without changing it', async (tt) => {
    const store = mirrorStore(tt, [nativeUpdate(), parent()]);
    const sent = wireQueue(tt);
    let echo = null;
    let before = null;
    let echoed = null;
    const calls = wireEagle(tt, {
      // eagle-api awaits its push to DEMI before it answers the POST.
      'POST /recentActivity': async (body) => {
        before = rowOf(store);
        echo = await push(body._id, eagleUpdate({ ...body, read: PUBLIC_ACL }));
        echoed = rowOf(store);
        return { body: { ...body } };
      }
    });

    const result = await run();

    const posted = calls[0].body._id;
    assert.match(posted, OBJECT_ID);
    assert.strictEqual(before.eagleId, posted, 'the minted id is stored before the POST');
    assert.strictEqual(calls[0].body.project, PROJECT_EAGLE_ID);
    assert.strictEqual(echo.statusCode, 200, 'the echo is accepted');
    const { sources, _etag, eaglePushedAt: _pushedAt, ...fields } = echoed;
    const { sources: _s, _etag: _e, ...was } = before;
    assert.deepStrictEqual(fields, was, 'the echo changed no DEMI field, syncOut or syncVersion');
    assert.strictEqual(sources.eagle._id, posted, 'the echo landed on this row');
    assert.strictEqual(store.rows('updates').length, 1, 'the echo made no second row');
    assert.strictEqual(result.eagleId, posted);
    assert.strictEqual(rowOf(store).syncOut.eagle.sentVersion, 1);
    assert.deepStrictEqual(sent, [], 'the echo queues nothing');
  });

  await t.test('an Eagle push for a native Update leaves DEMI-owned fields unchanged', async (tt) => {
    const store = mirrorStore(tt, [nativeUpdate({ eagleId: EAGLE_ID, syncVersion: 3 }), parent()]);
    const doc = eagleUpdate({ _id: EAGLE_ID, headline: 'Changed in Eagle', status: 'draft', active: false, read: PRIVATE_ACL });

    const res = await push(EAGLE_ID, doc);

    assert.strictEqual(res.statusCode, 200);
    const stored = rowOf(store);
    assert.strictEqual(stored.headline, 'Open house in Merritt');
    assert.strictEqual(stored.status, 'published');
    assert.deepStrictEqual(stored.read, PUBLIC_ACL);
    assert.strictEqual(stored.syncVersion, 3);
    assert.strictEqual(stored.sources.eagle.headline, 'Changed in Eagle', 'the raw copy is kept');
    assert.strictEqual(store.rows('updates').length, 1, 'no row under the Eagle id');
  });

  await t.test('a create answered 409 is PUT under the minted id', async (tt) => {
    const store = mirrorStore(tt, [nativeUpdate(), parent()]);
    wireQueue(tt);
    const calls = wireEagle(tt, { 'POST /recentActivity': { status: 409 }, 'PUT *': { body: {} } });

    const result = await run();

    const minted = calls[0].body._id;
    assert.deepStrictEqual(keys(calls), ['POST /recentActivity', `PUT /recentActivity/${minted}`]);
    assert.deepStrictEqual(result, { status: 'sent', eagleId: minted });
    assert.strictEqual(rowOf(store).syncOut.eagle.sentVersion, 1);
  });

  await t.test('a pinned create is PUT after the POST, which stores every Update unpinned', async (tt) => {
    mirrorStore(tt, [nativeUpdate({ pinned: true }), parent()]);
    wireQueue(tt);
    const calls = wireEagle(tt, { 'POST /recentActivity': body => ({ body: { _id: body._id } }), 'PUT *': { body: {} } });

    await run();

    const minted = calls[0].body._id;
    assert.deepStrictEqual(keys(calls), ['POST /recentActivity', `PUT /recentActivity/${minted}`]);
    assert.strictEqual(calls[1].body.pinned, true);
  });

  await t.test('a parent and documents DEMI created are sent by their Eagle ids', async (tt) => {
    mirrorStore(tt, [
      nativeUpdate({
        eagleId: EAGLE_ID,
        projectId: NATIVE_NOTIFICATION_ID,
        featuredImage: { document: NATIVE_DOCUMENT_ID, alt: 'Site', caption: null, credit: null },
        attachments: [DOCUMENT_EAGLE_ID]
      }),
      { container: 'notifications', id: NATIVE_NOTIFICATION_ID, eagleId: NOTIFICATION_EAGLE_ID, sourceSystem: 'demi', read: PUBLIC_ACL },
      { container: 'documents', ...storedDocument({ id: NATIVE_DOCUMENT_ID, eagleId: '6720b3c0a1b2c3d4e5f6071c' }) },
      { container: 'documents', ...storedDocument({ eagleId: DOCUMENT_EAGLE_ID }) }
    ]);
    wireQueue(tt);
    const calls = wireEagle(tt, { 'PUT *': { body: {} } });

    assert.deepStrictEqual(await run(), { status: 'sent', eagleId: EAGLE_ID });

    assert.strictEqual(calls[0].body.project, NOTIFICATION_EAGLE_ID);
    assert.strictEqual(calls[0].body.featuredImage.document, '6720b3c0a1b2c3d4e5f6071c');
    assert.deepStrictEqual(calls[0].body.attachments, [DOCUMENT_EAGLE_ID]);
  });

  await t.test('an Update naming a document Eagle does not hold yet sends nothing', async (tt) => {
    const store = mirrorStore(tt, [
      nativeUpdate({ eagleId: EAGLE_ID, attachments: [NATIVE_DOCUMENT_ID] }),
      parent(),
      { container: 'documents', ...storedDocument({ id: NATIVE_DOCUMENT_ID, eagleId: null }) }
    ]);
    wireQueue(tt);
    const calls = wireEagle(tt, {});

    assert.deepStrictEqual(await run(), { retryQueued: 2 });

    assert.match(logger.error.mock.calls[0].arguments[0], /document \S+ of update \S+ has no eagleId/);
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(rowOf(store).syncOut, undefined);
  });

  await t.test('with SYNC_OUT_EAGLE_UPDATE_ENABLED off nothing is queued or sent', async (tt) => {
    useEnv(tt, { SYNC_OUT_EAGLE_UPDATE_ENABLED: 'false' });
    mirrorStore(tt, [nativeUpdate(), parent()]);
    const sent = wireQueue(tt);
    const calls = wireEagle(tt, {});

    assert.deepStrictEqual(await syncOut.enqueue(nativeUpdate(), { kind: UPDATE }), []);
    assert.deepStrictEqual(await run(), { skipped: 'disabled' });

    assert.deepStrictEqual(sent, []);
    assert.deepStrictEqual(calls, []);
  });
});
