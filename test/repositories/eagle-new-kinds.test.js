'use strict';

/**
 * The users, groups and inspections repositories. What is asserted is the SQL and the partition
 * each read sends, and the ACL a cascade writes: a dropped predicate or a wrong partition answers
 * 200 with rows the caller may not see.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const users = require('../../src/repositories/users');
const groups = require('../../src/repositories/groups');
const inspections = require('../../src/repositories/inspections');
const { TIER } = require('../../src/helpers/access-sql');

const ANON = { tier: TIER.PUBLIC, roles: ['public'], projectScope: null, teams: [], level: 4 };
const STAFF = { tier: TIER.PRIVILEGED, roles: ['public', 'staff'], projectScope: null, teams: [], level: 2 };
const SCOPED = { tier: TIER.SCOPED, roles: ['staff'], projectScope: ['207'], teams: [], level: 1 };

function capture(t, items = []) {
  const seen = [];
  t.mock.method(cosmos, 'query', async (container, spec, options) => {
    seen.push({ container, spec, options });
    return { items };
  });
  return seen;
}

test('users repository', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('list: ACL-filtered, paged, and an anonymous projection never fetches an email', async () => {
    const seen = capture(t);
    await users.listVisible(ANON, { pageSize: 10 });
    const [{ container, spec, options }] = seen;
    assert.strictEqual(container, 'users');
    assert.match(spec.query, /ARRAY_CONTAINS/);
    assert.match(spec.query, /ORDER BY c\.id ASC$/);
    assert.ok(!/c\.email\b/.test(spec.query.split(' FROM ')[0]), spec.query);
    assert.strictEqual(options.maxItemCount, 10);
  });

  await t.test('by id: a level-2 user is not returned to a visitor, is to staff', async () => {
    const row = { id: 'u1', read: ['sysadmin', 'staff'] };
    t.mock.method(cosmos, 'readItem', async (_c, id, pk) => (id === 'u1' && pk === 'u1' ? row : null));
    assert.strictEqual(await users.getById(ANON, 'u1'), null);
    assert.strictEqual(await users.getById(STAFF, 'u1'), row);
  });

  await t.test('a project-scoped caller reads no user: users have no project axis', async () => {
    t.mock.method(cosmos, 'readItem', async () => ({ id: 'u1', read: ['sysadmin', 'staff'] }));
    assert.strictEqual(await users.getById(SCOPED, 'u1'), null);
  });
});

test('groups repository', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('list by project: single-partition, ACL-filtered', async () => {
    const seen = capture(t);
    await groups.listVisible(ANON, { projectId: '207', pageSize: 5 });
    const [{ container, spec, options }] = seen;
    assert.strictEqual(container, 'groups');
    assert.strictEqual(options.partitionKey, '207');
    assert.match(spec.query, /ARRAY_CONTAINS/);
    assert.ok(spec.parameters.some(p => p.name === '@projectId' && p.value === '207'));
  });

  await t.test('by id with the project: point read gated on the row ACL', async () => {
    t.mock.method(cosmos, 'readItem', async () => ({ id: 'g1', projectId: '207', read: ['staff'] }));
    assert.strictEqual(await groups.getById(ANON, 'g1', '207'), null);
    assert.ok(await groups.getById(STAFF, 'g1', '207'));
  });
});

test('inspections repository', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('list: one kind only, single-partition when the inspection is named', async () => {
    const seen = capture(t);
    await inspections.listVisible(ANON, inspections.KINDS.ITEM, { inspectionId: 'i1', elementId: 'e1', pageSize: 5 });
    const [{ container, spec, options }] = seen;
    assert.strictEqual(container, 'inspections');
    assert.strictEqual(options.partitionKey, 'i1');
    assert.match(spec.query, /ARRAY_CONTAINS/);
    const values = Object.fromEntries(spec.parameters.map(p => [p.name, p.value]));
    assert.strictEqual(values['@kind'], 'InspectionItem');
    assert.strictEqual(values['@element'], 'e1');
  });

  await t.test('by id: a row of another kind is not this kind', async () => {
    t.mock.method(cosmos, 'readItem', async () => ({ id: 'e1', kind: 'InspectionElement', inspection: 'i1', read: ['staff'] }));
    assert.strictEqual(await inspections.getById(STAFF, inspections.KINDS.INSPECTION, 'e1', 'i1'), null);
    assert.ok(await inspections.getById(STAFF, inspections.KINDS.ELEMENT, 'e1', 'i1'));
  });

  await t.test('findParent: looks in the parent kind\'s child list, takes the narrower of two', async () => {
    const seen = capture(t, [
      { id: 'i1', read: ['staff', 'idir', 'public'] },
      { id: 'i2', read: ['staff'] }
    ]);
    const parent = await inspections.findParent(inspections.KINDS.ELEMENT, 'e1');
    assert.strictEqual(parent.id, 'i2');
    assert.match(seen[0].spec.query, /ARRAY_CONTAINS\(c\.elements, @child\)/);
    assert.ok(seen[0].spec.parameters.some(p => p.value === 'Inspection'));
  });

  await t.test('findParent: no claimant is null', async () => {
    capture(t, []);
    assert.strictEqual(await inspections.findParent(inspections.KINDS.ITEM, 'x'), null);
  });

  await t.test('cascade: elements capped by the inspection, items by their element\'s new read', async () => {
    t.mock.method(cosmos, 'query', async (_c, spec) => {
      const kind = spec.parameters.find(p => p.name === '@kind').value;
      // A level-2 element under a level-3 inspection: its item must land at 2, not at the inspection's 3.
      if (kind === 'InspectionElement') return { items: [{ id: 'e1', read: ['staff', 'idir', 'public'], eagleRead: ['sysadmin'] }] };
      return { items: [{ id: 'it1', read: ['staff', 'idir', 'public'], eagleRead: ['public', 'sysadmin'] }] };
    });
    const patched = [];
    t.mock.method(cosmos, 'bulkVerified', async (_c, ops) => {
      for (const op of ops) patched.push({ id: op.id, pk: op.partitionKey, read: op.resourceBody.operations[0].value });
      return { succeeded: ops.length, failed: 0 };
    });

    const result = await inspections.setAclForInspection('i1', ['staff', 'idir']);
    assert.deepStrictEqual(result, { succeeded: 2, failed: 0 });
    assert.deepStrictEqual(patched, [
      { id: 'e1', pk: 'i1', read: ['staff'] },
      { id: 'it1', pk: 'i1', read: ['staff'] }
    ]);
  });
});
