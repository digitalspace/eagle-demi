'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  TIER,
  rolesFor,
  isPrivileged,
  resolveAccess,
  readClause,
  scopeClause,
  andClauses,
  visibilityFor,
  canRead
} = require('../../src/helpers/access-sql');

// These tests assert the EMITTED SQL and parameters, not just behaviour. Authorization is the
// highest-consequence surface here and this repo has already shipped a filter that failed
// open once, so an edit that widens the predicate must fail a test rather than a review.

test('readClause — role ACL predicate', async (t) => {
  await t.test('privileged roles short-circuit to true with no params', () => {
    for (const role of ['sysadmin', 'staff', 'demi-admin']) {
      const { clause, params } = readClause(['public', role]);
      assert.strictEqual(clause, 'true', `${role} should be unrestricted`);
      assert.deepStrictEqual(params, []);
    }
  });

  await t.test('anonymous emits an indexed EXISTS subquery, never a bare true', () => {
    const { clause, params } = readClause(['public']);
    assert.notStrictEqual(clause, 'true');
    assert.match(clause, /EXISTS\(SELECT VALUE r FROM r IN c\.read WHERE r IN \(@role0\)\)/);
    assert.deepStrictEqual(params, [{ name: '@role0', value: 'public' }]);
  });

  await t.test('never uses ARRAY_CONTAINS_ANY — it does not use the index', () => {
    const { clause } = readClause(['public', 'project-team']);
    assert.ok(!clause.includes('ARRAY_CONTAINS_ANY'),
      'ARRAY_CONTAINS_ANY would make every gated read a full scan');
  });

  await t.test('an unprivileged extra role does not unlock everything', () => {
    const { clause, params } = readClause(['public', 'some-unrelated-role']);
    assert.notStrictEqual(clause, 'true');
    assert.strictEqual(params.length, 2);
  });

  await t.test('binds every role as a parameter — no interpolation', () => {
    const { clause, params } = readClause(['public', "'; DROP--"]);
    assert.ok(!clause.includes('DROP'), 'role values must never reach the SQL text');
    assert.ok(params.some(p => p.value === "'; DROP--"));
  });

  await t.test('the isPublished mirror requires an explicit true', () => {
    const { clause } = readClause(['public']);
    assert.match(clause, /AND c\.isPublished = true/);
    // The old Mongo filter had a third tier matching rows with NO isPublished field at all.
    // It is deleted, not translated — every seeder writes read[] explicitly.
    assert.ok(!clause.includes('NOT IS_DEFINED(c.isPublished)'),
      'legacy no-isPublished tier must not be carried into SQL');
  });

  await t.test('honours alias and prefix so clauses cannot collide', () => {
    const { clause, params } = readClause(['public'], { alias: 'd', prefix: '@docRole' });
    assert.match(clause, /d\.read/);
    assert.strictEqual(params[0].name, '@docRole0');
  });
});

test('scopeClause — project partition restriction', async (t) => {
  await t.test('unscoped callers are unrestricted', () => {
    const access = { tier: TIER.PUBLIC, roles: ['public'], projectScope: null };
    assert.strictEqual(scopeClause(access, 'projectId').clause, 'true');
  });

  await t.test('scoped callers are restricted to their partitions', () => {
    const access = { tier: TIER.SCOPED, roles: ['public'], projectScope: ['207', '311'] };
    const { clause, params } = scopeClause(access, 'projectId');
    assert.strictEqual(clause, 'c.projectId IN (@scope0, @scope1)');
    assert.deepStrictEqual(params, [
      { name: '@scope0', value: '207' },
      { name: '@scope1', value: '311' }
    ]);
  });

  await t.test('scoped to nothing matches nothing — must not fall through to unrestricted', () => {
    const access = { tier: TIER.SCOPED, roles: ['public'], projectScope: [] };
    assert.strictEqual(scopeClause(access, 'projectId').clause, 'false');
  });
});

test('andClauses — composition', async (t) => {
  await t.test('drops true, keeps the rest, merges params', () => {
    const out = andClauses(
      { clause: 'true', params: [] },
      { clause: 'c.a = @x', params: [{ name: '@x', value: 1 }] },
      { clause: 'c.b = @y', params: [{ name: '@y', value: 2 }] }
    );
    assert.strictEqual(out.clause, '(c.a = @x) AND (c.b = @y)');
    assert.strictEqual(out.params.length, 2);
  });

  await t.test('a single false collapses the whole predicate', () => {
    const out = andClauses(
      { clause: 'c.a = @x', params: [{ name: '@x', value: 1 }] },
      { clause: 'false', params: [] }
    );
    assert.strictEqual(out.clause, 'false');
    assert.deepStrictEqual(out.params, []);
  });

  await t.test('throws on duplicate parameter names rather than silently dropping one', () => {
    assert.throws(() => andClauses(
      { clause: 'c.a = @p', params: [{ name: '@p', value: 1 }] },
      { clause: 'c.b = @p', params: [{ name: '@p', value: 2 }] }
    ), /duplicate SQL parameter/);
  });
});

test('visibilityFor — the predicate controllers actually use', async (t) => {
  await t.test('anonymous: ACL only', () => {
    const access = { tier: TIER.PUBLIC, roles: ['public'], projectScope: null };
    const { clause } = visibilityFor(access, 'projectId');
    assert.match(clause, /EXISTS/);
    assert.ok(!clause.includes('projectId IN'));
  });

  await t.test('privileged: unrestricted', () => {
    const access = { tier: TIER.PRIVILEGED, roles: ['public', 'sysadmin'], projectScope: null };
    assert.strictEqual(visibilityFor(access, 'projectId').clause, 'true');
  });

  await t.test('scoped: ACL AND partition restriction, both present', () => {
    const access = { tier: TIER.SCOPED, roles: ['public', 'project-team'], projectScope: ['207'] };
    const { clause, params } = visibilityFor(access, 'projectId');
    assert.match(clause, /EXISTS/, 'role ACL must still apply');
    assert.match(clause, /c\.projectId IN \(@scope0\)/, 'partition restriction must apply');
    assert.match(clause, / AND /);
    assert.ok(params.some(p => p.value === '207'));
  });
});

test('rolesFor / resolveAccess — roles come only from the verified token', async (t) => {
  await t.test('defaults to public', () => {
    assert.deepStrictEqual(rolesFor({}), ['public']);
  });

  await t.test('ignores client-supplied headers', () => {
    const req = { header: () => 'sysadmin', user: undefined };
    assert.deepStrictEqual(rolesFor(req), ['public']);
    assert.strictEqual(resolveAccess(req).tier, TIER.PUBLIC);
  });

  await t.test('a header cannot promote a caller to privileged', () => {
    const req = { header: () => 'sysadmin', query: { roles: 'sysadmin' } };
    assert.strictEqual(isPrivileged(rolesFor(req)), false);
  });

  await t.test('token roles resolve to the right tier', () => {
    const admin = resolveAccess({ user: { realm_access: { roles: ['staff'] } } });
    assert.strictEqual(admin.tier, TIER.PRIVILEGED);

    const scoped = resolveAccess({
      user: { realm_access: { roles: ['project-team'] }, projectScope: ['207'] }
    });
    assert.strictEqual(scoped.tier, TIER.SCOPED);
    assert.deepStrictEqual(scoped.projectScope, ['207']);
  });
});

test('canRead — point reads bypass the query predicate', async (t) => {
  const pub = { tier: TIER.PUBLIC, roles: ['public'], projectScope: null };
  const admin = { tier: TIER.PRIVILEGED, roles: ['public', 'sysadmin'], projectScope: null };

  await t.test('public cannot read a privately-ACL\'d item', () => {
    assert.strictEqual(canRead({ read: ['sysadmin'], isPublished: false }, pub), false);
  });

  await t.test('public can read a public item', () => {
    assert.strictEqual(canRead({ read: ['public'] }, pub), true);
  });

  await t.test('admin reads anything', () => {
    assert.strictEqual(canRead({ read: ['sysadmin'] }, admin), true);
  });

  await t.test('falls back to isPublished, and fails closed with neither marker', () => {
    assert.strictEqual(canRead({ isPublished: true }, pub), true);
    assert.strictEqual(canRead({}, pub), false, 'no ACL and no flag must not be public');
    assert.strictEqual(canRead(null, pub), false);
  });

  await t.test('a scoped caller cannot reach a project outside its scope BY ID', () => {
    // The regression that matters: the partition filter must not be bypassable via a point
    // read. A public-ACL'd document in a project the caller is not scoped to stays invisible.
    const scoped = { tier: TIER.SCOPED, roles: ['public', 'project-team'], projectScope: ['207'] };
    assert.strictEqual(canRead({ projectId: '207', read: ['public'] }, scoped), true);
    assert.strictEqual(canRead({ projectId: '999', read: ['public'] }, scoped), false);
  });
});
