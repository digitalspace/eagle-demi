'use strict';

/**
 * The parent rule — `helpers/parent-admit`.
 *
 * Every mirror asks the same question: which DEMI row owns the child Eagle hangs off a `project`
 * reference. The answer decides the partition the child is written to AND the ACL it is narrowed
 * against, so getting it wrong is silent — the push still answers 200.
 *
 * The case pinned hardest is the collision: a Track project whose `epic_guid` is a
 * `ProjectNotification` id, which puts that id in the project row's `eagleId` and makes
 * `projects.getByEagleId` answer for a ref that names the notification. Project-first filed those
 * children under the Track project and its level-2 ACL.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const projects = require('../../src/repositories/projects');
const notifications = require('../../src/repositories/notifications');
const { admitParent, pickParent } = require('../../src/helpers/parent-admit');

// Track 353's epic_guid on test, 2026-09-08: a ProjectNotification _id in a project's guid field.
const SHADOWED_NOTIFICATION_ID = '5f04b1f83a147c00223ce1b3';
const PROJECT_EAGLE_ID = '588511d0aaecd9001b825604';
// Spelled out rather than built from readForLevel: an ACL derived from the helper under test would
// agree with whatever that helper returns.
const PUBLIC_ACL = ['public', 'staff', 'sysadmin'];
const TRACK_ONLY_ACL = ['staff'];

/** The Track project row the merge wrote for a guid that names a notification. */
const shadowProject = () =>
  ({ id: '353', eagleId: SHADOWED_NOTIFICATION_ID, read: TRACK_ONLY_ACL });
const notificationRow = () => ({ id: SHADOWED_NOTIFICATION_ID, read: PUBLIC_ACL });

test('pickParent — a notification outranks a project row', async (t) => {
  await t.test('both containers answer: the notification takes the child', () => {
    assert.deepStrictEqual(pickParent(shadowProject(), notificationRow()),
      { id: SHADOWED_NOTIFICATION_ID, read: PUBLIC_ACL, kind: 'notification' });
  });

  await t.test('a project claims a ref no notification answers for', () => {
    assert.deepStrictEqual(pickParent({ id: '207', read: PUBLIC_ACL }, null),
      { id: '207', read: PUBLIC_ACL, kind: 'project' });
  });

  await t.test('a ref in neither container has no parent', () => {
    assert.strictEqual(pickParent(null, null), null);
  });

  await t.test('the id is a string, whichever container answered', () => {
    assert.strictEqual(pickParent({ id: 353, read: [] }, null).id, '353');
    assert.strictEqual(pickParent(null, { id: 1, read: [] }).id, '1');
  });
});

test('admitParent — both containers are read for every ref', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a Track project holding a notification id does not claim its children', async () => {
    t.mock.method(projects, 'getByEagleId', async () => shadowProject());
    t.mock.method(notifications, 'getById', async () => notificationRow());

    assert.deepStrictEqual(await admitParent(SHADOWED_NOTIFICATION_ID),
      { id: SHADOWED_NOTIFICATION_ID, read: PUBLIC_ACL, kind: 'notification' });
  });

  await t.test('the notification is looked up even when a project row answered', async () => {
    // The lookup that project-first skipped. Asserted on the call, not only on the result: a
    // short-circuit reads as correct on every ref the two containers do not both answer for.
    const notificationReads = [];
    t.mock.method(projects, 'getByEagleId', async () => shadowProject());
    t.mock.method(notifications, 'getById', async (_access, id) => {
      notificationReads.push(String(id));
      return notificationRow();
    });

    await admitParent(SHADOWED_NOTIFICATION_ID);

    assert.deepStrictEqual(notificationReads, [SHADOWED_NOTIFICATION_ID]);
  });

  await t.test('an ordinary project parent still resolves to the project', async () => {
    t.mock.method(projects, 'getByEagleId', async () =>
      ({ id: '207', eagleId: PROJECT_EAGLE_ID, read: PUBLIC_ACL }));
    t.mock.method(notifications, 'getById', async () => null);

    assert.deepStrictEqual(await admitParent(PROJECT_EAGLE_ID),
      { id: '207', read: PUBLIC_ACL, kind: 'project' });
  });

  await t.test('a populated {_id} ref resolves as the bare id does', async () => {
    const asked = [];
    t.mock.method(projects, 'getByEagleId', async (_access, id) => { asked.push(id); return null; });
    t.mock.method(notifications, 'getById', async () => notificationRow());

    const parent = await admitParent({ _id: SHADOWED_NOTIFICATION_ID, name: 'Sunny Ridge Quarry' });

    assert.strictEqual(parent.kind, 'notification');
    assert.deepStrictEqual(asked, [SHADOWED_NOTIFICATION_ID]);
  });

  await t.test('an empty ref is answered without reading either container', async () => {
    t.mock.method(projects, 'getByEagleId', async () => { throw new Error('must not be read'); });
    t.mock.method(notifications, 'getById', async () => { throw new Error('must not be read'); });

    assert.strictEqual(await admitParent(null), null);
    assert.strictEqual(await admitParent(''), null);
  });
});
