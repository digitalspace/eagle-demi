'use strict';

// Which eagle-api calls a document send makes for DEMI's feature state and delete flag. eagle-api moves
// `isFeatured` only through /feature and /unfeature, and /feature answers 403 at its per-project limit.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { logger } = require('../../src/utils/logger');
const syncOut = require('../../src/sync-out');
const eagle = require('../../src/sync-out/eagle');
const consumer = require('../../src/sync-out/eagle-document');
const { DOCUMENT } = require('../../src/sync-out/kinds');
const { mirrorStore } = require('../helpers/mirror-store');
const { API, useEnv, wireQueue, wireEagle, keys } = require('../helpers/sync-out-eagle');

const EAGLE_ID = '5cf00c03a266b7e1877504dd';
const PARENT_EAGLE_ID = '5cf00c03a266b7e1877504db';
const ROW_ID = '7d1e2f40-0000-4000-8000-0000000000f1';
const PUBLIC_ACL = ['public', 'staff', 'sysadmin'];
const STAFF_ACL = ['staff', 'sysadmin'];

const ENV = {
  SYNC_OUT_EAGLE_ENABLED: 'true',
  SYNC_OUT_EAGLE_DOCUMENT_ENABLED: 'true',
  SYNC_OUT_EAGLE_NATIVE_ENABLED: 'true',
  EAGLE_PROTECTED_API_BASE: API,
  EAGLE_KC_CLIENT_ID: 'demi-sync-out',
  EAGLE_KC_CLIENT_SECRET: 'not-a-real-value'
};

const at = (path, id = EAGLE_ID) => `/document/${id}${path}`;
const PUT = `PUT ${at('')}`;
const FEATURE = `PUT ${at('/feature')}`;
const UNFEATURE = `PUT ${at('/unfeature')}`;
const PUBLISH = `PUT ${at('/publish')}`;
const UNPUBLISH = `PUT ${at('/unpublish')}`;
const POST = 'POST /document/stored';

/** A DEMI row Eagle holds under EAGLE_ID, with Eagle's echo at `echo` when given. */
const sentRow = ({ echo, ...overrides } = {}) => ({
  id: ROW_ID,
  projectId: '1234',
  sourceSystem: 'demi',
  eagleId: EAGLE_ID,
  syncVersion: 2,
  displayName: 'Draft plan',
  s3Key: 'docs/draft-plan.pdf',
  read: PUBLIC_ACL,
  isPublished: true,
  ...(echo ? { sources: { eagle: { _id: EAGLE_ID, ...echo } } } : {}),
  ...overrides
});

/** A DEMI row Eagle does not hold yet. */
const newRow = (overrides = {}) => ({
  id: ROW_ID, projectId: '1234', sourceSystem: 'demi', displayName: 'Report', s3Key: 'p/abc.pdf',
  read: STAFF_ACL, isPublished: false, ...overrides
});

function wireRow(t, row) {
  const store = mirrorStore(t, [
    { container: 'projects', id: '1234', eagleId: PARENT_EAGLE_ID },
    { container: 'documents', ...row }
  ]);
  return () => store.rows('documents').find(r => r.id === ROW_ID);
}

const run = () => syncOut.run({ kind: DOCUMENT, consumer: 'eagle', id: ROW_ID, projectId: '1234', attempt: 1 });

test('document feature state and delete flag in Eagle', async (t) => {
  t.beforeEach((tt) => {
    useEnv(tt, ENV);
    eagle.clearToken();
    for (const level of ['info', 'warn', 'error']) tt.mock.method(logger, level, () => {});
    wireQueue(tt);
  });

  await t.test('a featured row whose echo is not featured is featured after the PUT', async (tt) => {
    wireRow(tt, sentRow({ isFeatured: true, echo: { read: PUBLIC_ACL, isFeatured: false } }));
    const calls = wireEagle(tt, { [PUT]: {}, [FEATURE]: {} });

    await run();

    assert.deepStrictEqual(keys(calls), [PUT, FEATURE]);
  });

  await t.test('an unfeatured row whose echo is featured is unfeatured', async (tt) => {
    wireRow(tt, sentRow({ isFeatured: false, echo: { read: PUBLIC_ACL, isFeatured: true } }));
    const calls = wireEagle(tt, { [PUT]: {}, [UNFEATURE]: {} });

    await run();

    assert.deepStrictEqual(keys(calls), [PUT, UNFEATURE]);
  });

  await t.test('without an echo, the feature a send made is not made again', async (tt) => {
    const rowOf = wireRow(tt, sentRow({ isFeatured: true, syncOut: { eagle: { status: 'sent', sentVersion: 1, published: true } } }));
    const calls = wireEagle(tt, { [PUT]: {}, [FEATURE]: {} });
    await run();
    assert.strictEqual(rowOf().syncOut.eagle.featured, true);
    rowOf().syncVersion = 3;

    await run();

    assert.deepStrictEqual(keys(calls), [PUT, FEATURE, PUT]);
  });

  await t.test('with neither echo nor send, Eagle\'s own featured answer stops a second feature', async (tt) => {
    wireRow(tt, sentRow({ isFeatured: true }));
    const GET = `GET ${at('?fields=isFeatured')}`;
    const calls = wireEagle(tt, { [GET]: { body: [{ _id: EAGLE_ID, read: PUBLIC_ACL, isFeatured: true }] }, [PUT]: {} });

    await run();

    assert.deepStrictEqual(keys(calls), [GET, PUT]);
  });

  await t.test('Eagle\'s 403 at its featured limit fails the send and logs the limit', async (tt) => {
    const rowOf = wireRow(tt, sentRow({ isFeatured: true, echo: { read: PUBLIC_ACL, isFeatured: false } }));
    wireEagle(tt, { [PUT]: {}, [FEATURE]: { status: 403, body: { status: 403, message: 'Feature document limit reached', limit: 5 } } });

    const result = await run();

    assert.match(result.failed, /feature: HTTP 403/);
    assert.strictEqual(rowOf().syncOut.eagle.status, 'failed');
    const lines = logger.error.mock.calls.filter(c => String(c.arguments[0]).includes('limit of 5 featured documents'));
    assert.strictEqual(lines.length, 1);
  });

  await t.test('a deleted row Eagle has never held is not wanted and not created', async (tt) => {
    const row = newRow({ isDeleted: true });
    wireRow(tt, row);
    const calls = wireEagle(tt, {});

    assert.strictEqual(consumer.wants(row), false);
    await run();

    assert.deepStrictEqual(keys(calls), []);
  });

  await t.test('a featured create is featured in Eagle after the POST', async (tt) => {
    const rowOf = wireRow(tt, newRow({ isFeatured: true }));
    const calls = wireEagle(tt, {
      [POST]: body => ({ body: { _id: body._id } }),
      'GET *': () => ({ body: [{ _id: rowOf().eagleId, read: STAFF_ACL, isFeatured: false }] }),
      'PUT *': {}
    });

    await run();

    const id = rowOf().eagleId;
    assert.deepStrictEqual(keys(calls), [POST, `GET ${at('?fields=isFeatured', id)}`, `PUT ${at('/feature', id)}`]);
  });

  await t.test('a document under a notification is created under the notification\'s Eagle id', async (tt) => {
    const NOTIFICATION_ID = 'n-5f0e4a0c';
    const NOTIFICATION_EAGLE_ID = '5f0e4a0c3f4b1a0021a1b2c3';
    mirrorStore(tt, [
      { container: 'notifications', id: NOTIFICATION_ID, eagleId: NOTIFICATION_EAGLE_ID },
      { container: 'documents', ...newRow({ projectId: NOTIFICATION_ID }) }
    ]);
    const calls = wireEagle(tt, { [POST]: body => ({ body: { _id: body._id } }), 'GET *': { body: [{ read: STAFF_ACL }] } });

    await syncOut.run({ kind: DOCUMENT, consumer: 'eagle', id: ROW_ID, projectId: NOTIFICATION_ID, attempt: 1 });

    assert.strictEqual(calls.find(c => c.key === POST)?.body.project, NOTIFICATION_EAGLE_ID);
  });

  await t.test('a deleted row Eagle holds as public is unpublished, never deleted, whatever its read says', async (tt) => {
    wireRow(tt, sentRow({ isDeleted: true, read: PUBLIC_ACL, echo: { read: PUBLIC_ACL } }));
    const calls = wireEagle(tt, { [PUT]: {}, [UNPUBLISH]: {} });

    await run();

    assert.deepStrictEqual(keys(calls), [PUT, UNPUBLISH]);
  });

  await t.test('a deleted row whose read still holds public is not published', async (tt) => {
    wireRow(tt, sentRow({ isDeleted: true, read: PUBLIC_ACL, echo: { read: STAFF_ACL } }));
    const calls = wireEagle(tt, { [PUT]: {}, [PUBLISH]: {} });

    await run();

    assert.deepStrictEqual(keys(calls), [PUT]);
  });

  await t.test('a deleted row featured in Eagle is unfeatured, as DEMI\'s limit counts no deleted row', async (tt) => {
    wireRow(tt, sentRow({ isDeleted: true, isFeatured: true, read: STAFF_ACL, echo: { read: STAFF_ACL, isFeatured: true } }));
    const calls = wireEagle(tt, { [PUT]: {}, [UNFEATURE]: {} });

    await run();

    assert.deepStrictEqual(keys(calls), [PUT, UNFEATURE]);
  });
});
