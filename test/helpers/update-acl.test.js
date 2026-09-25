'use strict';

/**
 * The Update half of the project visibility cascade — `helpers/update-acl.setAclForProject`.
 * The rule itself (`deriveAcls`) is pinned in acl-cascade.test.js; this pins the query and patches.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const notifications = require('../../src/repositories/notifications');
const { setAclForProject } = require('../../src/helpers/update-acl');
const { PROJECT_EAGLE_ID, PUBLIC_ACL, PRIVATE_ACL } = require('./eagle-mirror-fixtures');

// Spelled out, not built from readForLevel, so the assertion cannot agree with any helper output.
const PUBLIC_PARENT = ['staff', 'idir', 'public'];
const STAFF_PARENT = ['staff'];

/** Serve `rows` to the updates query and record every patch the bulk would send. */
function stub(t, rows, { notification = null } = {}) {
  const seen = { queries: [], ops: [] };
  t.mock.method(notifications, 'readForWrite', async () => notification);
  t.mock.method(cosmos, 'query', async (container, spec) => {
    seen.queries.push({ container, spec });
    return { items: rows };
  });
  t.mock.method(cosmos, 'bulkVerified', async (container, ops) => {
    seen.ops.push(...ops.map(op => ({ container, ...op })));
    return { succeeded: ops.length, failed: 0, statusCounts: {}, requestCharge: 0 };
  });
  return seen;
}

// Every patch also clears an announce the parent gate skipped: the parent moved, so it is due again.
const CLEARED = { '/notifySkippedAt': null, '/notifySkipReason': null };
const patched = (op) => Object.fromEntries(op.resourceBody.operations.map(o => [o.path, o.value]));

test('setAclForProject — updates follow their project', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('publishing the project publishes an update the push had capped', async () => {
    const seen = stub(t, [{ id: 'u1', read: STAFF_PARENT, eagleRead: PUBLIC_ACL }]);

    await setAclForProject(PROJECT_EAGLE_ID, PUBLIC_PARENT);

    const [{ spec }] = seen.queries;
    assert.match(spec.query, /WHERE c\.projectId = @projectId/);
    assert.deepStrictEqual(spec.parameters, [{ name: '@projectId', value: PROJECT_EAGLE_ID }]);
    assert.strictEqual(seen.ops.length, 1);
    assert.strictEqual(seen.ops[0].container, 'updates');
    // `updates` partitions on /id, so each patch names its own row as the partition.
    assert.strictEqual(seen.ops[0].partitionKey, 'u1');
    assert.deepStrictEqual(patched(seen.ops[0]), { '/read': PUBLIC_ACL, '/isPublished': true, ...CLEARED },
      'Eagle\'s own read, verbatim: the project no longer caps it');
  });

  await t.test('unpublishing the project takes a public update down with it', async () => {
    const seen = stub(t, [{ id: 'u1', read: PUBLIC_ACL, eagleRead: PUBLIC_ACL }]);

    await setAclForProject(PROJECT_EAGLE_ID, PRIVATE_ACL);

    assert.deepStrictEqual(patched(seen.ops[0]), { '/read': STAFF_PARENT, '/isPublished': false, ...CLEARED });
  });

  await t.test('an update Eagle keeps private stays private under a public project', async () => {
    const seen = stub(t, [{ id: 'u1', read: STAFF_PARENT, eagleRead: PRIVATE_ACL }]);

    await setAclForProject(PROJECT_EAGLE_ID, PUBLIC_PARENT);

    assert.strictEqual(patched(seen.ops[0])['/isPublished'], false);
  });

  await t.test('a sealed notification holding the id still cascades nothing', async () => {
    const seen = stub(t, [{ id: 'u1', read: PUBLIC_ACL, eagleRead: PUBLIC_ACL }],
      { notification: { id: PROJECT_EAGLE_ID, read: ['compliance'] } });

    await setAclForProject(PROJECT_EAGLE_ID, PUBLIC_PARENT);

    assert.strictEqual(seen.ops.length, 0);
  });

  await t.test('an id a notification holds cascades nothing: its updates were never capped', async () => {
    const seen = stub(t, [{ id: 'u1', read: PUBLIC_ACL, eagleRead: PUBLIC_ACL }],
      { notification: { id: PROJECT_EAGLE_ID } });

    await setAclForProject(PROJECT_EAGLE_ID, PRIVATE_ACL);

    assert.strictEqual(seen.queries.length, 0);
    assert.strictEqual(seen.ops.length, 0);
  });

  await t.test('an Eagle read that is not a list derives [], never a level', async () => {
    const seen = stub(t, [{ id: 'u1', read: ['sysadmin'] }]);

    await setAclForProject(PROJECT_EAGLE_ID, PUBLIC_PARENT);

    assert.deepStrictEqual(patched(seen.ops[0]), { '/read': [], '/isPublished': false, ...CLEARED });
  });

  await t.test('[\'sysadmin\'] under a public project stays [\'sysadmin\']', async () => {
    const seen = stub(t, [{ id: 'u1', read: ['sysadmin'], eagleRead: ['sysadmin'] }]);

    await setAclForProject(PROJECT_EAGLE_ID, PUBLIC_PARENT);

    assert.deepStrictEqual(patched(seen.ops[0])['/read'], ['sysadmin']);
  });

  await t.test('a sealed Update keeps its seal', async () => {
    const seen = stub(t, [{ id: 'u1', read: ['compliance'], eagleRead: PUBLIC_ACL }]);

    await setAclForProject(PROJECT_EAGLE_ID, PUBLIC_PARENT);

    assert.strictEqual(seen.ops.length, 0);
  });

  await t.test('an empty project ACL is refused rather than read as level 1', async () => {
    stub(t, []);
    await assert.rejects(setAclForProject(PROJECT_EAGLE_ID, []), TypeError);
  });
});
