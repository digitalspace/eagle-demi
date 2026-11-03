'use strict';

// Comments created in DEMI, sent to Eagle through the real comments adapter over an in-memory container, and the
// Eagle mirror's handling of their echo.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const audit = require('../../src/utils/audit');
const { logger } = require('../../src/utils/logger');
const syncOut = require('../../src/sync-out');
const eagle = require('../../src/sync-out/eagle');
const consumer = require('../../src/sync-out/eagle-comment');
const { COMMENT, COMMENT_PERIOD, DOCUMENT, UPDATE, kindOf } = require('../../src/sync-out/kinds');
const commentController = require('../../src/controllers/nosql/comment');
const {
  mockRes, STAFF, PUBLIC_ACL, PRIVATE_ACL, PERIOD_EAGLE_ID, eagleComment, storedProject
} = require('../helpers/eagle-mirror-fixtures');
const { API, useEnv, wireQueue, wireEagle, keys } = require('../helpers/sync-out-eagle');
const { mirrorStore } = require('../helpers/mirror-store');
const { fakeWhereQuery } = require('../helpers/updates-store');

audit._setTransport(async () => {});

const ROW_ID = '7d1e2f40-0000-4000-8000-0000000000c1';
const PERIOD_ROW_ID = '7d1e2f40-0000-4000-8000-0000000000c2';
const EAGLE_ID = '6720b3c0a1b2c3d4e5f6072a';
const DOCUMENT_ROW_ID = '7d1e2f40-0000-4000-8000-0000000000c3';
const DOCUMENT_EAGLE_ID = '6720b3c0a1b2c3d4e5f6072b';
const PROJECT_ID = storedProject().id;
const OBJECT_ID = /^[0-9a-f]{24}$/;

const ENV = {
  SYNC_OUT_QUEUE: 'sync-out',
  SYNC_OUT_EAGLE_ENABLED: 'true',
  SYNC_OUT_EAGLE_COMMENT_ENABLED: 'true',
  SYNC_OUT_EAGLE_NATIVE_ENABLED: 'true',
  EAGLE_PROTECTED_API_BASE: API,
  EAGLE_KC_CLIENT_ID: 'demi-sync-out',
  EAGLE_KC_CLIENT_SECRET: 'not-a-real-value',
  EAGLE_ENGAGE_MILESTONE: '5cf00c03a266b7e1877504aa'
};

/** A DEMI period sync-out has sent to Eagle under `PERIOD_EAGLE_ID`. */
function nativePeriod(overrides = {}) {
  return {
    container: 'commentPeriods',
    id: PERIOD_ROW_ID,
    projectId: PROJECT_ID,
    sourceSystem: 'demi',
    eagleId: PERIOD_EAGLE_ID,
    syncVersion: 1,
    syncOut: { eagle: { mintedId: PERIOD_EAGLE_ID, sentVersion: 1, status: 'sent' } },
    metURL: '',
    dateStarted: '2026-11-01T07:00:00.000Z',
    dateCompleted: '2026-12-01T08:00:00.000Z',
    instructions: 'Comment on the draft plan.',
    milestone: null,
    commentIdCount: 4,
    isDeleted: false,
    read: [...PUBLIC_ACL],
    sources: { demi: { read: [...PUBLIC_ACL] } },
    ...overrides
  };
}

/** A published comment as `domain/comments.js` creates it, after one write. */
function nativeComment(overrides = {}) {
  return {
    container: 'comments',
    id: ROW_ID,
    eagleId: null,
    periodId: PERIOD_ROW_ID,
    projectId: PROJECT_ID,
    sourceSystem: 'demi',
    syncVersion: 1,
    author: 'Pat Public',
    comment: 'Protect the creek.',
    dateAdded: '2026-11-02T00:00:00.000Z',
    datePosted: '2026-11-02T00:00:00.000Z',
    documents: [],
    eaoNotes: null,
    eaoStatus: 'Published',
    isAnonymous: false,
    location: 'Merritt',
    proponentNotes: null,
    proponentStatus: null,
    publishedNotes: null,
    rejectedNotes: null,
    rejectedReason: null,
    submittedCAC: false,
    valuedComponents: [],
    commentId: 4,
    read: [...PUBLIC_ACL],
    isPublished: true,
    sources: { demi: { read: [...PUBLIC_ACL] } },
    ...overrides
  };
}

const parent = () => ({ container: 'projects', ...storedProject() });
/** A pending comment row as the wake-up queries see it. */
const held = (id, fields) => ({ id, sourceSystem: 'demi', syncVersion: 1, periodId: PERIOD_ROW_ID, ...fields });
const run = (id = ROW_ID) => syncOut.run({ kind: COMMENT, consumer: 'eagle', id, projectId: PROJECT_ID, attempt: 1 },
  { maxAttempts: 3 });
const rowOf = store => store.rows('comments').find(r => r.id === ROW_ID);
/** The consumer's send of the stored row, with the engine's guarded write. */
const sendStored = store => consumer.send(rowOf(store),
  { update: mutate => syncOut.updateRow(kindOf(COMMENT).repo, ROW_ID, PROJECT_ID, mutate) });
const push = async (eagleId, doc) => {
  const res = mockRes();
  await commentController.upsertFromEagle(
    { params: { eagleId }, query: {}, user: STAFF, body: { doc, pushedAt: Date.now() } }, res);
  return res;
};

test('sync-out of DEMI-created comments', async (t) => {
  t.beforeEach((tt) => {
    useEnv(tt, ENV);
    eagle.clearToken();
    for (const level of ['info', 'warn', 'error', 'debug']) tt.mock.method(logger, level, () => {});
  });

  await t.test("a create is POSTed under a minted id with its period's Eagle id, and its echo leaves the row as it was",
    async (tt) => {
      const store = mirrorStore(tt, [nativeComment(), nativePeriod(), parent()]);
      const sent = wireQueue(tt);
      let echo = null;
      let before = null;
      let echoed = null;
      const calls = wireEagle(tt, {
        // eagle-api awaits its push to DEMI before it answers the POST.
        'POST /comment': async (body) => {
          before = rowOf(store);
          const doc = eagleComment({ ...body, commentId: 4, read: PUBLIC_ACL });
          echo = await push(body._id, doc);
          echoed = rowOf(store);
          return { body: doc };
        }
      });

      const result = await run();

      const posted = calls[0].body._id;
      assert.match(posted, OBJECT_ID);
      assert.strictEqual(before.eagleId, posted, 'the minted id is stored before the POST');
      assert.strictEqual(calls[0].body.period, PERIOD_EAGLE_ID);
      assert.strictEqual(echo.statusCode, 200, 'the echo is accepted');
      const { sources, _etag, eaglePushedAt: _pushedAt, ...fields } = echoed;
      const { sources: _s, _etag: _e, ...was } = before;
      assert.deepStrictEqual(fields, was, 'the echo changed no DEMI field, syncOut or syncVersion');
      assert.strictEqual(sources.eagle._id, posted, 'the echo landed on this row');
      assert.strictEqual(store.rows('comments').length, 1, 'the echo made no second row');
      assert.strictEqual(result.eagleId, posted);
      assert.strictEqual(rowOf(store).syncOut.eagle.sentVersion, 1);
      assert.deepStrictEqual(sent, [], 'the echo queues nothing');
    });

  await t.test('an Eagle push for a native comment leaves DEMI-owned fields unchanged', async (tt) => {
    const store = mirrorStore(tt, [nativeComment({ eagleId: EAGLE_ID, syncVersion: 3 }), nativePeriod()]);
    const doc = eagleComment({ _id: EAGLE_ID, comment: 'Changed in Eagle', eaoStatus: 'Rejected', read: PRIVATE_ACL });

    const res = await push(EAGLE_ID, doc);

    assert.strictEqual(res.statusCode, 200);
    const stored = rowOf(store);
    assert.strictEqual(stored.comment, 'Protect the creek.');
    assert.strictEqual(stored.eaoStatus, 'Published');
    assert.deepStrictEqual(stored.read, PUBLIC_ACL);
    assert.strictEqual(stored.syncVersion, 3);
    assert.strictEqual(stored.sources.eagle.comment, 'Changed in Eagle', 'the raw copy is kept');
    assert.strictEqual(store.rows('comments').length, 1, 'no row under the Eagle id');
  });

  await t.test("an Eagle push gives a native comment Eagle's number", async (tt) => {
    const store = mirrorStore(tt, [nativeComment({ eagleId: EAGLE_ID }), nativePeriod()]);

    await push(EAGLE_ID, eagleComment({ _id: EAGLE_ID, commentId: 9 }));

    assert.strictEqual(rowOf(store).commentId, 9);
  });

  await t.test('a comment whose period is not in Eagle yet is held, nothing sent and its sync state untouched',
    async (tt) => {
      const store = mirrorStore(tt, [nativeComment(), nativePeriod({ eagleId: null, syncOut: undefined })]);
      wireQueue(tt);
      const calls = wireEagle(tt, {});

      assert.deepStrictEqual(await run(), { status: 'held' });

      assert.deepStrictEqual(calls, []);
      assert.strictEqual(rowOf(store).syncOut, undefined);
    });

  await t.test('a sent period queues the comments and Updates held on it, and no other', async (tt) => {
    useEnv(tt, { SYNC_OUT_EAGLE_UPDATE_ENABLED: 'true' });
    mirrorStore(tt, [nativePeriod({ eagleId: null, syncOut: undefined }), parent()]);
    fakeWhereQuery(tt, [
      { id: 'update-held', sourceSystem: 'demi', syncVersion: 1, pcp: PERIOD_ROW_ID },
      held('held'),
      held('other-period', { periodId: 'another-period' }),
      held('sent', { syncOut: { eagle: { sentVersion: 1 } } }),
      held('eagle-owned', { sourceSystem: 'eagle' }),
      held('stray', { syncOut: { eagle: { status: 'failed', strayEagleId: null } } }),
      held('failed', { syncOut: { eagle: { status: 'failed', failedVersion: 1 } } }),
      held('edited-after-failing', { syncVersion: 2, syncOut: { eagle: { status: 'failed', failedVersion: 1 } } })
    ]);
    const sent = wireQueue(tt);
    wireEagle(tt, { 'POST /commentperiod': body => ({ body: { _id: body._id } }) });

    const result = await syncOut.run({ kind: COMMENT_PERIOD, consumer: 'eagle', id: PERIOD_ROW_ID, projectId: PROJECT_ID });

    assert.strictEqual(result.status, 'sent');
    assert.deepStrictEqual(sent.map(m => [m.body.kind, m.body.id]),
      [[UPDATE, 'update-held'], [COMMENT, 'held'], [COMMENT, 'edited-after-failing']]);
  });

  await t.test('a sent document queues the comments and Updates held on it, and no other', async (tt) => {
    useEnv(tt, { SYNC_OUT_EAGLE_DOCUMENT_ENABLED: 'true', SYNC_OUT_EAGLE_UPDATE_ENABLED: 'true' });
    mirrorStore(tt, [parent(), {
      container: 'documents', id: DOCUMENT_ROW_ID, projectId: PROJECT_ID, sourceSystem: 'demi', eagleId: DOCUMENT_EAGLE_ID,
      syncVersion: 2, syncOut: { eagle: { status: 'sent', sentVersion: 1, published: true } },
      displayName: 'Draft plan', s3Key: 'docs/draft-plan.pdf', read: [...PUBLIC_ACL], isPublished: true
    }]);
    fakeWhereQuery(tt, [
      { id: 'update-held', sourceSystem: 'demi', syncVersion: 1, attachments: [DOCUMENT_ROW_ID] },
      held('held', { documents: ['another-document', DOCUMENT_ROW_ID] }),
      held('names-another', { documents: ['another-document'] }),
      held('sent', { documents: [DOCUMENT_ROW_ID], syncOut: { eagle: { sentVersion: 1 } } })
    ]);
    const sent = wireQueue(tt);
    wireEagle(tt, { [`PUT /document/${DOCUMENT_EAGLE_ID}`]: {} });

    const result = await syncOut.run({ kind: DOCUMENT, consumer: 'eagle', id: DOCUMENT_ROW_ID, projectId: PROJECT_ID });

    assert.strictEqual(result.status, 'sent');
    assert.deepStrictEqual(sent.map(m => [m.body.kind, m.body.id]), [[UPDATE, 'update-held'], [COMMENT, 'held']]);
  });

  await t.test('a comment with no status is sent as Pending', async (tt) => {
    mirrorStore(tt, [nativeComment({ eagleId: EAGLE_ID, eaoStatus: null }), nativePeriod()]);
    wireQueue(tt);
    const calls = wireEagle(tt, { 'PUT *': { body: { matchedCount: 1 } } });

    await run();

    assert.strictEqual(calls[0].body.eaoStatus, 'Pending');
  });

  await t.test('a valued component that is not an Eagle id fails the send before any call', async (tt) => {
    const valuedComponents = ['5cf00c03a266b7e187750004', '7d1e2f40-0000-4000-8000-0000000000ff'];
    const store = mirrorStore(tt, [nativeComment({ eagleId: EAGLE_ID, valuedComponents }), nativePeriod()]);
    const calls = wireEagle(tt, {});

    await assert.rejects(sendStored(store), /valued component 7d1e2f40-0000-4000-8000-0000000000ff is not an Eagle id/);
    assert.deepStrictEqual(calls, []);
  });

  await t.test('a create with submittedCAC is PUT after the POST, which does not copy it', async (tt) => {
    mirrorStore(tt, [nativeComment({ submittedCAC: true }), nativePeriod()]);
    wireQueue(tt);
    const calls = wireEagle(tt, { 'POST /comment': body => ({ body: { _id: body._id } }), 'PUT *': { body: { matchedCount: 1 } } });

    await run();

    const minted = calls[0].body._id;
    assert.deepStrictEqual(keys(calls), ['POST /comment', `PUT /comment/${minted}`]);
    assert.strictEqual(calls[1].body.submittedCAC, true);
  });

  await t.test('an Eagle-owned comment row under the id stops the create before any POST', async (tt) => {
    const store = mirrorStore(tt, [
      nativeComment({ eagleId: EAGLE_ID }), nativePeriod(),
      nativeComment({ id: EAGLE_ID, eagleId: EAGLE_ID, sourceSystem: 'eagle' })
    ]);
    const calls = wireEagle(tt, { 'PUT *': { body: { matchedCount: 0 } } });

    await assert.rejects(sendStored(store), /is held by an Eagle-owned DEMI row/);
    assert.deepStrictEqual(keys(calls), [`PUT /comment/${EAGLE_ID}`]);
  });

  await t.test('a status change is sent as eaoStatus on the PUT, with no call to the status route', async (tt) => {
    mirrorStore(tt, [nativeComment({ eagleId: EAGLE_ID, eaoStatus: 'Rejected' }), nativePeriod()]);
    wireQueue(tt);
    const calls = wireEagle(tt, { 'PUT *': { body: { matchedCount: 1 } } });

    await run();

    assert.deepStrictEqual(keys(calls), [`PUT /comment/${EAGLE_ID}`]);
    assert.strictEqual(calls[0].body.eaoStatus, 'Rejected');
  });

  await t.test('a PUT that matches no Eagle comment is POSTed under the same id', async (tt) => {
    mirrorStore(tt, [nativeComment({ eagleId: EAGLE_ID }), nativePeriod()]);
    wireQueue(tt);
    const calls = wireEagle(tt, { 'PUT *': { body: { matchedCount: 0 } }, 'POST /comment': body => ({ body: { _id: body._id } }) });

    const result = await run();

    assert.deepStrictEqual(keys(calls), [`PUT /comment/${EAGLE_ID}`, 'POST /comment']);
    assert.strictEqual(calls[1].body._id, EAGLE_ID);
    assert.strictEqual(result.status, 'sent');
  });

  await t.test('with SYNC_OUT_EAGLE_COMMENT_ENABLED off nothing is queued or sent', async (tt) => {
    useEnv(tt, { SYNC_OUT_EAGLE_COMMENT_ENABLED: 'false' });
    mirrorStore(tt, [nativeComment(), nativePeriod()]);
    const sent = wireQueue(tt);
    const calls = wireEagle(tt, {});

    assert.deepStrictEqual(await syncOut.enqueue(nativeComment(), { kind: COMMENT }), []);
    assert.deepStrictEqual(await run(), { skipped: 'disabled' });

    assert.deepStrictEqual(sent, []);
    assert.deepStrictEqual(calls, []);
  });
});
