'use strict';

/**
 * The two document write paths against a row that moved under them.
 *
 * Both rebuild the whole item from a snapshot and upsert it, and a Cosmos upsert REPLACES. So an
 * unguarded write silently undid whatever landed between the read and the write: a
 * `parentFieldsPending` clear came back from the dead and left the reconcile offering a document
 * whose chunks are already current, and a parent field another writer had just moved was reverted
 * with no flag raised at all — the stale snapshot agreed with the reverted value, so nothing saw a
 * change and the chunks kept answering the newer one.
 *
 * The etag turns both into a 412 the write rebuilds from. What is asserted here is the rebuild:
 * that the row which finally lands carries the OTHER writer's values, and that the re-stamp token
 * it mints beats the one that is actually stored.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const documents = require('../../../src/repositories/documents');
const projects = require('../../../src/repositories/projects');
const chunks = require('../../../src/repositories/chunks');
const aiSearch = require('../../../src/search/ai-search');
const documentController = require('../../../src/controllers/nosql/document');
const { logger } = require('../../../src/utils/logger');
const {
  mockRes, STAFF, storedDocument, storedProject: storedProjectRow,
  DOCUMENT_EAGLE_ID, PROJECT_EAGLE_ID, TYPE_ID, MILESTONE_ID
} = require('../../helpers/eagle-mirror-fixtures');

const DOC_ID = DOCUMENT_EAGLE_ID;
const NEW_TYPE_ID = 'cccccccccccccccccccccccc';
const OTHER_TYPE_ID = 'dddddddddddddddddddddddd';
/** The revision the first read saw, and the one the row moved to. */
const ETAG_READ = '"0x8DC1"';
const ETAG_LANDED = '"0x8DC2"';
const TOKEN = '2026-09-01T00:00:00.000Z';

/** What Cosmos answers a write whose row moved — `documents.upsert` normalises it to this. */
const lostRace = () => Object.assign(new Error('lost its etag race'), { code: 412 });

/** A raw Eagle document, as eagle-api pushes it. */
const eagleDocument = (overrides = {}) => ({
  _id: DOC_ID,
  project: PROJECT_EAGLE_ID,
  displayName: 'Application',
  documentFileName: 'application.pdf',
  read: ['public', 'sysadmin'],
  type: TYPE_ID,
  milestone: MILESTONE_ID,
  ...overrides
});

/**
 * Answers each read with the next row in `rows`, keeping the last one for every read after that,
 * and 412s the first `losses` upserts. The recorded upserts are what every case here asserts on.
 */
function raceWith(t, rows, losses) {
  let read = 0;
  t.mock.method(documents, 'getById', async () => rows[Math.min(read++, rows.length - 1)]);
  const upserted = [];
  t.mock.method(documents, 'upsert', async (item, options) => {
    upserted.push({ item, options });
    if (upserted.length <= losses) throw lostRace();
    return item;
  });
  t.mock.method(aiSearch, 'writeAcls', async () => 0);
  t.mock.method(chunks, 'setParentFieldsForDocument', async () =>
    ({ succeeded: 1, failed: 0, skippedNewer: 0, statusCounts: {}, requestCharge: 1 }));
  t.mock.method(documents, 'setParentFieldsPending', async () =>
    ({ status: 'raised', pendingAt: TOKEN }));
  t.mock.method(logger, 'warn', () => {});
  return upserted;
}

const editDisplayName = (res = mockRes()) => documentController.updateDocument({
  params: { id: DOC_ID }, query: {}, user: STAFF, body: { displayName: 'Application (revised)' }
}, res);

const push = (doc, pushedAt) => documentController.upsertFromEagle({
  params: { eagleId: DOC_ID }, query: {}, user: STAFF, body: { doc, pushedAt }
}, mockRes());

/** Two stamps eagle-api could have sent, oldest first, a clear gap apart. */
const OLDER = 1757980000000;
const NEWER = 1757980005000;

test('a staff edit writes only while the row is still the revision it read', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const upserted = raceWith(t, [storedDocument({ _etag: ETAG_READ })], 0);

  const res = await editDisplayName();

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(upserted.length, 1);
  assert.strictEqual(upserted[0].options && upserted[0].options.etag, ETAG_READ,
    'without the condition the write replaces whatever landed since the read');
});

test('a pending flag cleared under a staff edit is not written back', async (t) => {
  // The re-stamp walked, cleared the flag, and this edit read the row before that landed. Writing
  // the snapshot back raises the flag again for a walk that has already happened, and the
  // reconcile then offers a document whose chunks are current until an operator clears it by hand.
  t.afterEach(() => t.mock.restoreAll());

  const upserted = raceWith(t, [
    storedDocument({ _etag: ETAG_READ, parentFieldsPending: true, parentFieldsPendingAt: TOKEN }),
    storedDocument({ _etag: ETAG_LANDED, parentFieldsPending: false, parentFieldsPendingAt: null })
  ], 1);

  const res = await editDisplayName();

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(upserted.length, 2, 'the lost write has to be rebuilt and sent again');
  assert.strictEqual(upserted[1].item.parentFieldsPending, false);
  assert.strictEqual(upserted[1].item.parentFieldsPendingAt, null);
  assert.strictEqual(upserted[1].options.etag, ETAG_LANDED,
    'the retry is guarded on the revision it rebuilt from, not the one it first read');
});

test('a parent field another writer moved is not reverted by a staff edit', async (t) => {
  // The quiet half. This edit touches the name only, so the re-typed value should survive it —
  // and rebuilding onto the stored row is the only thing that keeps it, because
  // `stampParentFieldsPending` compares the snapshot against the row it builds and a revert to
  // the snapshot's own value looks like no change at all.
  t.afterEach(() => t.mock.restoreAll());

  const upserted = raceWith(t, [
    storedDocument({ _etag: ETAG_READ, typeId: TYPE_ID }),
    storedDocument({ _etag: ETAG_LANDED, typeId: OTHER_TYPE_ID })
  ], 1);

  const res = await editDisplayName();

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(upserted[1].item.typeId, OTHER_TYPE_ID,
    'the re-type was undone, and the chunks that carry it now disagree with the row');
  assert.strictEqual(upserted[1].item.displayName, 'Application (revised)',
    'the edit itself still has to land');
});

test('a staff edit that keeps losing answers 409 instead of overwriting', async (t) => {
  // Three rebuilds is the same bound the repository puts on a raise. Past it nothing is known
  // about what is stored, and the honest answer is "read it again", not a row built from a
  // revision that is already gone.
  t.afterEach(() => t.mock.restoreAll());

  const upserted = raceWith(t, [storedDocument({ _etag: ETAG_READ })], Infinity);

  const res = await editDisplayName();

  assert.strictEqual(res.statusCode, 409);
  assert.match(res.body.error, /changed/);
  assert.strictEqual(upserted.length, 3, 'the retry bound is what stops this spinning');
});

test('a document deleted under a staff edit answers 404, not a resurrection', async (t) => {
  // An upsert would put the deleted row back, chunks and index entries gone.
  t.afterEach(() => t.mock.restoreAll());

  const upserted = raceWith(t, [storedDocument({ _etag: ETAG_READ }), null], 1);

  const res = await editDisplayName();

  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(upserted.length, 1, 'there is nothing left to write the edit onto');
});

test('an eagle push rebuilds onto the row that landed', async (t) => {
  // Same failure on the busier path: extraction state and the pending flag are carried off the
  // stored row, so a push built from a stale read writes both of them back as they were.
  t.afterEach(() => t.mock.restoreAll());
  t.mock.method(projects, 'getByEagleId', async () => ({ ...storedProjectRow(), isPublished: true }));

  const upserted = raceWith(t, [
    storedDocument({ _etag: ETAG_READ, parentFieldsPending: true, parentFieldsPendingAt: TOKEN }),
    storedDocument({ _etag: ETAG_LANDED, parentFieldsPending: false, parentFieldsPendingAt: null })
  ], 1);

  const res = await push(eagleDocument());

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(upserted.length, 2);
  // The push carries the flag forward only from a row that still holds it (`carriedPending` in
  // src/seed/transform.js), so rebuilding onto the cleared row leaves it off entirely.
  assert.ok(!upserted[1].item.parentFieldsPending,
    'the cleared flag came back, and the reconcile now offers a document that is already current');
  assert.strictEqual(upserted[1].options.etag, ETAG_LANDED);
});

test('the raise a retried push leaves is minted off the row that landed', async (t) => {
  // Two writers that read the same row mint the same token, and then the first one's clear takes
  // the second one's flag down. The token has to beat what is STORED, which is only knowable
  // after the re-read — so it is minted per try, not carried over from the first build.
  t.afterEach(() => t.mock.restoreAll());
  t.mock.method(projects, 'getByEagleId', async () => ({ ...storedProjectRow(), isPublished: true }));

  // Another raise landed while this push was in flight, with a token this one has to beat.
  const alreadyRaisedAt = new Date(Date.now() + 60000).toISOString();
  const upserted = raceWith(t, [
    storedDocument({ _etag: ETAG_READ, typeId: TYPE_ID, parentFieldsPendingAt: TOKEN }),
    storedDocument({
      _etag: ETAG_LANDED, typeId: TYPE_ID,
      parentFieldsPending: true, parentFieldsPendingAt: alreadyRaisedAt
    })
  ], 1);

  const res = await push(eagleDocument({ type: NEW_TYPE_ID }));

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(upserted[1].item.typeId, NEW_TYPE_ID, 'the push still has to land its re-type');
  assert.ok(upserted[1].item.parentFieldsPendingAt > alreadyRaisedAt,
    'a token minted off the stale row repeats one that is already stored, and one clear then ' +
    `takes down two raises: ${upserted[1].item.parentFieldsPendingAt} is not later than ` +
    `${alreadyRaisedAt}`);
});

test('an eagle push that keeps losing asks to be sent again', async (t) => {
  // eagle-api's push client retries a 500-and-up and gives up on everything below it
  // (eagle-api api/helpers/pushClient.js), so a 409 here would drop the push on the floor and
  // leave DEMI holding the pre-push record with nothing to say so.
  t.afterEach(() => t.mock.restoreAll());
  t.mock.method(projects, 'getByEagleId', async () => ({ ...storedProjectRow(), isPublished: true }));

  const upserted = raceWith(t, [storedDocument({ _etag: ETAG_READ })], Infinity);

  const res = await push(eagleDocument());

  assert.ok(res.statusCode >= 500, `a retryable answer is the point, got ${res.statusCode}`);
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(upserted.length, 3);
});

test('a document push older than the one already stored is ignored', async (t) => {
  // The etag does not order two pods, so the stale half of a pair can read the winner's row and
  // legitimately replace it — here, re-typing a document Eagle has already re-typed again.
  t.afterEach(() => t.mock.restoreAll());
  t.mock.method(projects, 'getByEagleId', async () => ({ ...storedProjectRow(), isPublished: true }));
  t.mock.method(logger, 'info', () => {});

  const indexed = [];
  const upserted = raceWith(t,
    [storedDocument({ _etag: ETAG_READ, eaglePushedAt: NEWER, read: ['sysadmin'] })], 0);
  t.mock.method(aiSearch, 'writeAcls', async (_index, rows) => { indexed.push(...rows); return 0; });

  const res = await push(eagleDocument({ type: OTHER_TYPE_ID }), OLDER);

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, { ok: true, ignored: 'stale', eaglePushedAt: NEWER });
  assert.strictEqual(upserted.length, 0, 'the stale body was written over the newer one');
  assert.deepStrictEqual(indexed, [], 'a push that wrote nothing must not move the index row');
});

test('a staff PUT cannot set the push stamp', async (t) => {
  // `eaglePushedAt` is catalogued at vis 2, so a staff caller sees it on a GET and can send it
  // back. An old stamp replayed onto the row makes every later eagle-api push read as stale.
  t.afterEach(() => t.mock.restoreAll());

  const upserted = raceWith(t, [storedDocument({ _etag: ETAG_READ, eaglePushedAt: NEWER })], 0);

  const res = await documentController.updateDocument({
    params: { id: DOC_ID },
    query: {},
    user: STAFF,
    body: { displayName: 'Application (revised)', eaglePushedAt: OLDER }
  }, mockRes());

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(upserted[0].item.eaglePushedAt, NEWER);
  assert.strictEqual(upserted[0].item.displayName, 'Application (revised)');
});

test('a document push one millisecond older than the stored stamp is ignored', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.mock.method(projects, 'getByEagleId', async () => ({ ...storedProjectRow(), isPublished: true }));

  const upserted = raceWith(t, [storedDocument({ _etag: ETAG_READ, eaglePushedAt: NEWER })], 0);

  const res = await push(eagleDocument({ type: NEW_TYPE_ID }), NEWER - 1);

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, { ok: true, ignored: 'stale', eaglePushedAt: NEWER });
  assert.strictEqual(upserted.length, 0, 'no tolerance: one millisecond older still loses');
});

test('a document push equal to the stored stamp writes', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.mock.method(projects, 'getByEagleId', async () => ({ ...storedProjectRow(), isPublished: true }));

  const upserted = raceWith(t, [storedDocument({ _etag: ETAG_READ, eaglePushedAt: NEWER })], 0);

  const res = await push(eagleDocument({ type: NEW_TYPE_ID }), NEWER);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(upserted[0].item.eaglePushedAt, NEWER);
});

test('a newer document push writes, and stores the stamp it was ordered by', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.mock.method(projects, 'getByEagleId', async () => ({ ...storedProjectRow(), isPublished: true }));

  const upserted = raceWith(t, [storedDocument({ _etag: ETAG_READ, eaglePushedAt: OLDER })], 0);

  const res = await push(eagleDocument({ type: NEW_TYPE_ID }), NEWER);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(upserted[0].item.typeId, NEW_TYPE_ID);
  assert.strictEqual(upserted[0].item.eaglePushedAt, NEWER,
    'without the stamp on the row the next push has nothing to be ordered against');
});
