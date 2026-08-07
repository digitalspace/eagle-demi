'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const boundaries = require('../../src/repositories/boundaries');
const { TIER, systemAccess } = require('../../src/helpers/access-sql');

// The frontend calls /boundaries/<name> with NO type. Requiring the partition key turned `type`
// into the string "undefined", which matches nothing and 404s every lookup.

const ANON = { tier: TIER.PUBLIC, roles: ['public'], projectScope: null };

test('getByName works with and without a type', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('no type -> cross-partition query on name only', async () => {
    let spec, options;
    t.mock.method(cosmos, 'query', async (c, s, o) => {
      spec = s; options = o;
      return { items: [{ id: 'b1', name: 'Bulkley-Nechako' }] };
    });

    const r = await boundaries.getByName(ANON, 'Bulkley-Nechako');
    assert.strictEqual(r.id, 'b1');
    assert.match(spec.query, /c\.name = @name/);
    assert.ok(!/c\.type/.test(spec.query), 'must not filter on an absent type');
    assert.ok(!('partitionKey' in options), 'must not scope to partition "undefined"');
    assert.ok(spec.parameters.some(p => p.name === '@name'));
  });

  await t.test('with a type -> single-partition query', async () => {
    let spec, options;
    t.mock.method(cosmos, 'query', async (c, s, o) => {
      spec = s; options = o;
      return { items: [{ id: 'b1' }] };
    });

    await boundaries.getByName(ANON, 'Bulkley-Nechako', 'Regional District');
    assert.match(spec.query, /c\.type = @type/);
    assert.match(spec.query, /c\.name = @name/);
    assert.strictEqual(options.partitionKey, 'Regional District');
  });

  await t.test('an empty-string type is treated as absent', async () => {
    let options;
    t.mock.method(cosmos, 'query', async (c, s, o) => { options = o; return { items: [] }; });
    await boundaries.getByName(ANON, 'X', '');
    assert.ok(!('partitionKey' in options));
  });

  await t.test('no match returns null rather than undefined', async () => {
    t.mock.method(cosmos, 'query', async () => ({ items: [] }));
    assert.strictEqual(await boundaries.getByName(ANON, 'nope'), null);
  });
});

// Boundaries were the one container that could not express a restriction at all. These assert the
// gate is real in BOTH directions — a probe that only shows the public case cannot fail.
test('boundaries are ACL-gated', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('an anonymous read carries the role predicate', async () => {
    let spec;
    t.mock.method(cosmos, 'query', async (c, s) => { spec = s; return { items: [] }; });

    await boundaries.listByType(ANON, { type: 'Regional District' });
    assert.match(spec.query, /c\.read/, 'the ACL predicate must be in the emitted SQL');
    assert.ok(spec.parameters.some(p => p.value === 'public'));
  });

  await t.test('a privileged read is unrestricted', async () => {
    let spec;
    t.mock.method(cosmos, 'query', async (c, s) => { spec = s; return { items: [] }; });

    await boundaries.listByType(systemAccess(), {});
    assert.ok(!/c\.read/.test(spec.query), 'privileged collapses the ACL clause, as elsewhere');
  });

  await t.test('project scope does NOT apply — boundaries have no project axis', async () => {
    // A project-scoped caller must still see public geography. Scoping on a field the items do
    // not carry would match nothing and blank the map.
    let spec;
    t.mock.method(cosmos, 'query', async (c, s) => { spec = s; return { items: [] }; });

    const scoped = { tier: TIER.SCOPED, roles: ['public'], projectScope: ['207'] };
    await boundaries.listByType(scoped, {});
    assert.ok(!/@scope0/.test(spec.query), 'no project narrowing on this container');
    assert.match(spec.query, /c\.read/, 'but the role ACL still applies');
  });

  await t.test('a staff-only boundary is withheld from a point read', async () => {
    // The case that motivated the change: a shapefile that must not be public.
    const staffOnly = { id: 'b9', type: 'Regional District', read: ['sysadmin', 'staff'], isPublished: false };
    t.mock.method(cosmos, 'readItem', async () => staffOnly);

    assert.strictEqual(
      await boundaries.getById(ANON, 'b9', 'Regional District'), null,
      'canRead must withhold it — readItem bypasses the query predicate'
    );

    const staff = { tier: TIER.PUBLIC, roles: ['public', 'staff'], projectScope: null };
    assert.strictEqual((await boundaries.getById(staff, 'b9', 'Regional District')).id, 'b9');
  });

  await t.test('counts share the read predicate', async () => {
    let spec;
    t.mock.method(cosmos, 'queryValue', async (c, s) => { spec = s; return 0; });

    await boundaries.countVisible(ANON, {});
    assert.match(spec.query, /SELECT VALUE COUNT\(1\)/);
    assert.match(spec.query, /c\.read/, 'a count that ignores the ACL leaks the hidden total');
  });
});
