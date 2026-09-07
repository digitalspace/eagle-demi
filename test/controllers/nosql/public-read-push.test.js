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
const apiKeys = require('../../../src/repositories/api-keys');
const { generateKey } = require('../../../src/helpers/api-key');
const { forgetCachedKey } = require('../../../src/helpers/auth');

const commentPeriodController = require('../../../src/controllers/nosql/comment-period');
const commentController = require('../../../src/controllers/nosql/comment');
const organizationController = require('../../../src/controllers/nosql/organization');
const notificationController = require('../../../src/controllers/nosql/notification');
const { withServer } = require('../../helpers/with-server');
const {
  PERIOD_EAGLE_ID, COMMENT_EAGLE_ID, ORG_EAGLE_ID, NOTIFICATION_EAGLE_ID,
  PUBLIC_ACL, PRIVATE_ACL, storedProject, storedPeriod,
  eaglePeriod, eagleComment, eagleOrganization, eagleNotification,
  mockRes, STAFF
} = require('../../helpers/eagle-mirror-fixtures');

/**
 * A partition-aware Cosmos, keyed `partitionKey::id` the way the service addresses an item.
 *
 * `replace` is addressed at (id, partitionKey) and throws 404 when that key holds nothing, exactly
 * as the real container does. That is what makes a row moved to another partition observable here:
 * a write aimed at the wrong partition either throws or shows up under the wrong key.
 *
 * @returns {{ store: Map, replaced: Array }} the stored rows, and the etags `replace` was guarded by
 */
function partitionedCosmos(t, partitionField, seed = []) {
  const key = (pk, id) => `${pk}::${id}`;
  const store = new Map(seed.map(row => [key(row[partitionField], row.id), row]));
  const replaced = [];

  const put = async (_container, item) => {
    store.set(key(item[partitionField], item.id), item);
    return item;
  };
  t.mock.method(cosmos, 'create', put);
  t.mock.method(cosmos, 'upsert', put);
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

  return { store, replaced };
}

/** Drive one controller the way the dispatcher does, and hand back what it wrote. */
function pushTo(controller, repo, eagleId, doc, t, { existing = null } = {}) {
  let written;
  t.mock.method(repo, 'getById', async () => existing);
  t.mock.method(repo, 'upsert', async (item) => { written = item; return item; });
  const res = mockRes();
  return controller.upsertFromEagle(
    { params: { eagleId }, query: {}, body: { doc }, user: STAFF }, res
  ).then(() => ({ res, written: () => written }));
}

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
      informationLabel: 'Read the application',
      instructions: 'Tell us what you think.',
      openHouses: [{ eventDate: '2026-08-10T00:00:00.000Z', description: 'Community hall' }],
      relatedDocuments: ['5cf00c03a266b7e187750002'],
      commentTip: 'Comments are public.',
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

  await t.test('a period whose project is not mirrored is a 404 and no write', async () => {
    t.mock.method(projects, 'getByEagleId', async () => null);
    let upserts = 0;
    t.mock.method(commentPeriods, 'upsert', async () => { upserts++; });

    const res = mockRes();
    await commentPeriodController.upsertFromEagle({
      params: { eagleId: PERIOD_EAGLE_ID }, query: {}, body: { doc: eaglePeriod() }, user: STAFF
    }, res);

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(upserts, 0);
  });

  // The repository and its Cosmos calls are REAL below: mocking `repo.upsert` proves the controller
  // asked for a write, never that the write could land. Reparenting is precisely where it could not.
  await t.test('a period that changed project moves to the new partition and leaves nothing behind',
    async () => {
      t.mock.method(projects, 'getByEagleId', async () => storedProject());
      const stale = { id: PERIOD_EAGLE_ID, projectId: '208', read: PUBLIC_ACL, _etag: '"stale"' };
      const { store } = partitionedCosmos(t, 'projectId', [stale]);
      t.mock.method(commentPeriods, 'getById', async () => stale);

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
    t.mock.method(commentPeriods, 'getById', async () => current);

    const res = mockRes();
    await commentPeriodController.upsertFromEagle({
      params: { eagleId: PERIOD_EAGLE_ID }, query: {}, body: { doc: eaglePeriod() }, user: STAFF
    }, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(replaced, ['"v1"']);
    assert.deepStrictEqual([...store.keys()], [`207::${PERIOD_EAGLE_ID}`]);
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
      t.mock.method(comments, 'getById', async () => stale);

      const res = mockRes();
      await commentController.upsertFromEagle({
        params: { eagleId: COMMENT_EAGLE_ID }, query: {}, body: { doc: eagleComment() }, user: STAFF
      }, res);

      assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
      assert.deepStrictEqual([...store.keys()], [`${PERIOD_EAGLE_ID}::${COMMENT_EAGLE_ID}`]);
    });

  await t.test('a comment whose period is not mirrored is a 404 and no write', async () => {
    t.mock.method(commentPeriods, 'getById', async () => null);
    let upserts = 0;
    t.mock.method(comments, 'upsert', async () => { upserts++; });

    const res = mockRes();
    await commentController.upsertFromEagle({
      params: { eagleId: COMMENT_EAGLE_ID }, query: {}, body: { doc: eagleComment() }, user: STAFF
    }, res);

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(upserts, 0);
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
test('the four mirror routes reject anonymous and admit a write key', async (t) => {
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

  await t.test('a demi-service-write key reaches the handler', async () => {
    const { keyId, plaintext, hash } = generateKey('test');
    forgetCachedKey(keyId);
    t.mock.method(apiKeys, 'getById', async () => ({
      id: keyId, name: 'eagle-push', hash, roles: ['demi-service-write'],
      projectScope: null, expiresAt: null, revokedAt: null
    }));
    t.mock.method(apiKeys, 'touchLastUsed', async () => {});

    t.mock.method(projects, 'getByEagleId', async () => storedProject());
    t.mock.method(commentPeriods, 'getById', async () => null);
    t.mock.method(comments, 'getById', async () => null);
    t.mock.method(lists, 'getById', async () => null);
    t.mock.method(notifications, 'getById', async () => null);

    const written = [];
    for (const repo of [commentPeriods, comments, lists, notifications]) {
      t.mock.method(repo, 'upsert', async (item) => { written.push(item.id); return item; });
    }
    // The comment mirror looks its period up through the repository the line above already stubbed
    // to null, so it needs its own answer.
    t.mock.method(commentPeriods, 'getById', async (access, id) =>
      (id === PERIOD_EAGLE_ID ? storedPeriod() : null));

    const bodies = [eaglePeriod(), eagleComment(), eagleOrganization(), eagleNotification()];

    await withServer(async (call) => {
      for (const [i, [path, id]] of paths.entries()) {
        const res = await call(`${path}/${id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'x-api-key': plaintext },
          body: JSON.stringify({ doc: bodies[i] })
        });
        assert.strictEqual(res.status, 200, `${path}: ${await res.text()}`);
      }
    });

    assert.deepStrictEqual(written,
      [PERIOD_EAGLE_ID, COMMENT_EAGLE_ID, ORG_EAGLE_ID, NOTIFICATION_EAGLE_ID]);
    forgetCachedKey(keyId);
  });
});
