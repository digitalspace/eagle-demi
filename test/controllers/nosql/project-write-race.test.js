'use strict';

/**
 * `PUT /eagle/projects/:eagleId` against a row that moved under it.
 *
 * eagle-api pushes on every write it makes, so a single save upstream arrives here as two pushes
 * milliseconds apart: the record before the save, then the record after it. Both read the same
 * revision, both rebuilt the whole item from that snapshot, and a Cosmos upsert REPLACES — so the
 * stale one landed last and left a project that Eagle had just published sitting private in DEMI.
 * The cascade did not correct it either: `isPublished` was compared against the stale snapshot,
 * which agreed with what was written, so nothing looked like it had moved.
 *
 * Asserted here: the write carries the revision it read, a lost race is rebuilt from the row that
 * actually stored, and two pushes for one project are applied in the order they arrived.
 *
 * The etag alone only makes a lost race safe, not ordered — two eagle-api pods push the same
 * project and the older body can still be the one that rebuilds and lands last. `pushedAt` is what
 * orders them, and the last block below is about that.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const projects = require('../../../src/repositories/projects');
const documents = require('../../../src/repositories/documents');
const commentPeriods = require('../../../src/repositories/comment-periods');
const aiSearch = require('../../../src/search/ai-search');
const projectController = require('../../../src/controllers/nosql/project');
const { logger } = require('../../../src/utils/logger');
const { SEALED_TOKEN, levelOfRead } = require('../../../src/helpers/access-sql');
const {
  mockRes, STAFF, PROJECT_EAGLE_ID, PUBLIC_ACL, PRIVATE_ACL,
  eagleProject, storedEagleProject
} = require('../../helpers/eagle-mirror-fixtures');

/** The revision the first read saw, and the one the row moved to. */
const ETAG_READ = '"0x8DC1"';
const ETAG_LANDED = '"0x8DC2"';

/** What Cosmos answers a write whose row moved — `projects.upsert` normalises it to this. */
const lostRace = () => Object.assign(new Error('lost its etag race'), { code: 412 });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The pre-publish revision of the project: staff can see it, the public cannot. */
const privateProject = (overrides = {}) => storedEagleProject({
  isPublished: false, read: [...PRIVATE_ACL], ...overrides
});

const push = (doc, pushedAt) => projectController.upsertFromEagle({
  params: { eagleId: PROJECT_EAGLE_ID }, query: {}, user: STAFF, body: { doc, pushedAt }
}, mockRes());

/** The two staff write routes, which share the push path's guard. */
const staffEdit = (body, res = mockRes()) => projectController.updateProject({
  params: { id: '207' }, query: {}, user: STAFF, body
}, res);

const staffLevel = (body, res = mockRes()) => projectController.setLevel({
  params: { id: '207' }, query: {}, user: STAFF, body
}, res);

/** Three stamps eagle-api could have sent, oldest first — each a clear gap apart. */
const OLDER = 1757980000000;
const NEWER = 1757980005000;
const NEWEST = 1757980010000;

/** The cascade's three writers, silenced and recorded. Returns what each was asked to apply. */
function captureCascade(t) {
  const indexed = [];
  const cascaded = [];
  t.mock.method(aiSearch, 'writeAcls', async (index, rows) => {
    indexed.push(...rows); return rows.length;
  });
  t.mock.method(documents, 'setAclForProject', async (_access, projectId, read) => {
    cascaded.push({ projectId, read });
    return { succeeded: 0, failed: 0, rows: [] };
  });
  t.mock.method(commentPeriods, 'setAclForProject', async () =>
    ({ succeeded: 0, failed: 0, rows: [] }));
  return { indexed, cascaded };
}

/**
 * Answers each read with the next row in `rows`, keeping the last one for every read after that,
 * and 412s the first `losses` upserts. The recorded upserts are what each case asserts on.
 */
function raceWith(t, rows, losses) {
  let read = 0;
  t.mock.method(projects, 'readForWriteByEagleId', async () => rows[Math.min(read++, rows.length - 1)]);
  const upserted = [];
  t.mock.method(projects, 'upsert', async (item, options) => {
    upserted.push({ item, options });
    if (upserted.length <= losses) throw lostRace();
    return item;
  });
  t.mock.method(logger, 'warn', () => {});
  captureCascade(t);
  return upserted;
}

/**
 * A stand-in for the container: reads answer whatever is stored now, a write that carries a stale
 * revision is refused, and `delays` holds each write open so two pushes can be made to finish in
 * an order the caller chooses.
 */
function fakeStore(t, initial, delays = []) {
  let stored = initial;
  let revision = 2;
  let calls = 0;
  const upserted = [];
  t.mock.method(projects, 'readForWriteByEagleId', async () => (stored ? { ...stored } : null));
  t.mock.method(projects, 'upsert', async (item, options) => {
    const wait = delays[calls++] || 0;
    upserted.push({ item, options });
    if (wait) await sleep(wait);
    if (options && options.etag && stored && options.etag !== stored._etag) throw lostRace();
    stored = { ...item, _etag: `"0x8DC${++revision}"` };
    return { ...stored };
  });
  t.mock.method(logger, 'warn', () => {});
  return { upserted, stored: () => stored, ...captureCascade(t) };
}

test('a push writes only while the row is still the revision it read', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const upserted = raceWith(t, [privateProject({ _etag: ETAG_READ })], 0);

  const res = await push(eagleProject());

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(upserted.length, 1);
  assert.strictEqual(upserted[0].options && upserted[0].options.etag, ETAG_READ,
    'without the condition the write replaces whatever landed since the read');
});

test('a project DEMI has never seen is created, not upserted', async (t) => {
  // There is no stored revision to test against, and an IfMatch on nothing refuses every time — so
  // the insert is the guard instead. An unguarded upsert here would replace a project another push
  // created in the same instant, which is the one hole the etag cannot cover.
  t.afterEach(() => t.mock.restoreAll());

  const upserted = raceWith(t, [null], 0);

  const res = await push(eagleProject());

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(upserted[0].options, { create: true });
});

test('a create that loses to a concurrent create is re-read and rebuilt', async (t) => {
  // Cosmos answers a create on a row that now exists with 409. It means the same thing a 412 does
  // — somebody else wrote this row — so it has to be answered the same way: read what landed and
  // rebuild on it, rather than 500 and leave DEMI holding neither push.
  t.afterEach(() => t.mock.restoreAll());

  let read = 0;
  const rows = [null, privateProject({ _etag: ETAG_LANDED, shortCode: 'kq7bt2rm' })];
  t.mock.method(projects, 'readForWriteByEagleId', async () => rows[Math.min(read++, rows.length - 1)]);
  const upserted = [];
  t.mock.method(projects, 'upsert', async (item, options) => {
    upserted.push({ item, options });
    if (upserted.length === 1) throw Object.assign(new Error('created behind us'), { code: 409 });
    return item;
  });
  t.mock.method(logger, 'warn', () => {});
  captureCascade(t);

  const res = await push(eagleProject());

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(upserted.length, 2, 'the 409 has to be rebuilt and sent again');
  assert.deepStrictEqual(upserted[1].options, { etag: ETAG_LANDED },
    'the retry found a row, so it guards on the revision that row is at');
  assert.strictEqual(upserted[1].item.shortCode, 'kq7bt2rm',
    'the rebuild reads the row that landed, or the retry discards what the winner wrote');
});

test('a push that loses its race is rebuilt from the row that landed', async (t) => {
  // The nightly sync minted a short code between the read and the write. Writing the snapshot
  // back drops it, and the printed link then points at a links row nothing owns any more.
  t.afterEach(() => t.mock.restoreAll());

  const upserted = raceWith(t, [
    privateProject({ _etag: ETAG_READ }),
    privateProject({ _etag: ETAG_LANDED, shortCode: 'kq7bt2rm' })
  ], 1);

  const res = await push(eagleProject());

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(upserted.length, 2, 'the lost write has to be rebuilt and sent again');
  assert.strictEqual(upserted[1].options.etag, ETAG_LANDED,
    'the retry is guarded on the revision it rebuilt from, not the one it first read');
  assert.strictEqual(upserted[1].item.shortCode, 'kq7bt2rm',
    'the rebuild reads the merge input again, or the retry writes the stale snapshot back');
  assert.strictEqual(upserted[1].item.isPublished, true, 'the pushed record still has to land');
});

test('the cascade answers to the revision the winning write landed on', async (t) => {
  // The point of the rebuild. This push republishes a project that was private when it was read;
  // if another writer republished it first, the retry's own write moves nothing and the cascade
  // must not run — and if it was still private, it must.
  t.afterEach(() => t.mock.restoreAll());

  const store = fakeStore(t, privateProject({ _etag: ETAG_READ }));

  const res = await push(eagleProject());

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(store.stored().isPublished, true);
  assert.deepStrictEqual(store.cascaded, [{ projectId: '207', read: PUBLIC_ACL }],
    'the documents follow the project back to public');
  assert.deepStrictEqual(store.indexed, [{ id: '207', read: PUBLIC_ACL, isPublished: true }]);
});

test('an ACL change that does not flip isPublished still cascades', async (t) => {
  // Both revisions are unpublished, so `isPublished` alone reports nothing moved — while the
  // documents and periods are gated on the whole `read[]`, which did.
  t.afterEach(() => t.mock.restoreAll());

  const store = fakeStore(t, privateProject({ _etag: ETAG_READ }));

  const res = await push(eagleProject({ read: ['sysadmin', 'staff', 'idir'] }));

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(store.stored().isPublished, false);
  assert.deepStrictEqual(store.cascaded,
    [{ projectId: '207', read: ['sysadmin', 'staff', 'idir'] }]);
});

test('a push that keeps losing asks to be sent again', async (t) => {
  // eagle-api's push client retries a 500-and-up and gives up on everything below it
  // (eagle-api api/helpers/pushClient.js), so a 409 here would drop the push on the floor and
  // leave DEMI holding the pre-push record with nothing to say so.
  t.afterEach(() => t.mock.restoreAll());

  const upserted = raceWith(t, [privateProject({ _etag: ETAG_READ })], Infinity);

  const res = await push(eagleProject());

  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(upserted.length, 3, 'the retry bound is what stops this spinning');
});

test('two pushes in flight at once end on the newer record', async (t) => {
  // The incident, as prod sent it: the pre-save record and the saved record, the stale one slower
  // to land. Both build on the pre-publish revision, and without the stamp the slow one wins — so
  // a project Eagle had just published stays private here. The stamp is what decides it; nothing
  // holds either request in a queue.
  t.afterEach(() => t.mock.restoreAll());

  t.mock.method(logger, 'info', () => {});
  // The stale write is held open long enough for the fresh one to overtake it.
  const store = fakeStore(t, privateProject({ _etag: ETAG_READ, eaglePushedAt: OLDER }), [30]);

  const stale = push(eagleProject({ read: [...PRIVATE_ACL] }), NEWER);
  const fresh = push(eagleProject(), NEWEST);
  const [staleRes, freshRes] = await Promise.all([stale, fresh]);

  assert.strictEqual(staleRes.statusCode, 200);
  assert.strictEqual(freshRes.statusCode, 200);
  assert.strictEqual(store.stored().isPublished, true,
    'the stale push landed last and the project Eagle published is private in DEMI');
  assert.deepStrictEqual(store.stored().read, PUBLIC_ACL);
  assert.strictEqual(store.stored().eaglePushedAt, NEWEST);
  assert.deepStrictEqual(store.cascaded, [{ projectId: '207', read: PUBLIC_ACL }],
    'the publish cascades once, from the revision the winning write landed on');
});

test('a push older than the one already stored is ignored, not written', async (t) => {
  // The gap the etag leaves: the stale half of the pair arrives last from another pod, wins the
  // guard because it read the row the winner wrote, and republishes the record Eagle just changed.
  t.afterEach(() => t.mock.restoreAll());

  const logged = [];
  t.mock.method(logger, 'info', (message, meta) => logged.push({ message, meta }));
  const store = fakeStore(t, privateProject({ _etag: ETAG_READ, eaglePushedAt: NEWER }));

  const res = await push(eagleProject(), OLDER);

  // 200, not a 5xx: eagle-api's push client re-sends a 5xx, and there is nothing to send again.
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, { ok: true, ignored: 'stale', eaglePushedAt: NEWER });
  assert.strictEqual(store.upserted.length, 0, 'the stale body was written over the newer one');
  assert.deepStrictEqual(store.cascaded, [], 'a push that wrote nothing must not cascade');
  assert.deepStrictEqual(store.indexed, []);
  assert.strictEqual(store.stored().isPublished, false);

  const ignoredLine = logged.filter(line => /ignored/.test(line.message));
  assert.strictEqual(ignoredLine.length, 1);
  assert.deepStrictEqual(ignoredLine[0].meta, { id: '207', pushedAt: OLDER, eaglePushedAt: NEWER });
});

test('a newer push writes, and stores the stamp it was ordered by', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const store = fakeStore(t, privateProject({ _etag: ETAG_READ, eaglePushedAt: OLDER }));

  const res = await push(eagleProject(), NEWER);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(store.stored().isPublished, true);
  assert.strictEqual(store.stored().eaglePushedAt, NEWER,
    'without the stamp on the row the next push has nothing to be ordered against');
});

test('a push stamped the same millisecond as the stored one writes', async (t) => {
  // Two pushes sharing a millisecond came from one eagle-api pod, which already ordered them; this
  // one is the later of the pair and refusing it would drop half of every fast save.
  t.afterEach(() => t.mock.restoreAll());

  const store = fakeStore(t, privateProject({ _etag: ETAG_READ, eaglePushedAt: NEWER }));

  const res = await push(eagleProject(), NEWER);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(store.stored().isPublished, true);
});

test('a push one millisecond older than the stored stamp is ignored', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const store = fakeStore(t, privateProject({ _etag: ETAG_READ, eaglePushedAt: NEWER }));

  const res = await push(eagleProject(), NEWER - 1);

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, { ok: true, ignored: 'stale', eaglePushedAt: NEWER });
  assert.strictEqual(store.stored().isPublished, false, 'the stale body must not have landed');
});

test('a push carrying no stamp writes, and leaves the stored one alone', async (t) => {
  // An eagle-api build that predates the field. It cannot be ordered, so it is applied as it
  // arrives — but clearing the stamp would unorder every push behind it too.
  t.afterEach(() => t.mock.restoreAll());

  const store = fakeStore(t, privateProject({ _etag: ETAG_READ, eaglePushedAt: NEWER }));

  const res = await push(eagleProject());

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(store.stored().isPublished, true);
  assert.strictEqual(store.stored().eaglePushedAt, NEWER);
});

test('a push that loses its race is re-judged against the row that won', async (t) => {
  // The whole reason the check sits inside the guarded attempt: this push was newer than the row
  // it first read, and older than the one that landed while it was in flight.
  t.afterEach(() => t.mock.restoreAll());

  t.mock.method(logger, 'info', () => {});
  const upserted = raceWith(t, [
    privateProject({ _etag: ETAG_READ, eaglePushedAt: OLDER }),
    storedEagleProject({ _etag: ETAG_LANDED, eaglePushedAt: NEWEST })
  ], 1);

  const res = await push(eagleProject({ read: [...PRIVATE_ACL] }), NEWER);

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, { ok: true, ignored: 'stale', eaglePushedAt: NEWEST });
  assert.strictEqual(upserted.length, 1,
    'the retry rebuilt and wrote a body the winner had already superseded');
});

/**
 * The cascade is a SECOND write, after the project row has already landed. When it fails the row
 * says published while the documents, the periods and the index row still say private — and
 * eagle-api retrying the push does not fix it, because by then the visibility no longer moves
 * against the stored row and nothing looks like it needs cascading.
 */
test('a failed cascade is recorded on the row and repaired by the next push', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.mock.method(logger, 'error', () => {});

  const store = fakeStore(t, privateProject({ _etag: ETAG_READ, eaglePushedAt: OLDER }));
  const pending = [];
  t.mock.method(projects, 'patchCascadePending', async (id, at) => {
    pending.push({ id, at });
    return { id };
  });

  // This push publishes the project, and the index write the cascade starts with throws.
  t.mock.method(aiSearch, 'writeAcls', async () => { throw new Error('search is down'); });

  const failed = await push(eagleProject(), NEWER);

  assert.strictEqual(failed.statusCode, 500);
  assert.strictEqual(store.stored().isPublished, true, 'the row write itself had already landed');
  assert.strictEqual(pending.length, 1, 'a cascade nobody records is a cascade nobody runs again');
  assert.strictEqual(pending[0].id, '207');
  assert.ok(pending[0].at, 'the marker has to carry when the cascade was owed');

  // The marker is on the row the next push reads, and this push moves NOTHING: same visibility,
  // same ACL. Without the marker it would answer 200 and leave the documents behind for good.
  store.stored().cascadePendingAt = pending[0].at;
  const indexed = [];
  t.mock.method(aiSearch, 'writeAcls', async (_index, rows) => { indexed.push(...rows); return 1; });

  const repaired = await push(eagleProject(), NEWEST);

  assert.strictEqual(repaired.statusCode, 200);
  assert.deepStrictEqual(indexed, [{ id: '207', read: PUBLIC_ACL, isPublished: true }],
    'the owed cascade has to run even though this push moved no visibility');
  assert.deepStrictEqual(store.cascaded, [{ projectId: '207', read: PUBLIC_ACL }]);
  assert.deepStrictEqual(pending[1], { id: '207', at: null },
    'a marker left set makes every later push cascade for nothing');
});

test('the marker survives the merge, so a retry does not clear what it still owes', async (t) => {
  // The push rebuilds the whole row from the Eagle record, and a Cosmos write replaces the item.
  t.afterEach(() => t.mock.restoreAll());
  t.mock.method(logger, 'info', () => {});

  const store = fakeStore(t, privateProject({
    _etag: ETAG_READ, eaglePushedAt: OLDER, cascadePendingAt: '2026-09-15T00:00:00.000Z'
  }));
  t.mock.method(projects, 'patchCascadePending', async () => ({}));

  const res = await push(eagleProject({ read: [...PRIVATE_ACL] }), NEWER);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(store.stored().cascadePendingAt, '2026-09-15T00:00:00.000Z');
});

/**
 * The staff write routes take the same guard. A whole-item write from a stale snapshot undoes a
 * push that landed while the body was in flight, and the push bookkeeping is the worst of it: an
 * old stamp replayed onto the row makes every later push read as stale.
 */
const storedFor = (t, rows, losses = 0) => {
  let read = 0;
  t.mock.method(projects, 'getById', async () => rows[Math.min(read++, rows.length - 1)]);
  const upserted = [];
  t.mock.method(projects, 'upsert', async (item, options) => {
    upserted.push({ item, options });
    if (upserted.length <= losses) throw lostRace();
    return item;
  });
  t.mock.method(logger, 'warn', () => {});
  captureCascade(t);
  return upserted;
};

test('a staff PUT is guarded, and cannot set the push bookkeeping', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const upserted = storedFor(t, [privateProject({
    _etag: ETAG_READ, eaglePushedAt: NEWER, cascadePendingAt: '2026-09-15T00:00:00.000Z'
  })]);

  const res = await staffEdit({
    description: 'Edited by staff',
    eaglePushedAt: OLDER,
    cascadePendingAt: null
  });

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(upserted[0].options.etag, ETAG_READ,
    'without the condition the edit replaces whatever a push wrote since the read');
  assert.strictEqual(upserted[0].item.eaglePushedAt, NEWER,
    'a caller who can replay an old stamp can make every later push read as stale');
  assert.strictEqual(upserted[0].item.cascadePendingAt, '2026-09-15T00:00:00.000Z',
    'clearing the marker by hand loses the cascade the row is still owed');
  assert.strictEqual(upserted[0].item.description, 'Edited by staff');
});

test('a staff PUT that loses its race is rebuilt from the row that landed', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const upserted = storedFor(t, [
    privateProject({ _etag: ETAG_READ, eaglePushedAt: OLDER }),
    privateProject({ _etag: ETAG_LANDED, eaglePushedAt: NEWER, name: 'Renamed by a push' })
  ], 1);

  const res = await staffEdit({ description: 'Edited by staff' });

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(upserted.length, 2);
  assert.strictEqual(upserted[1].options.etag, ETAG_LANDED);
  assert.strictEqual(upserted[1].item.name, 'Renamed by a push',
    'the rebuild reads the stored row again, or the retry reverts the push');
  assert.strictEqual(upserted[1].item.eaglePushedAt, NEWER);
});

test('a staff PUT that keeps losing asks to be sent again', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const upserted = storedFor(t, [privateProject({ _etag: ETAG_READ })], Infinity);

  const res = await staffEdit({ description: 'Edited by staff' });

  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(upserted.length, 3, 'the retry bound is what stops this spinning');
});

test('a level change is guarded, and carries the push bookkeeping forward', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const upserted = storedFor(t, [privateProject({
    _etag: ETAG_READ, eaglePushedAt: NEWER, cascadePendingAt: '2026-09-15T00:00:00.000Z'
  })]);

  const res = await staffLevel({ level: 4, confirm: true, reason: 'The EAO published it.' });

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(upserted[0].options.etag, ETAG_READ);
  assert.strictEqual(upserted[0].item.isPublished, true);
  assert.strictEqual(upserted[0].item.eaglePushedAt, NEWER,
    'a widening that dropped the stamp would let an already-applied push land again');
  assert.strictEqual(upserted[0].item.cascadePendingAt, '2026-09-15T00:00:00.000Z');
});

test('a level change that keeps losing asks to be sent again', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const upserted = storedFor(t, [privateProject({ _etag: ETAG_READ })], Infinity);

  const res = await staffLevel({ level: 4, confirm: true, reason: 'The EAO published it.' });

  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(upserted.length, 3);
});

/**
 * The existence read against rows an ACL-gated read cannot see. The gated read missed a hidden
 * project, so the push built an Eagle-only row: a 503 loop when that row was the one hiding, and a
 * new `eagle-<id>` twin beside a hidden Track row.
 */
test('the project push finds the row whatever its ACL', async (t) => {
  const { mirrorStore } = require('../../helpers/mirror-store');
  t.afterEach(() => t.mock.restoreAll());
  const TWIN = `eagle-${PROJECT_EAGLE_ID}`;
  const track = (id, overrides = {}) => {
    const base = storedEagleProject();
    const sources = { ...base.sources, track: { ...base.sources.track, track_project_id: Number(id) } };
    return { container: 'projects', ...base, id, trackProjectId: Number(id), sources, ...overrides };
  };
  const twin = (overrides = {}) =>
    ({ container: 'projects', id: TWIN, eagleId: PROJECT_EAGLE_ID, sourceSystem: 'eagle', ...overrides });
  const quiet = () => {
    for (const level of ['info', 'warn', 'error']) t.mock.method(logger, level, () => {});
    return captureCascade(t);
  };
  // The Eagle name, which the Track merge keeps under `sources.eagle` (Track owns the top-level one).
  const eagleNames = (store) => Object.fromEntries(store.rows('projects')
    .map(r => [r.id, r.sources && r.sources.eagle ? r.sources.eagle.name : r.name]));

  await t.test('a read-less project is written, gets the pushed read, and cascades it', async () => {
    const store = mirrorStore(t, [twin({ name: 'Old name' })]);
    const { cascaded } = quiet();

    const res = await push(eagleProject());

    assert.strictEqual(res.statusCode, 200);
    const [row] = store.rows('projects');
    assert.deepStrictEqual({ id: row.id, read: row.read }, { id: TWIN, read: [...PUBLIC_ACL] });
    assert.deepStrictEqual(cascaded.map(c => c.projectId), [TWIN]);
  });

  await t.test('a sealed Track-matched project updates the Track row, keeps its seal, adds no twin', async () => {
    const store = mirrorStore(t,
      [track('351', { read: [SEALED_TOKEN], isPublished: false, name: 'Old name' })]);
    const { cascaded } = quiet();

    const res = await push(eagleProject({ name: 'Renamed in Eagle' }));

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(eagleNames(store), { 351: 'Renamed in Eagle' });
    assert.deepStrictEqual(store.rows('projects')[0].read, [SEALED_TOKEN]);
    assert.deepStrictEqual(cascaded, []);
  });

  await t.test('a Track row beside its eagle-<id> twin takes the push, and the twin narrows with it', async () => {
    const store = mirrorStore(t, [
      twin({ name: 'Twin', read: [...PUBLIC_ACL], isPublished: true }),
      track('351', { name: 'Old name' })
    ]);
    const { cascaded } = quiet();

    const res = await push(eagleProject({ name: 'Unpublished in Eagle', read: [...PRIVATE_ACL] }));

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(eagleNames(store), { [TWIN]: 'Twin', 351: 'Unpublished in Eagle' });
    const byId = Object.fromEntries(store.rows('projects').map(r => [r.id, r]));
    assert.strictEqual(levelOfRead(byId['351'].read), 2);
    assert.deepStrictEqual({ read: byId[TWIN].read, isPublished: byId[TWIN].isPublished },
      { read: byId['351'].read, isPublished: false });
    assert.deepStrictEqual(cascaded.map(c => [c.projectId, levelOfRead(c.read)]), [['351', 2], [TWIN, 2]]);
  });

  await t.test('a twin already at or below the Track row is not written', async () => {
    const store = mirrorStore(t,
      [twin({ name: 'Twin', read: [...PRIVATE_ACL], isPublished: false }), track('351')]);
    const { cascaded } = quiet();

    const res = await push(eagleProject({ name: 'Renamed in Eagle' }));

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(store.writes.map(w => [w.op, w.item && w.item.id]), [['upsert', '351']]);
    assert.deepStrictEqual(cascaded, []);
  });

  await t.test('a twin owed a cascade gets it, and its marker is removed', async () => {
    const store = mirrorStore(t, [
      twin({ name: 'Twin', read: [...PRIVATE_ACL], isPublished: false, cascadePendingAt: '2026-09-20T00:00:00.000Z' }),
      track('351')
    ]);
    const { cascaded } = quiet();

    const res = await push(eagleProject({ name: 'Renamed in Eagle' }));

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(cascaded.map(c => c.projectId), [TWIN]);
    const byId = Object.fromEntries(store.rows('projects').map(r => [r.id, r]));
    assert.ok(!('cascadePendingAt' in byId[TWIN]),
      `the owed marker should be gone once the cascade lands, got ${byId[TWIN].cascadePendingAt}`);
  });

  await t.test('a sealed Track row seals its public twin and the twin\'s documents', async () => {
    const store = mirrorStore(t, [
      twin({ name: 'Twin', read: [...PUBLIC_ACL], isPublished: true }),
      track('351', { read: [SEALED_TOKEN], isPublished: false }),
      { container: 'documents', id: 'doc-under-twin', projectId: TWIN, read: [...PUBLIC_ACL], isPublished: true }
    ]);
    for (const level of ['info', 'warn', 'error']) t.mock.method(logger, level, () => {});
    // The real document cascade runs against the store; only the index and periods are stubbed.
    t.mock.method(aiSearch, 'writeAcls', async (_index, rows) => rows.length);
    t.mock.method(commentPeriods, 'setAclForProject', async () => ({ succeeded: 0, failed: 0, rows: [] }));

    const res = await push(eagleProject({ name: 'Renamed in Eagle' }));

    assert.strictEqual(res.statusCode, 200);
    const byId = Object.fromEntries(store.rows('projects').map(r => [r.id, r]));
    assert.deepStrictEqual(byId[TWIN].read, [SEALED_TOKEN]);
    assert.strictEqual(byId[TWIN].isPublished, false);
    const [document] = store.rows('documents');
    assert.deepStrictEqual({ read: document.read, isPublished: document.isPublished },
      { read: [SEALED_TOKEN], isPublished: false });
  });

  await t.test('two Track rows holding one Eagle id are refused with 409 and no write', async () => {
    const store = mirrorStore(t, [track('351'), track('352')]);
    quiet();

    const res = await push(eagleProject({ name: 'Renamed in Eagle' }));

    assert.strictEqual(res.statusCode, 409);
    assert.deepStrictEqual(store.writes, []);
  });
});
