'use strict';

/**
 * The four Eagle mirrors that feed eagle-public's remaining reads — comment periods, comments,
 * organizations and project notifications.
 *
 * What is asserted here is what is SILENT when it breaks, because the push answers 200 either way:
 * the stored ACL, which decides whether an anonymous visitor sees the row at all, and the derived
 * `isPublished` beside it. A comment may never out-rank its period and a period may never out-rank
 * its project, so both of those ceilings are driven from the real `constrainToProject`.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../../src/db/cosmos-nosql');
const commentPeriods = require('../../../src/repositories/comment-periods');
const comments = require('../../../src/repositories/comments');
const notifications = require('../../../src/repositories/notifications');
const lists = require('../../../src/repositories/lists');
const projects = require('../../../src/repositories/projects');
const { canRead } = require('../../../src/helpers/access-sql');
const { logger } = require('../../../src/utils/logger');

const commentPeriodController = require('../../../src/controllers/nosql/comment-period');
const commentController = require('../../../src/controllers/nosql/comment');
const organizationController = require('../../../src/controllers/nosql/organization');
const notificationController = require('../../../src/controllers/nosql/notification');
const { withServer } = require('../../helpers/with-server');
const { gatewayCaller, stubRegistry } = require('../../helpers/registry-callers');
const { evaluate } = require('../../helpers/updates-store');
const {
  PROJECT_EAGLE_ID, PERIOD_EAGLE_ID, COMMENT_EAGLE_ID, ORG_EAGLE_ID, NOTIFICATION_EAGLE_ID,
  PUBLIC_ACL, PRIVATE_ACL, storedProject, storedPeriod,
  eaglePeriod, eagleComment, eagleOrganization, eagleNotification,
  mockRes, STAFF, anonymous, staff, SEALED_AT
} = require('../../helpers/eagle-mirror-fixtures');

/**
 * A partition-aware Cosmos, keyed `partitionKey::id` the way the service addresses an item.
 *
 * `replace` is addressed at (id, partitionKey) and throws 404 when that key holds nothing, exactly
 * as the real container does. That is what makes a row moved to another partition observable here:
 * a write aimed at the wrong partition either throws or shows up under the wrong key. `create` over a
 * held key is a 409, and a cross-partition lookup evaluates the SQL it is sent.
 *
 * @returns {{ store: Map, replaced: Array, created: Array }} the stored rows, the etags `replace`
 *   was guarded by, and the ids `create` was asked for
 */
function partitionedCosmos(t, partitionField, seed = []) {
  const key = (pk, id) => `${pk}::${id}`;
  const store = new Map(seed.map(row => [key(row[partitionField], row.id), row]));
  const replaced = [];
  const created = [];

  const put = async (_container, item) => {
    store.set(key(item[partitionField], item.id), item);
    return item;
  };
  t.mock.method(cosmos, 'create', async (container, item) => {
    created.push(item.id);
    if (store.has(key(item[partitionField], item.id))) {
      throw Object.assign(new Error('Entity with the specified id already exists.'), { code: 409 });
    }
    return put(container, item);
  });
  t.mock.method(cosmos, 'upsert', put);
  t.mock.method(cosmos, 'readItem', async (_container, id, partitionKey) => {
    const row = store.get(key(String(partitionKey), String(id)));
    return row ? { ...row } : null;
  });
  // Whole-row lookups only; any other query (a cascade's projection) goes to whatever answered it
  // before, so call this AFTER `stubCommentCascade`.
  const priorQuery = cosmos.query;
  t.mock.method(cosmos, 'query', async (container, spec, options) => {
    const where = /^SELECT \* FROM c WHERE (.+)$/s.exec(spec.query);
    if (!where) return priorQuery(container, spec, options);
    const params = Object.fromEntries(spec.parameters.map(p => [p.name, p.value]));
    const items = [...store.values()].filter(r => evaluate(where[1], r, params)).map(r => ({ ...r }));
    return { items, continuationToken: undefined, requestCharge: 0 };
  });
  t.mock.method(cosmos, 'replace', async (_container, id, partitionKey, item, etag) => {
    if (!store.has(key(partitionKey, id))) {
      const err = new Error('Entity with the specified id does not exist in the system.');
      err.code = 404;
      throw err;
    }
    replaced.push(etag);
    store.set(key(partitionKey, id), item);
    return item;
  });
  t.mock.method(cosmos, 'remove', async (_container, id, partitionKey) =>
    store.delete(key(String(partitionKey), String(id))));

  return { store, replaced, created };
}

/** Drive one controller the way the dispatcher does, and hand back what it wrote. */
function pushTo(controller, repo, eagleId, doc, t, { existing = null } = {}) {
  let written;
  t.mock.method(repo, 'readForWrite', async () => existing);
  t.mock.method(repo, 'upsert', async (item) => { written = item; return item; });
  const res = mockRes();
  return controller.upsertFromEagle(
    { params: { eagleId }, query: {}, body: { doc }, user: STAFF }, res
  ).then(() => ({ res, written: () => written }));
}



/** Serve the comment ACL rows of one period, and capture the patch the cascade plans. */
function stubCommentCascade(t, commentRows, { failed = 0 } = {}) {
  const writes = [];
  t.mock.method(cosmos, 'query', async (container) =>
    ({ items: container === 'comments' ? commentRows : [] }));
  t.mock.method(cosmos, 'bulkVerified', async (container, operations) => {
    writes.push({ container, operations });
    return { succeeded: operations.length - failed, failed, statusCounts: {}, requestCharge: 1 };
  });
  return writes;
}

/** The value one planned patch would write to one path. */
const opValue = (operation, path) =>
  operation.resourceBody.operations.find(o => o.path === path).value;

test('PUT /eagle/commentperiods/:eagleId', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('the Eagle record is stored as a period row under its project', async () => {
    t.mock.method(projects, 'getByEagleId', async () => storedProject());

    const { res, written } = await pushTo(
      commentPeriodController, commentPeriods, PERIOD_EAGLE_ID, eaglePeriod(), t);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { id: PERIOD_EAGLE_ID, action: 'upsert' });
    assert.deepStrictEqual(written(), {
      id: PERIOD_EAGLE_ID,
      eagleId: PERIOD_EAGLE_ID,
      // The DEMI project id, as the documents container stores it — not the Eagle one.
      projectId: '207',
      sourceSystem: 'eagle',
      dateStarted: '2026-08-01T00:00:00.000Z',
      dateCompleted: '2026-08-30T00:00:00.000Z',
      dateAdded: '2026-07-20T00:00:00.000Z',
      isMet: false,
      metURL: '',
      metBannerImageUrl: 'https://engage.gov.bc.ca/banner.jpg',
      informationLabel: 'Read the application',
      instructions: 'Tell us what you think.',
      additionalText: 'Comment on the amendment application.',
      openHouses: [{ eventDate: '2026-08-10T00:00:00.000Z', description: 'Community hall' }],
      relatedDocuments: ['5cf00c03a266b7e187750002'],
      commentTip: 'Comments are public.',
      isDeleted: false,
      isPublished: true,
      read: ['staff', 'idir', 'public'],
      sources: { eagle: eaglePeriod() }
    });
  });

  await t.test('a period under an unpublished project is stored private', async () => {
    // Eagle publishes periods and projects independently, so this is the case that decides whether
    // an unpublished project's engagement tab is readable through this container.
    t.mock.method(projects, 'getByEagleId', async () => storedProject(PRIVATE_ACL));

    const { written } = await pushTo(
      commentPeriodController, commentPeriods, PERIOD_EAGLE_ID, eaglePeriod(), t);

    assert.ok(!written().read.includes('public'), 'the project ceiling is what removes it');
    assert.strictEqual(written().isPublished, false);
  });

  await t.test('a period Eagle marks compliance-only lands privileged-only, not sealed', async () => {
    // Eagle has no sealed compartment; keeping the token would hide the row from every staff reader.
    t.mock.method(projects, 'getByEagleId', async () => storedProject());

    const { written } = await pushTo(commentPeriodController, commentPeriods, PERIOD_EAGLE_ID,
      eaglePeriod({ read: ['compliance'] }), t);

    assert.deepStrictEqual(written().read, ['sysadmin']);
  });

  const NO_PARENT_BODY = '{"error":"Parent project or notification not found"}';

  /** Push a period whose parent admission refuses, with `stored` as the unfiltered project row. */
  async function refusedPeriod(t, stored) {
    t.mock.method(projects, 'getByEagleId', async () => null);
    t.mock.method(notifications, 'readForWrite', async () => null);
    t.mock.method(projects, 'readForWriteByEagleId', async () => stored);
    const warned = [];
    t.mock.method(logger, 'warn', (message, meta) => { warned.push({ message, meta }); });
    let upserts = 0;
    t.mock.method(commentPeriods, 'upsert', async () => { upserts++; });

    const res = mockRes();
    await commentPeriodController.upsertFromEagle({
      params: { eagleId: PERIOD_EAGLE_ID }, query: {}, body: { doc: eaglePeriod() }, user: STAFF
    }, res);
    return { res, warned, upserts };
  }

  await t.test('a period whose parent is in neither container is a 404, no write, logged',
    async () => {
      const { res, warned, upserts } = await refusedPeriod(t, null);

      assert.strictEqual(res.statusCode, 404);
      assert.strictEqual(upserts, 0);
      // The body names both containers, as swagger's 404 does: a notification is a parent too.
      assert.strictEqual(JSON.stringify(res.body), NO_PARENT_BODY);
      assert.deepStrictEqual(warned, [{
        message: '[parent-admit] parent not admitted',
        meta: {
          eagleId: PROJECT_EAGLE_ID, childId: PERIOD_EAGLE_ID,
          project: 'missing', notification: 'missing'
        }
      }]);
    });

  await t.test('a period under a hidden project gets the same 404, logged hidden', async () => {
    const { res, warned } = await refusedPeriod(t,
      { id: '207', eagleId: PROJECT_EAGLE_ID, read: ['compliance', 'sysadmin'], sealedAt: SEALED_AT });

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(JSON.stringify(res.body), NO_PARENT_BODY);
    assert.strictEqual(warned[0].meta.project, 'hidden');
  });

  // Eagle's `project` reference holds either id. Resolving it through `projects` alone dropped 10
  // periods and the 232 comments under them on test, measured 2026-09-07.
  await t.test('a period under a ProjectNotification is stored under it, ACL verbatim', async () => {
    t.mock.method(projects, 'getByEagleId', async () => null);
    t.mock.method(notifications, 'readForWrite', async () => ({
      id: NOTIFICATION_EAGLE_ID, read: PRIVATE_ACL
    }));

    const { res, written } = await pushTo(
      commentPeriodController, commentPeriods, PERIOD_EAGLE_ID,
      eaglePeriod({ project: NOTIFICATION_EAGLE_ID }), t);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(written().projectId, NOTIFICATION_EAGLE_ID,
      'partitioned under the notification, which is what eagle-public filters on');
    // The notification's own ACL is not a ceiling — it is not the period's parent project, and it
    // says nothing about who may read the period. So the Eagle list is stored as it arrived, which
    // is what `seed/transform.js` already does for a notification-parented document.
    assert.deepStrictEqual(written().read, PUBLIC_ACL);
    assert.strictEqual(written().isPublished, true);
  });

  // Track 351 and 353 carry a ProjectNotification _id in `epic_guid`, which the merge copies onto
  // the project row's `eagleId`, so `getByEagleId` answers with the Track project for a ref that
  // names the notification. Measured on test 2026-09-08: the periods under those two were stored
  // in partition '353' at read ['staff'], and 88 comments cascaded to staff behind them.
  await t.test('a project row carrying the notification id does not claim the period', async () => {
    t.mock.method(projects, 'getByEagleId', async () =>
      ({ id: '353', eagleId: NOTIFICATION_EAGLE_ID, read: ['staff'] }));
    t.mock.method(notifications, 'readForWrite', async () =>
      ({ id: NOTIFICATION_EAGLE_ID, read: PUBLIC_ACL }));

    const { res, written } = await pushTo(
      commentPeriodController, commentPeriods, PERIOD_EAGLE_ID,
      eaglePeriod({ project: NOTIFICATION_EAGLE_ID }), t);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(written().projectId, NOTIFICATION_EAGLE_ID,
      'the notification owns the partition, not the Track project holding its id');
    // Verbatim: the Track project's ACL is not a ceiling for a child that never named it.
    assert.deepStrictEqual(written().read, PUBLIC_ACL);
    assert.strictEqual(written().isPublished, true);
  });

  await t.test('a period misfiled under the Track project moves out and leaves nothing behind',
    async () => {
      t.mock.method(projects, 'getByEagleId', async () =>
        ({ id: '353', eagleId: NOTIFICATION_EAGLE_ID, read: ['staff'] }));
      t.mock.method(notifications, 'readForWrite', async () =>
        ({ id: NOTIFICATION_EAGLE_ID, read: PUBLIC_ACL }));
      // What the project-first rule wrote: the period in the Track project's partition, narrowed
      // to its level-2 ACL. Re-mirroring is the repair, so it has to clear that row.
      const misfiled = {
        id: PERIOD_EAGLE_ID, projectId: '353', read: ['staff'], _etag: '"misfiled"'
      };
      // The level moves staff -> public, so the comment cascade runs; it is asserted in its own
      // subtests, and here it only has to not reach Cosmos for real.
      stubCommentCascade(t, []);
      const { store } = partitionedCosmos(t, 'projectId', [misfiled]);

      const res = mockRes();
      await commentPeriodController.upsertFromEagle({
        params: { eagleId: PERIOD_EAGLE_ID }, query: {},
        body: { doc: eaglePeriod({ project: NOTIFICATION_EAGLE_ID }) }, user: STAFF
      }, res);

      assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
      assert.deepStrictEqual([...store.keys()], [`${NOTIFICATION_EAGLE_ID}::${PERIOD_EAGLE_ID}`],
        'only the notification partition holds the period');
      assert.deepStrictEqual(store.get(`${NOTIFICATION_EAGLE_ID}::${PERIOD_EAGLE_ID}`).read,
        PUBLIC_ACL);
    });

  // The repository and its Cosmos calls are REAL below: mocking `repo.upsert` proves the controller
  // asked for a write, never that the write could land. Reparenting is precisely where it could not.
  await t.test('a period that changed project moves to the new partition and leaves nothing behind',
    async () => {
      t.mock.method(projects, 'getByEagleId', async () => storedProject());
      const stale = { id: PERIOD_EAGLE_ID, projectId: '208', read: PUBLIC_ACL, _etag: '"stale"' };
      const { store } = partitionedCosmos(t, 'projectId', [stale]);

      const res = mockRes();
      await commentPeriodController.upsertFromEagle({
        params: { eagleId: PERIOD_EAGLE_ID }, query: {}, body: { doc: eaglePeriod() }, user: STAFF
      }, res);

      assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
      assert.deepStrictEqual([...store.keys()], [`207::${PERIOD_EAGLE_ID}`],
        'the row lives under the new project and the old-partition row is gone');
      assert.strictEqual(store.get(`207::${PERIOD_EAGLE_ID}`).projectId, '207');
    });

  await t.test('a period that stayed put is written under the etag it was read at', async () => {
    // The reparent path drops the etag guard because there is no item to match; it must not drop
    // it for the ordinary update, or a concurrent push stops racing and starts winning silently.
    t.mock.method(projects, 'getByEagleId', async () => storedProject());
    const current = { id: PERIOD_EAGLE_ID, projectId: '207', read: PUBLIC_ACL, _etag: '"v1"' };
    const { store, replaced } = partitionedCosmos(t, 'projectId', [current]);

    const res = mockRes();
    await commentPeriodController.upsertFromEagle({
      params: { eagleId: PERIOD_EAGLE_ID }, query: {}, body: { doc: eaglePeriod() }, user: STAFF
    }, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(replaced, ['"v1"']);
    assert.deepStrictEqual([...store.keys()], [`207::${PERIOD_EAGLE_ID}`]);
  });
});

/**
 * eagle-api hard-deletes a comment period and pushes the record it just removed with
 * `isDeleted: true` — the one push that carries a fact the stored document cannot say. What is
 * asserted is what an anonymous visitor would then be answered, on the period AND on the comments
 * under it: the period row alone is not what hides a comment, because a comment is gated by its
 * own ACL.
 *
 * `comments.setAclForPeriod`, `deriveAcls` and the SQL are all real here; only Cosmos is doubled,
 * so the assertions are about the patch the container would receive.
 */
test('PUT /eagle/commentperiods/:eagleId — a deleted period', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('the row is kept, flagged, and narrowed out of the public\'s reach', async () => {
    t.mock.method(projects, 'getByEagleId', async () => storedProject());
    stubCommentCascade(t, []);

    const { res, written } = await pushTo(commentPeriodController, commentPeriods,
      PERIOD_EAGLE_ID, eaglePeriod({ isDeleted: true }), t);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body, { id: PERIOD_EAGLE_ID, action: 'delete' });
    const row = written();
    assert.strictEqual(row.isDeleted, true);
    assert.strictEqual(row.isPublished, false);
    assert.deepStrictEqual(row.read, ['staff'], 'narrowed to the takedown level, not deleted');
    // The predicate a point read runs, on the row the controller actually wrote.
    assert.strictEqual(canRead(row, anonymous()), false, 'an anonymous visitor may not see it');
    assert.strictEqual(canRead(row, staff()), true, 'staff still see what Eagle no longer holds');
    // The raw Eagle record is kept whole — that is what a reconcile reads it back from.
    assert.deepStrictEqual(row.sources.eagle.read, PUBLIC_ACL);
  });

  await t.test('its comments are narrowed with it, each capped by its own Eagle ACL', async () => {
    t.mock.method(projects, 'getByEagleId', async () => storedProject());
    const writes = stubCommentCascade(t, [
      { id: 'c1', read: ['staff', 'idir', 'public'], eagleRead: PUBLIC_ACL },
      // Eagle never published this one; the cascade must not widen it on the way down either.
      { id: 'c2', read: ['staff'], eagleRead: PRIVATE_ACL }
    ]);

    const { res } = await pushTo(commentPeriodController, commentPeriods,
      PERIOD_EAGLE_ID, eaglePeriod({ isDeleted: true }), t);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(writes.map(w => w.container), ['comments']);
    const [patch] = writes;
    assert.deepStrictEqual(patch.operations.map(o => o.partitionKey), [PERIOD_EAGLE_ID, PERIOD_EAGLE_ID]);
    for (const operation of patch.operations) {
      assert.deepStrictEqual(opValue(operation, '/read'), ['staff'], operation.id);
      assert.strictEqual(opValue(operation, '/isPublished'), false, operation.id);
      assert.strictEqual(
        canRead({ read: opValue(operation, '/read'), projectId: '207' }, anonymous()), false);
    }
  });

  await t.test('a period whose comments did not all land answers 500, and stays narrowed',
    async () => {
      // The period's own write has already happened. A 200 here would tell the log nothing, and
      // the comments that failed are still public.
      t.mock.method(projects, 'getByEagleId', async () => storedProject());
      stubCommentCascade(t, [{ id: 'c1', read: PUBLIC_ACL, eagleRead: PUBLIC_ACL }], { failed: 1 });

      const { res, written } = await pushTo(commentPeriodController, commentPeriods,
        PERIOD_EAGLE_ID, eaglePeriod({ isDeleted: true }), t);

      assert.strictEqual(res.statusCode, 500);
      assert.match(res.body.error, /comments were not fully updated/);
      assert.deepStrictEqual(written().read, ['staff']);
    });

  await t.test('only eagle-api sending the record again brings it back', async () => {
    // The rule the controller header states. Nothing inside DEMI clears the flag — see
    // acl-cascade.test.js for the cascade that used to — but a push carrying the record means
    // Eagle holds one again, and Mongo does not reuse an ObjectId.
    t.mock.method(projects, 'getByEagleId', async () => storedProject());
    stubCommentCascade(t, []);
    const deleted = { id: PERIOD_EAGLE_ID, projectId: '207', read: ['staff'], isDeleted: true };

    const { res, written } = await pushTo(commentPeriodController, commentPeriods,
      PERIOD_EAGLE_ID, eaglePeriod(), t, { existing: deleted });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(written().isDeleted, false);
    assert.deepStrictEqual(written().read, ['staff', 'idir', 'public']);
  });
});

/**
 * A period Eagle published or unpublished, and the comments under it.
 *
 * The comment's OWN stored `read[]` is the only gate on `/search?dataset=Comment` — that branch
 * never re-reads the period, unlike the chunk branch, which reads its parent document. So a period
 * that moves level and leaves its comments where they were is a period whose comments are still
 * readable by anyone who knows the period id.
 */
test('PUT /eagle/commentperiods/:eagleId — a period that changed level', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const PUBLIC_READ = ['staff', 'idir', 'public'];
  const storedAt = (read) => ({ id: PERIOD_EAGLE_ID, projectId: '207', read });

  await t.test('an unpublish narrows the comments under it', async () => {
    t.mock.method(projects, 'getByEagleId', async () => storedProject());
    const writes = stubCommentCascade(t, [
      { id: 'c1', read: PUBLIC_READ, eagleRead: PUBLIC_ACL }
    ]);

    // Eagle unpublished the period: the push carries the narrowed record, under a project that is
    // still public, so the project ceiling is not what moves it.
    const { res, written } = await pushTo(commentPeriodController, commentPeriods,
      PERIOD_EAGLE_ID, eaglePeriod({ read: PRIVATE_ACL }), t, { existing: storedAt(PUBLIC_READ) });

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(written().read, ['staff']);
    const [patch] = writes;
    assert.strictEqual(patch.container, 'comments');
    assert.deepStrictEqual(opValue(patch.operations[0], '/read'), ['staff']);
    assert.strictEqual(opValue(patch.operations[0], '/isPublished'), false);
    assert.strictEqual(canRead({ read: opValue(patch.operations[0], '/read'), projectId: '207' },
      anonymous()), false, 'the comment is what an anonymous reader is refused');
  });

  await t.test('a re-publish restores exactly the comments Eagle published', async () => {
    t.mock.method(projects, 'getByEagleId', async () => storedProject());
    const writes = stubCommentCascade(t, [
      { id: 'c1', read: ['staff'], eagleRead: PUBLIC_ACL },
      // Eagle never published this one. A cascade that assigned rather than narrowed would.
      { id: 'c2', read: ['staff'], eagleRead: PRIVATE_ACL }
    ]);

    const { res, written } = await pushTo(commentPeriodController, commentPeriods,
      PERIOD_EAGLE_ID, eaglePeriod(), t, { existing: storedAt(['staff']) });

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(written().read, PUBLIC_READ);
    const [patch] = writes;
    assert.deepStrictEqual(opValue(patch.operations[0], '/read'), PUBLIC_READ);
    assert.strictEqual(opValue(patch.operations[0], '/isPublished'), true);
    assert.deepStrictEqual(opValue(patch.operations[1], '/read'), ['staff'],
      'a comment Eagle kept private is not published by its period');
    assert.strictEqual(canRead({ read: opValue(patch.operations[1], '/read'), projectId: '207' },
      anonymous()), false);
  });

  await t.test('a push that did not move the level costs no cascade', async () => {
    // Most pushes are an edit to the text. Re-deriving every comment on each of them is a bulk
    // patch per push for no change.
    t.mock.method(projects, 'getByEagleId', async () => storedProject());
    const writes = stubCommentCascade(t, [{ id: 'c1', read: PUBLIC_READ, eagleRead: PUBLIC_ACL }]);

    const { res } = await pushTo(commentPeriodController, commentPeriods, PERIOD_EAGLE_ID,
      eaglePeriod({ instructions: 'Tell us more.' }), t, { existing: storedAt(PUBLIC_READ) });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(writes, []);
  });

  await t.test('a legacy ACL that means the same level is not a change', async () => {
    // The seed wrote `['public','sysadmin','staff']`; the mirror writes ladder tokens. Both are
    // level 4, and comparing the arrays instead of the levels would cascade on every push.
    t.mock.method(projects, 'getByEagleId', async () => storedProject());
    const writes = stubCommentCascade(t, [{ id: 'c1', read: PUBLIC_READ, eagleRead: PUBLIC_ACL }]);

    const { res } = await pushTo(commentPeriodController, commentPeriods, PERIOD_EAGLE_ID,
      eaglePeriod(), t, { existing: storedAt(PUBLIC_ACL) });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(writes, []);
  });
});

test('PUT /eagle/comments/:eagleId', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('the Eagle record is stored as a comment row under its period', async () => {
    t.mock.method(commentPeriods, 'getById', async () => storedPeriod());

    const { res, written } = await pushTo(
      commentController, comments, COMMENT_EAGLE_ID, eagleComment(), t);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(written(), {
      id: COMMENT_EAGLE_ID,
      eagleId: COMMENT_EAGLE_ID,
      periodId: PERIOD_EAGLE_ID,
      // Carried from the period: an Eagle comment holds no project.
      projectId: '207',
      sourceSystem: 'eagle',
      author: 'Jane Public',
      comment: 'The turbine setback is too small.',
      dateAdded: '2026-08-05T00:00:00.000Z',
      dateUpdated: '2026-08-06T00:00:00.000Z',
      location: 'Nicomen Island',
      submittedCAC: true,
      isAnonymous: false,
      documents: ['5cf00c03a266b7e187750003'],
      commentId: 12,
      eaoStatus: 'Published',
      isPublished: true,
      read: ['staff', 'idir', 'public'],
      sources: { eagle: eagleComment() }
    });
  });

  await t.test('a comment under an unpublished period is stored private', async () => {
    t.mock.method(commentPeriods, 'getById', async () => storedPeriod(['staff']));

    const { written } = await pushTo(
      commentController, comments, COMMENT_EAGLE_ID, eagleComment(), t);

    assert.ok(!written().read.includes('public'), 'the period ceiling is what removes it');
    assert.strictEqual(written().isPublished, false);
  });

  await t.test('a comment Eagle marks compliance-only lands privileged-only, not sealed', async () => {
    t.mock.method(commentPeriods, 'getById', async () => storedPeriod());

    const { written } = await pushTo(
      commentController, comments, COMMENT_EAGLE_ID, eagleComment({ read: ['compliance'] }), t);

    assert.deepStrictEqual(written().read, ['sysadmin']);
  });

  await t.test('an absent isAnonymous is stored as anonymous, matching the Eagle default', async () => {
    t.mock.method(commentPeriods, 'getById', async () => storedPeriod());
    const doc = eagleComment();
    delete doc.isAnonymous;

    const { written } = await pushTo(commentController, comments, COMMENT_EAGLE_ID, doc, t);

    assert.strictEqual(written().isAnonymous, true);
  });

  await t.test('no email is mirrored, whatever the push sends', async () => {
    // The Eagle Comment model has no email field. If one ever appears upstream it must not ride
    // into a container whose rows are served to anonymous callers.
    t.mock.method(commentPeriods, 'getById', async () => storedPeriod());

    const { written } = await pushTo(commentController, comments, COMMENT_EAGLE_ID,
      eagleComment({ email: 'jane@example.invalid' }), t);

    assert.ok(!('email' in written()), 'no top-level email');
    assert.ok(!Object.keys(written()).some(k => /mail/i.test(k)));
  });

  await t.test('a comment moved to another period moves partition and leaves nothing behind',
    async () => {
      t.mock.method(commentPeriods, 'getById', async () => storedPeriod());
      const stale = {
        id: COMMENT_EAGLE_ID, periodId: 'oldperiod', projectId: '207',
        read: PUBLIC_ACL, _etag: '"stale"'
      };
      const { store } = partitionedCosmos(t, 'periodId', [stale]);

      const res = mockRes();
      await commentController.upsertFromEagle({
        params: { eagleId: COMMENT_EAGLE_ID }, query: {}, body: { doc: eagleComment() }, user: STAFF
      }, res);

      assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
      assert.deepStrictEqual([...store.keys()], [`${PERIOD_EAGLE_ID}::${COMMENT_EAGLE_ID}`]);
    });

  const NO_PERIOD_BODY = '{"error":"Parent comment period not found"}';

  /** Push a comment whose period lookup refuses, with `stored` as the unfiltered period row. */
  async function refusedComment(t, stored, doc = eagleComment()) {
    let periodReads = 0;
    t.mock.method(commentPeriods, 'getById', async () => { periodReads++; return null; });
    t.mock.method(commentPeriods, 'readForWrite', async () => stored);
    const warned = [];
    t.mock.method(logger, 'warn', (message, meta) => { warned.push({ message, meta }); });
    let upserts = 0;
    t.mock.method(comments, 'upsert', async () => { upserts++; });

    const res = mockRes();
    await commentController.upsertFromEagle({
      params: { eagleId: COMMENT_EAGLE_ID }, query: {}, body: { doc }, user: STAFF
    }, res);
    return { res, warned, upserts, periodReads };
  }

  await t.test('a comment whose period is not mirrored is a 404, no write, logged missing',
    async () => {
      const { res, warned, upserts } = await refusedComment(t, null);

      assert.strictEqual(res.statusCode, 404);
      assert.strictEqual(upserts, 0);
      assert.strictEqual(JSON.stringify(res.body), NO_PERIOD_BODY);
      assert.deepStrictEqual(warned, [{
        message: '[parent-admit] parent not admitted',
        meta: { eagleId: PERIOD_EAGLE_ID, childId: COMMENT_EAGLE_ID, period: 'missing' }
      }]);
    });

  await t.test('a comment with a malformed period ref reads nothing and is logged', async () => {
    const { res, warned, periodReads } = await refusedComment(t, null,
      eagleComment({ period: 'not-an-object-id' }));

    assert.strictEqual(JSON.stringify(res.body), NO_PERIOD_BODY);
    assert.deepStrictEqual({ periodReads, warned }, {
      periodReads: 0,
      warned: [{
        message: '[parent-admit] parent not admitted',
        meta: { childId: COMMENT_EAGLE_ID, period: 'malformed-ref' }
      }]
    });
  });

  await t.test('a comment under a read-less period gets the same 404, logged hidden', async () => {
    const { res, warned } = await refusedComment(t, { id: PERIOD_EAGLE_ID, projectId: '207' });

    assert.strictEqual(JSON.stringify(res.body), NO_PERIOD_BODY);
    assert.strictEqual(warned[0].meta.period, 'hidden');
  });

  await t.test('a comment under a sealed period gets the same 404, logged hidden', async () => {
    const { res, warned } = await refusedComment(t,
      { id: PERIOD_EAGLE_ID, projectId: '207', read: ['compliance', 'sysadmin'], sealedAt: SEALED_AT });

    assert.strictEqual(JSON.stringify(res.body), NO_PERIOD_BODY);
    assert.strictEqual(warned[0].meta.period, 'hidden');
  });

  await t.test('a comment under a period an Eagle push sealed is logged eagle-sealed, not hidden',
    async () => {
      // A re-push of the period heals it; the log says so rather than calling it a seal.
      const { res, warned } = await refusedComment(t,
        { id: PERIOD_EAGLE_ID, projectId: '207', read: ['compliance'] });

      assert.strictEqual(JSON.stringify(res.body), NO_PERIOD_BODY);
      assert.strictEqual(warned[0].meta.period, 'eagle-sealed');
    });

  await t.test('a comment under a visible period reads nothing extra and logs nothing',
    async () => {
      t.mock.method(commentPeriods, 'getById', async () => storedPeriod());
      let classifyReads = 0;
      t.mock.method(commentPeriods, 'readForWrite', async () => { classifyReads++; return null; });
      const warned = [];
      t.mock.method(logger, 'warn', (message, meta) => { warned.push(meta); });
      partitionedCosmos(t, 'periodId', []);

      const res = mockRes();
      await commentController.upsertFromEagle({
        params: { eagleId: COMMENT_EAGLE_ID }, query: {}, body: { doc: eagleComment() }, user: STAFF
      }, res);

      assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
      assert.deepStrictEqual({ classifyReads, warned }, { classifyReads: 0, warned: [] });
    });
});

test('PUT /eagle/organizations/:eagleId', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('the Eagle record is stored in lists as kind Organization', async () => {
    const { res, written } = await pushTo(
      organizationController, lists, ORG_EAGLE_ID, eagleOrganization(), t);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(written(), {
      id: ORG_EAGLE_ID,
      eagleId: ORG_EAGLE_ID,
      kind: 'Organization',
      sourceSystem: 'eagle',
      name: 'Nicomen Energy Ltd',
      companyType: 'Proponent',
      province: 'BC',
      country: 'Canada',
      address1: '100 Wind Way',
      city: 'Merritt',
      postal: 'V1K 1B8',
      website: 'https://example.invalid',
      isPublished: true,
      read: PUBLIC_ACL,
      sources: { eagle: eagleOrganization() }
    });
  });

  await t.test('read[] decides publication, and there is no parent to constrain against', async () => {
    const { written } = await pushTo(
      organizationController, lists, ORG_EAGLE_ID, eagleOrganization({ read: PRIVATE_ACL }), t);

    assert.strictEqual(written().isPublished, false);
    assert.deepStrictEqual(written().read, PRIVATE_ACL, 'kept verbatim, like every seeded ACL');
  });

  await t.test('the compliance token is dropped from an organization read', async () => {
    const { written } = await pushTo(organizationController, lists, ORG_EAGLE_ID,
      eagleOrganization({ read: ['compliance', 'public'] }), t);

    assert.deepStrictEqual(written().read, ['public']);
  });

  await t.test('a compliance-only organization lands privileged-only, not sealed', async () => {
    const { written } = await pushTo(organizationController, lists, ORG_EAGLE_ID,
      eagleOrganization({ read: ['compliance'] }), t);

    assert.deepStrictEqual(written().read, ['sysadmin']);
  });
});

test('PUT /eagle/notifications/:eagleId', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('the Eagle record is stored as a notification row', async () => {
    const { res, written } = await pushTo(
      notificationController, notifications, NOTIFICATION_EAGLE_ID, eagleNotification(), t);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(written().id, NOTIFICATION_EAGLE_ID);
    assert.strictEqual(written().name, 'Sunny Ridge Quarry');
    assert.deepStrictEqual(written().centroid, [-120.8, 50.1]);
    assert.strictEqual(written().notificationThresholdValue, 250000);
    assert.strictEqual(written().isPublished, true);
  });

  await t.test('read[] decides publication, not the presence of a decision', async () => {
    const { written } = await pushTo(notificationController, notifications, NOTIFICATION_EAGLE_ID,
      eagleNotification({ read: PRIVATE_ACL, decision: 'Certificate Issued' }), t);

    assert.strictEqual(written().isPublished, false);
  });

  await t.test('a zero threshold survives the mirror', async () => {
    // `|| null` on a Number would store 0 as null, and 0 is a real threshold.
    const { written } = await pushTo(notificationController, notifications, NOTIFICATION_EAGLE_ID,
      eagleNotification({ notificationThresholdValue: 0 }), t);

    assert.strictEqual(written().notificationThresholdValue, 0);
  });

  await t.test('the compliance token is dropped from a notification read', async () => {
    const { written } = await pushTo(notificationController, notifications, NOTIFICATION_EAGLE_ID,
      eagleNotification({ read: ['compliance', 'public'] }), t);

    assert.deepStrictEqual(written().read, ['public']);
  });

  await t.test('a compliance-only notification lands privileged-only, not sealed', async () => {
    const { written } = await pushTo(notificationController, notifications, NOTIFICATION_EAGLE_ID,
      eagleNotification({ read: ['compliance'] }), t);

    assert.deepStrictEqual(written().read, ['sysadmin']);
  });
});

// The existence check is "is there a row", not "may this caller see it": a row the ACL hides from
// systemAccess read as absent, the create 409'd on every try, and the push answered 503 forever.
test('a push over a row the ACL hides replaces it under its etag', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const push = async (controller, eagleId, doc) => {
    const res = mockRes();
    await controller.upsertFromEagle({ params: { eagleId }, query: {}, body: { doc }, user: STAFF }, res);
    return res;
  };

  await t.test('a comment period sealed to compliance takes the push and stays sealed', async () => {
    t.mock.method(projects, 'getByEagleId', async () => storedProject());
    stubCommentCascade(t, []);
    const { store, replaced, created } = partitionedCosmos(t, 'projectId', [
      {
        id: PERIOD_EAGLE_ID, projectId: '207', read: ['compliance'], isPublished: false,
        sealedAt: SEALED_AT, instructions: '', _etag: '"v1"'
      }
    ]);

    const res = await push(commentPeriodController, PERIOD_EAGLE_ID, eaglePeriod());

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual({ created, replaced }, { created: [], replaced: ['"v1"'] });
    const row = store.get(`207::${PERIOD_EAGLE_ID}`);
    assert.strictEqual(row.instructions, 'Tell us what you think.');
    assert.deepStrictEqual({ read: row.read, isPublished: row.isPublished },
      { read: ['compliance'], isPublished: false });

    // The first push must carry the stamp, or the second reads an Eagle seal and reopens it.
    const again = await push(commentPeriodController, PERIOD_EAGLE_ID, eaglePeriod());
    assert.strictEqual(again.statusCode, 200, JSON.stringify(again.body));
    const twice = store.get(`207::${PERIOD_EAGLE_ID}`);
    assert.deepStrictEqual({ read: twice.read, isPublished: twice.isPublished, sealedAt: twice.sealedAt },
      { read: ['compliance'], isPublished: false, sealedAt: SEALED_AT });
  });

  await t.test('a comment sealed to compliance takes the push and stays sealed', async () => {
    t.mock.method(commentPeriods, 'getById', async () => storedPeriod());
    const { store, replaced, created } = partitionedCosmos(t, 'periodId', [{
      id: COMMENT_EAGLE_ID, periodId: PERIOD_EAGLE_ID, projectId: '207', read: ['compliance'],
      isPublished: false, sealedAt: SEALED_AT, comment: null, _etag: '"v1"'
    }]);

    const res = await push(commentController, COMMENT_EAGLE_ID, eagleComment());

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual({ created, replaced }, { created: [], replaced: ['"v1"'] });
    const row = store.get(`${PERIOD_EAGLE_ID}::${COMMENT_EAGLE_ID}`);
    assert.strictEqual(row.comment, 'The turbine setback is too small.');
    assert.deepStrictEqual({ read: row.read, isPublished: row.isPublished },
      { read: ['compliance'], isPublished: false });
  });

  // Stored ['compliance'] by a push from before the strip, no `sealedAt`: not a DEMI seal.
  await t.test('a comment period an Eagle push sealed takes the pushed read', async () => {
    t.mock.method(projects, 'getByEagleId', async () => storedProject());
    stubCommentCascade(t, []);
    const { store } = partitionedCosmos(t, 'projectId', [{
      id: PERIOD_EAGLE_ID, projectId: '207', read: ['compliance'], isPublished: false, _etag: '"v1"'
    }]);

    const res = await push(commentPeriodController, PERIOD_EAGLE_ID,
      eaglePeriod({ read: ['compliance', ...PUBLIC_ACL] }));

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const row = store.get(`207::${PERIOD_EAGLE_ID}`);
    assert.deepStrictEqual({ read: row.read, isPublished: row.isPublished },
      { read: ['staff', 'idir', 'public'], isPublished: true });
  });

  await t.test('a comment an Eagle push sealed takes the pushed read', async () => {
    t.mock.method(commentPeriods, 'getById', async () => storedPeriod());
    const { store } = partitionedCosmos(t, 'periodId', [{
      id: COMMENT_EAGLE_ID, periodId: PERIOD_EAGLE_ID, projectId: '207', read: ['compliance'],
      isPublished: false, _etag: '"v1"'
    }]);

    const res = await push(commentController, COMMENT_EAGLE_ID,
      eagleComment({ read: ['compliance', ...PUBLIC_ACL] }));

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const row = store.get(`${PERIOD_EAGLE_ID}::${COMMENT_EAGLE_ID}`);
    assert.deepStrictEqual({ read: row.read, isPublished: row.isPublished },
      { read: ['staff', 'idir', 'public'], isPublished: true });
  });

  await t.test('an organization with no read[] at all', async () => {
    const { store, replaced, created } = partitionedCosmos(t, 'kind', [
      { id: ORG_EAGLE_ID, kind: lists.KINDS.ORGANIZATION, name: 'Old name', _etag: '"v1"' }
    ]);

    const res = await push(organizationController, ORG_EAGLE_ID, eagleOrganization());

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual({ created, replaced }, { created: [], replaced: ['"v1"'] });
    assert.strictEqual(store.get(`${lists.KINDS.ORGANIZATION}::${ORG_EAGLE_ID}`).name,
      'Nicomen Energy Ltd');
  });

  await t.test('a project notification with no read[] at all', async () => {
    const { store, replaced, created } = partitionedCosmos(t, 'id', [
      { id: NOTIFICATION_EAGLE_ID, name: 'Old name', _etag: '"v1"' }
    ]);

    const res = await push(notificationController, NOTIFICATION_EAGLE_ID, eagleNotification());

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual({ created, replaced }, { created: [], replaced: ['"v1"'] });
    assert.strictEqual(store.get(`${NOTIFICATION_EAGLE_ID}::${NOTIFICATION_EAGLE_ID}`).name,
      'Sunny Ridge Quarry');
  });
});

test('every mirror refuses a body whose doc._id disagrees with the path', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const cases = [
    [commentPeriodController, commentPeriods, PERIOD_EAGLE_ID, eaglePeriod],
    [commentController, comments, COMMENT_EAGLE_ID, eagleComment],
    [organizationController, lists, ORG_EAGLE_ID, eagleOrganization],
    [notificationController, notifications, NOTIFICATION_EAGLE_ID, eagleNotification]
  ];

  for (const [controller, repo, eagleId, make] of cases) {
    let upserts = 0;
    t.mock.method(repo, 'upsert', async () => { upserts++; });
    t.mock.method(projects, 'getByEagleId', async () => { throw new Error('must not be read'); });
    t.mock.method(commentPeriods, 'getById', async () => { throw new Error('must not be read'); });

    for (const body of [{ doc: make({ _id: 'somethingelse' }) }, {}, { doc: null }]) {
      const res = mockRes();
      await controller.upsertFromEagle({ params: { eagleId }, query: {}, body, user: STAFF }, res);
      assert.strictEqual(res.statusCode, 400, `${eagleId}: ${JSON.stringify(body)}`);
    }
    assert.strictEqual(upserts, 0);
    t.mock.restoreAll();
  }
});

/**
 * The route chain, run end to end through the dispatcher. The handlers read and write through
 * systemAccess(), so nothing inside them refuses an anonymous caller — only the chain does.
 */
test('the four mirror routes reject anonymous and admit eagle-api', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const paths = [
    ['/api/eagle/commentperiods', PERIOD_EAGLE_ID],
    ['/api/eagle/comments', COMMENT_EAGLE_ID],
    ['/api/eagle/organizations', ORG_EAGLE_ID],
    ['/api/eagle/notifications', NOTIFICATION_EAGLE_ID]
  ];

  await t.test('no credential is 401, and nothing is written', async () => {
    let upserts = 0;
    for (const repo of [commentPeriods, comments, lists, notifications]) {
      t.mock.method(repo, 'upsert', async () => { upserts++; });
    }

    await withServer(async (call) => {
      for (const [path, id] of paths) {
        const res = await call(`${path}/${id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ doc: { _id: id } })
        });
        assert.strictEqual(res.status, 401, path);
      }
    });

    assert.strictEqual(upserts, 0);
  });

  await t.test('eagle-api through APIM reaches the handler', async (t) => {
    const eagleApi = gatewayCaller(t, 'eagle-api', ['demi-service-write']);
    stubRegistry(t, [eagleApi.row]);

    t.mock.method(projects, 'getByEagleId', async () => storedProject());
    const written = [];
    for (const repo of [commentPeriods, comments, lists, notifications]) {
      t.mock.method(repo, 'readForWrite', async () => null);
      t.mock.method(repo, 'upsert', async (item) => { written.push(item.id); return item; });
    }
    // The comment mirror's parent period.
    t.mock.method(commentPeriods, 'getById', async (access, id) =>
      (id === PERIOD_EAGLE_ID ? storedPeriod() : null));

    const bodies = [eaglePeriod(), eagleComment(), eagleOrganization(), eagleNotification()];

    await withServer(async (call) => {
      for (const [i, [path, id]] of paths.entries()) {
        const res = await call(`${path}/${id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', ...eagleApi.headers },
          body: JSON.stringify({ doc: bodies[i] })
        });
        assert.strictEqual(res.status, 200, `${path}: ${await res.text()}`);
      }
    });

    assert.deepStrictEqual(written,
      [PERIOD_EAGLE_ID, COMMENT_EAGLE_ID, ORG_EAGLE_ID, NOTIFICATION_EAGLE_ID]);
  });
});
