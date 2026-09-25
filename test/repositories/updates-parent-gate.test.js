'use strict';

/**
 * The Update parent gate's own costs: the list gate's parent rows are cached per process and
 * dropped when a parent's read moves here, and a point read checks its one parent, not the scan.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const updates = require('../../src/repositories/updates');
const notifications = require('../../src/repositories/notifications');
const { resolveAccess } = require('../../src/helpers/access-sql');
const { setAclForProject } = require('../../src/helpers/update-acl');
const notificationController = require('../../src/controllers/nosql/notification');
const { parentProject, parentNotification } = require('../helpers/update-parents');

const PUBLIC = ['staff', 'idir', 'public'];
const PRIVATE = ['staff'];
const anonymous = () => resolveAccess({});

/** Serve the parent scans from `store` and count them by container. */
function scans(t, store) {
  const seen = { projects: 0, notifications: 0 };
  t.mock.method(cosmos, 'query', async (container) => {
    if (container in seen) seen[container]++;
    return { items: (store[container] || []).slice(), requestCharge: 3 };
  });
  return seen;
}

test('the list gate caches parent rows per process', async (t) => {
  t.beforeEach(() => updates.forgetParents());
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a second request, from another caller, reads no parent again', async () => {
    const seen = scans(t, { projects: [{ id: '208', eagleId: 'e-private', read: PRIVATE }] });

    assert.deepStrictEqual(await updates.hiddenParentIds(anonymous()), ['e-private']);
    assert.deepStrictEqual(await updates.hiddenParentIds(resolveAccess({})), ['e-private']);

    assert.deepStrictEqual(seen, { projects: 1, notifications: 1 });
  });

  await t.test('and reads them again once the TTL has passed', async () => {
    const seen = scans(t, {});
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);

    await updates.hiddenParentIds(anonymous());
    now += 59_000;
    await updates.hiddenParentIds(anonymous());
    assert.strictEqual(seen.projects, 1, 'still fresh at 59 s');
    now += 2_000;
    await updates.hiddenParentIds(anonymous());
    assert.strictEqual(seen.projects, 2);
  });

  await t.test('a project cascade drops the cache, so a publish shows at once', async () => {
    const store = { projects: [{ id: '208', eagleId: 'e-proj', read: PRIVATE }] };
    scans(t, store);
    assert.deepStrictEqual(await updates.hiddenParentIds(anonymous()), ['e-proj']);

    store.projects = [{ id: '208', eagleId: 'e-proj', read: PUBLIC }];
    parentNotification(t, null);
    t.mock.method(cosmos, 'bulkVerified', async () => ({ succeeded: 0, failed: 0, statusCounts: {}, requestCharge: 0 }));
    await setAclForProject('e-proj', PUBLIC);

    assert.deepStrictEqual(await updates.hiddenParentIds(anonymous()), []);
  });

  await t.test('a notification push drops the cache, so an unpublish hides at once', async () => {
    const store = { notifications: [{ id: 'e-note', read: PUBLIC }] };
    scans(t, store);
    assert.deepStrictEqual(await updates.hiddenParentIds(anonymous()), []);

    store.notifications = [{ id: 'e-note', read: PRIVATE }];
    t.mock.method(notifications, 'readForWrite', async () => null);
    t.mock.method(notifications, 'upsert', async (item) => item);
    await notificationController.mirrorFromEagle('e-note', { _id: 'e-note', name: 'Quarry', read: ['staff'] });

    assert.deepStrictEqual(await updates.hiddenParentIds(anonymous()), ['e-note']);
  });

  await t.test('a failed read is not cached', async () => {
    let calls = 0;
    t.mock.method(cosmos, 'query', async () => {
      calls++;
      if (calls <= 2) throw new Error('cosmos down');
      return { items: [], requestCharge: 0 };
    });

    await assert.rejects(updates.hiddenParentIds(anonymous()), /cosmos down/);
    assert.deepStrictEqual(await updates.hiddenParentIds(anonymous()), []);
  });
});

test('a point read checks its own parent, not the scan', async (t) => {
  t.beforeEach(() => updates.forgetParents());
  t.afterEach(() => t.mock.restoreAll());

  const row = { id: 'u1', projectId: 'e-parent', read: PUBLIC, isPublished: true };

  /** One stored Update; any whole-container parent scan fails the case. */
  function stored(t) {
    t.mock.method(cosmos, 'readItem', async (container, id) => (container === updates.CONTAINER && id === 'u1' ? { ...row } : null));
    t.mock.method(cosmos, 'query', async (container) => { throw new Error(`scanned ${container}`); });
  }

  await t.test('under a public project, the row', async () => {
    stored(t);
    parentProject(t, { id: '207', eagleId: 'e-parent', read: PUBLIC });
    parentNotification(t, null);

    assert.strictEqual((await updates.getById(anonymous(), 'u1')).id, 'u1');
  });

  await t.test('under an unpublished project, nothing', async () => {
    stored(t);
    parentProject(t, { id: '207', eagleId: 'e-parent', read: PRIVATE });
    parentNotification(t, null);

    assert.strictEqual(await updates.getById(anonymous(), 'u1'), null);
  });

  await t.test('under a sealed notification sharing its id with a public project, nothing', async () => {
    stored(t);
    parentProject(t, { id: '353', eagleId: 'e-parent', read: PUBLIC });
    parentNotification(t, { id: 'e-parent', read: ['compliance'] });

    assert.strictEqual(await updates.getById(anonymous(), 'u1'), null);
  });

  await t.test('under a parent DEMI does not hold, the row, as the list gate answers', async () => {
    stored(t);
    parentProject(t, null);
    parentNotification(t, null);

    assert.strictEqual((await updates.getById(anonymous(), 'u1')).id, 'u1');
  });
});
