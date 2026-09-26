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
const { logger } = require('../../src/utils/logger');
const {
  admitParent, pickParent, MALFORMED_REF, CLASSIFY_TIMEOUT_MS
} = require('../../src/helpers/parent-admit');

// Track 353's epic_guid on test, 2026-09-08: a ProjectNotification _id in a project's guid field.
const SHADOWED_NOTIFICATION_ID = '5f04b1f83a147c00223ce1b3';
const PROJECT_EAGLE_ID = '588511d0aaecd9001b825604';
// Spelled out rather than built from readForLevel: an ACL derived from the helper under test would
// agree with whatever that helper returns.
const PUBLIC_ACL = ['public', 'staff', 'sysadmin'];
const TRACK_ONLY_ACL = ['staff'];
// Stamped by `POST /sealed` only; a level-0 row without it was sealed by an Eagle push.
const SEALED_AT = '2026-09-01T00:00:00.000Z';

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
    t.mock.method(notifications, 'readForWrite', async () => notificationRow());

    assert.deepStrictEqual(await admitParent(SHADOWED_NOTIFICATION_ID),
      { id: SHADOWED_NOTIFICATION_ID, read: PUBLIC_ACL, kind: 'notification' });
  });

  await t.test('the notification is looked up even when a project row answered', async () => {
    // The lookup that project-first skipped. Asserted on the call, not only on the result: a
    // short-circuit reads as correct on every ref the two containers do not both answer for.
    const notificationReads = [];
    t.mock.method(projects, 'getByEagleId', async () => shadowProject());
    t.mock.method(notifications, 'readForWrite', async (id) => {
      notificationReads.push(String(id));
      return notificationRow();
    });

    await admitParent(SHADOWED_NOTIFICATION_ID);

    assert.deepStrictEqual(notificationReads, [SHADOWED_NOTIFICATION_ID]);
  });

  await t.test('an ordinary project parent still resolves to the project', async () => {
    t.mock.method(projects, 'getByEagleId', async () =>
      ({ id: '207', eagleId: PROJECT_EAGLE_ID, read: PUBLIC_ACL }));
    t.mock.method(notifications, 'readForWrite', async () => null);

    assert.deepStrictEqual(await admitParent(PROJECT_EAGLE_ID),
      { id: '207', read: PUBLIC_ACL, kind: 'project' });
  });

  await t.test('a populated {_id} ref resolves as the bare id does', async () => {
    const asked = [];
    t.mock.method(projects, 'getByEagleId', async (_access, id) => { asked.push(id); return null; });
    t.mock.method(notifications, 'readForWrite', async () => notificationRow());

    const parent = await admitParent({ _id: SHADOWED_NOTIFICATION_ID, name: 'Sunny Ridge Quarry' });

    assert.strictEqual(parent.kind, 'notification');
    assert.deepStrictEqual(asked, [SHADOWED_NOTIFICATION_ID]);
  });

  await t.test('an empty ref is answered without reading either container', async () => {
    let reads = 0;
    t.mock.method(projects, 'getByEagleId', async () => { reads++; return null; });
    t.mock.method(notifications, 'readForWrite', async () => { reads++; return null; });
    t.mock.method(logger, 'warn', () => {});

    assert.strictEqual(await admitParent(null), null);
    assert.strictEqual(await admitParent(''), null);
    assert.strictEqual(reads, 0);
  });
});

/** Stub both admission reads and the refusal read; return what was warned and what was read. */
function stubParents(t, { project = null, notification = null, stored = null } = {}) {
  const warned = [];
  const refusalReads = [];
  t.mock.method(projects, 'getByEagleId', async () => project);
  t.mock.method(notifications, 'readForWrite', async () => notification);
  t.mock.method(projects, 'readForWriteByEagleId', async (id) => {
    refusalReads.push(id);
    return stored;
  });
  t.mock.method(logger, 'warn', (message, meta) => { warned.push({ message, meta }); });
  return { warned, refusalReads };
}

// The refused child, a document, whose id the warn carries for a targeted repush.
const CHILD_ID = '58869abba4acd4014b81f55c';
const CHILD = { childId: CHILD_ID };

const refused = (project, notification) => ({
  message: '[parent-admit] parent not admitted',
  meta: { eagleId: PROJECT_EAGLE_ID, childId: CHILD_ID, project, notification }
});

test('admitParent — a refusal logs why, an admission reads nothing extra', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a parent in neither container logs missing for both', async () => {
    const { warned } = stubParents(t);

    assert.strictEqual(await admitParent(PROJECT_EAGLE_ID, CHILD), null);
    assert.deepStrictEqual(warned, [refused('missing', 'missing')]);
  });

  await t.test('a project row with no read[] logs hidden, not missing', async () => {
    const { warned } = stubParents(t, { stored: { id: '207', eagleId: PROJECT_EAGLE_ID } });

    assert.strictEqual(await admitParent(PROJECT_EAGLE_ID, CHILD), null);
    assert.deepStrictEqual(warned, [refused('hidden', 'missing')]);
  });

  await t.test('a sealed project row logs hidden', async () => {
    const { warned } = stubParents(t, {
      stored: { id: '207', eagleId: PROJECT_EAGLE_ID, read: ['compliance', 'sysadmin'], sealedAt: SEALED_AT }
    });

    assert.strictEqual(await admitParent(PROJECT_EAGLE_ID, CHILD), null);
    assert.deepStrictEqual(warned, [refused('hidden', 'missing')]);
  });

  await t.test('a sealed notification refuses its child and logs hidden', async () => {
    const { warned } = stubParents(t, {
      notification: { id: PROJECT_EAGLE_ID, read: ['compliance', 'sysadmin'], sealedAt: SEALED_AT }
    });

    assert.strictEqual(await admitParent(PROJECT_EAGLE_ID, CHILD), null);
    assert.deepStrictEqual(warned, [refused('missing', 'hidden')]);
  });

  // Stored ['compliance'] by a push from before the strip: the next push heals it, so it is a
  // parent at its Eagle read minus compliance, not a hidden one.
  await t.test('a project an Eagle push sealed is admitted at its Eagle read', async () => {
    const { warned } = stubParents(t, {
      stored: {
        id: '207', eagleId: PROJECT_EAGLE_ID, read: ['compliance'],
        sources: { eagle: { read: ['compliance', 'public'] } }
      }
    });

    assert.deepStrictEqual(await admitParent(PROJECT_EAGLE_ID, CHILD),
      { id: '207', read: ['public'], kind: 'project' });
    assert.deepStrictEqual(warned.map(w => w.message),
      ['[parent-admit] project stored sealed by an Eagle push, admitted at its Eagle read']);
  });

  await t.test('a project an Eagle push sealed with no Eagle read left is admitted at staff', async () => {
    stubParents(t, { stored: { id: '207', eagleId: PROJECT_EAGLE_ID, read: ['compliance'] } });

    assert.deepStrictEqual(await admitParent(PROJECT_EAGLE_ID, CHILD),
      { id: '207', read: ['staff'], kind: 'project' });
  });

  await t.test('a notification an Eagle push sealed is admitted at its Eagle read', async () => {
    const { warned } = stubParents(t, {
      notification: {
        id: PROJECT_EAGLE_ID, read: ['compliance'],
        sources: { eagle: { read: ['compliance', 'public'] } }
      }
    });

    assert.deepStrictEqual(await admitParent(PROJECT_EAGLE_ID, CHILD),
      { id: PROJECT_EAGLE_ID, read: ['public'], kind: 'notification' });
    assert.deepStrictEqual(warned, []);
  });

  await t.test('a read-less notification refuses its child and logs hidden', async () => {
    const { warned } = stubParents(t, { notification: { id: PROJECT_EAGLE_ID } });

    assert.strictEqual(await admitParent(PROJECT_EAGLE_ID, CHILD), null);
    assert.deepStrictEqual(warned, [refused('missing', 'hidden')]);
  });

  await t.test('a project row that lands after the admission read logs visible', async () => {
    const { warned } = stubParents(t,
      { stored: { id: '207', eagleId: PROJECT_EAGLE_ID, read: PUBLIC_ACL } });

    assert.strictEqual(await admitParent(PROJECT_EAGLE_ID, CHILD), null);
    assert.deepStrictEqual(warned, [refused('visible', 'missing')]);
  });

  await t.test('a failed classify read still refuses, and logs unknown', async () => {
    const { warned } = stubParents(t);
    t.mock.method(projects, 'readForWriteByEagleId', async () => { throw new Error('503'); });

    assert.strictEqual(await admitParent(PROJECT_EAGLE_ID, CHILD), null);
    const [failure, refusal] = warned.map(w => w.meta);
    assert.deepStrictEqual({ ...failure, stack: undefined },
      { eagleId: PROJECT_EAGLE_ID, container: 'projects', error: '503', stack: undefined });
    assert.deepStrictEqual(refusal, refused('unknown', 'missing').meta);
  });

  await t.test('a classify read that outlasts the bound refuses and logs unknown', async (st) => {
    st.mock.timers.enable({ apis: ['setTimeout'] });
    const { warned } = stubParents(t);
    let reached;
    const readStarted = new Promise((resolve) => { reached = resolve; });
    t.mock.method(projects, 'readForWriteByEagleId', () => {
      reached();
      return new Promise(() => {});
    });

    const admitted = admitParent(PROJECT_EAGLE_ID, CHILD);
    await readStarted;
    st.mock.timers.tick(CLASSIFY_TIMEOUT_MS);

    assert.strictEqual(await admitted, null);
    assert.deepStrictEqual(warned.map(w => w.meta), [
      { eagleId: PROJECT_EAGLE_ID, container: 'projects',
        error: `timed out after ${CLASSIFY_TIMEOUT_MS} ms` },
      refused('unknown', 'missing').meta
    ]);
  });

  await t.test('an admitted project makes no refusal read and logs nothing', async () => {
    const { warned, refusalReads } = stubParents(t, {
      project: { id: '207', eagleId: PROJECT_EAGLE_ID, read: PUBLIC_ACL }
    });

    await admitParent(PROJECT_EAGLE_ID, CHILD);

    assert.deepStrictEqual({ warned, refusalReads }, { warned: [], refusalReads: [] });
  });

  await t.test('an admitted notification makes no refusal read and logs nothing', async () => {
    const { warned, refusalReads } = stubParents(t, { notification: notificationRow() });

    await admitParent(SHADOWED_NOTIFICATION_ID);

    assert.deepStrictEqual({ warned, refusalReads }, { warned: [], refusalReads: [] });
  });

  await t.test('a hidden notification that falls through to a same-id project is logged',
    async () => {
      const { warned } = stubParents(t, {
        project: shadowProject(),
        notification: { id: SHADOWED_NOTIFICATION_ID }
      });

      assert.strictEqual((await admitParent(SHADOWED_NOTIFICATION_ID, CHILD)).id, '353');
      assert.deepStrictEqual(warned, [{
        message: '[parent-admit] hidden notification passed its children to a same-id project',
        meta: { eagleId: SHADOWED_NOTIFICATION_ID, childId: CHILD_ID, projectId: '353' }
      }]);
    });

  const malformed = {
    message: '[parent-admit] parent not admitted',
    meta: { childId: CHILD_ID, project: MALFORMED_REF, notification: MALFORMED_REF }
  };

  await t.test('a ref that is not a 24-hex ObjectId reads nothing and logs malformed-ref',
    async () => {
      const { warned } = stubParents(t);
      let reads = 0;
      t.mock.method(projects, 'getByEagleId', async () => { reads++; return null; });

      assert.strictEqual(await admitParent('207\n[parent-admit] forged', CHILD), null);
      assert.deepStrictEqual({ reads, warned }, { reads: 0, warned: [malformed] });
    });

  await t.test('a populated {_id} that is not 24-hex logs malformed-ref', async () => {
    const { warned } = stubParents(t);

    assert.strictEqual(await admitParent({ _id: 'not-an-id', name: 'Quarry' }, CHILD), null);
    assert.deepStrictEqual(warned, [malformed]);
  });
});
