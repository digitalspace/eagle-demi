'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  TIER,
  rolesFor,
  teamsFor,
  projectScopeFor,
  isPrivileged,
  readForLevel,
  levelOfRead,
  resolveAccess,
  readClause,
  scopeClause,
  andClauses,
  visibilityFor,
  canRead,
  systemAccess
} = require('../../src/helpers/access-sql');
// The break-glass identity is asserted from the real verifier, not from a copy of its role list.
const { authenticate } = require('../../src/helpers/auth');

// These tests assert the EMITTED SQL and parameters, not just behaviour. Authorization is the
// highest-consequence surface here and this repo has already shipped a filter that failed
// open once, so an edit that widens the predicate must fail a test rather than a review.

test('readClause — role ACL predicate', async (t) => {
  await t.test('privileged roles lift the role predicate, all but the sealed exclusion', () => {
    // Not a bare `true` any more: that short-circuit was what handed a privileged caller a level-0
    // row (docs/rbac-architecture.md §1, "Level 0").
    for (const role of ['sysadmin', 'demi-admin', 'demi-service-read']) {
      const { clause, params } = readClause(['public', role]);
      assert.strictEqual(clause, "NOT ARRAY_CONTAINS(c.read, 'compliance')",
        `${role} should be unrestricted apart from the sealed compartment`);
      assert.deepStrictEqual(params, []);
    }

    // A privileged caller that DOES hold it is the one caller with nothing to exclude.
    assert.strictEqual(readClause(['public', 'sysadmin', 'compliance']).clause, 'true');
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

  await t.test('a row with no read[] is not public', () => {
    // Both legacy fallthrough arms are gone: `isPublished` MIRRORS `read`, it never grants. A row
    // carrying no ladder token reaches privileged callers only.
    const { clause } = readClause(['public']);
    assert.ok(!clause.includes('IS_DEFINED'), 'the unset-ACL arm must not come back');
    assert.ok(!clause.includes('isPublished'), 'the isPublished arm must not come back');

    const anonymous = { tier: TIER.PUBLIC, roles: ['public'], projectScope: null, teams: [] };
    assert.strictEqual(canRead({ isPublished: true }, anonymous), false);
    assert.strictEqual(canRead({ read: [], isPublished: true }, anonymous), false);
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

  await t.test('privileged: unrestricted but for the sealed compartment', () => {
    const access = { tier: TIER.PRIVILEGED, roles: ['public', 'sysadmin'], projectScope: null };
    assert.strictEqual(visibilityFor(access, 'projectId').clause,
      "(NOT ARRAY_CONTAINS(c.read, 'compliance'))");
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
    const admin = resolveAccess({ user: { realm_access: { roles: ['sysadmin'] } } });
    assert.strictEqual(admin.tier, TIER.PRIVILEGED);

    const scoped = resolveAccess({
      user: { realm_access: { roles: ['project-team'] }, projectScope: ['207'] }
    });
    assert.strictEqual(scoped.tier, TIER.SCOPED);
    assert.deepStrictEqual(scoped.projectScope, ['207']);
  });

  await t.test('an IDIR login carries the idir token, from the claim not a realm role', () => {
    const idir = resolveAccess({ user: { realm_access: { roles: [] }, identity_provider: 'idir' } });
    assert.deepStrictEqual(idir.roles.sort(), ['idir', 'public']);
    assert.strictEqual(idir.level, 3);

    const bceid = resolveAccess({ user: { realm_access: { roles: [] }, identity_provider: 'bceid' } });
    assert.deepStrictEqual(bceid.roles, ['public']);
  });

  await t.test('a realm role named team is never a caller token', () => {
    // It would match the level-1 rows of EVERY project, its own or not.
    assert.deepStrictEqual(rolesFor({ user: { realm_access: { roles: ['team'] } } }), ['public']);
  });

  await t.test('a realm role named idir does not grant level 3', () => {
    assert.deepStrictEqual(rolesFor({ user: { realm_access: { roles: ['idir'] } } }), ['public']);

    const real = rolesFor({
      user: { realm_access: { roles: ['idir'] }, identity_provider: 'idir' }
    });
    assert.deepStrictEqual(real.sort(), ['idir', 'public'], 'the claim path, and it appears once');
  });
});

test('the ladder vocabulary', async (t) => {
  // Every expectation is a literal. Deriving one from the table under test would pass against any
  // table, including a wrong one.

  await t.test('staff is not privileged', () => {
    // The one line that makes level 1 enforceable: while staff short-circuited the predicate, no
    // row could be narrower than all of EAO.
    assert.strictEqual(isPrivileged(['staff']), false);
    assert.strictEqual(isPrivileged(['sysadmin']), true);
    assert.strictEqual(isPrivileged(['demi-admin']), true);
    assert.strictEqual(isPrivileged(['demi-service-read']), true);
    assert.strictEqual(isPrivileged(['demi-service-write']), true);
  });

  await t.test('the ladder tokens are not cumulative downwards', () => {
    // A level-2 row carrying `team` would hand a team-only caller every All-EAO row of its own
    // project — the exact leak the ladder exists to prevent.
    assert.deepStrictEqual(readForLevel(1), ['team']);
    assert.deepStrictEqual(readForLevel(2), ['staff']);
    assert.deepStrictEqual(readForLevel(3), ['staff', 'idir']);
    assert.deepStrictEqual(readForLevel(4), ['staff', 'idir', 'public']);

    // 0 is the sealed compartment: off the ladder, sharing no token with it, and the only
    // non-ladder level readForLevel accepts.
    assert.deepStrictEqual(readForLevel(0), ['compliance']);
    assert.strictEqual(levelOfRead(['compliance']), 0);
    assert.throws(() => readForLevel(5), /not a ladder level/);
    assert.throws(() => readForLevel(-1), /not a ladder level/);
  });

  await t.test('a legacy ACL reads as level 2', () => {
    // The whole back-compat story: no stored ACL is rewritten, and every one of them already
    // carries `staff` (plus `public` when published).
    assert.strictEqual(levelOfRead(['sysadmin', 'staff', 'demi-admin']), 2);
    assert.strictEqual(levelOfRead(['public', 'sysadmin', 'staff', 'demi-admin']), 4);
    assert.strictEqual(levelOfRead(['team']), 1);
    assert.strictEqual(levelOfRead(['staff', 'idir']), 3);
    assert.strictEqual(levelOfRead([]), 1);
    assert.strictEqual(levelOfRead(undefined), 1);
    assert.strictEqual(levelOfRead(['sysadmin']), 1, 'an admin role name is not a ladder token');
  });
});

test('teams grant, key scope restricts — two different project facts', async (t) => {
  const withRoles = (...roles) => ({ user: { realm_access: { roles } } });
  const keyScoped = (roles, projectScope) => ({ user: { realm_access: { roles }, projectScope } });

  await t.test('a project role never becomes a caller token', () => {
    // A caller carrying `team` would match the level-1 rows of EVERY project, its own or not.
    const req = withRoles('staff', 'project:207');

    assert.deepStrictEqual(rolesFor(req).sort(), ['public', 'staff']);
    assert.deepStrictEqual(teamsFor(req), ['207']);
    assert.strictEqual(projectScopeFor(req), null);
  });

  await t.test('a staff user token with project roles is not scoped', () => {
    const access = resolveAccess(withRoles('staff', 'project:207'));

    assert.strictEqual(access.tier, TIER.PUBLIC, 'membership grants, it never restricts');
    assert.deepStrictEqual(access.teams, ['207']);
    assert.strictEqual(access.projectScope, null);
  });

  await t.test('a staff caller with a project role still sees every level-2 row', () => {
    // The regression this split exists to prevent: routing `project:` roles through projectScope
    // dropped a staff caller to its one project and hid the rest of the corpus.
    const access = resolveAccess(withRoles('staff', 'project:207'));

    assert.strictEqual(canRead({ read: ['staff'], projectId: '300' }, access), true);
    assert.ok(!visibilityFor(access, 'projectId').clause.includes('c.projectId IN (@scope0)'),
      'no bare scope AND');
  });

  await t.test('a team-only row is visible to its team and to nobody else at level 2', () => {
    const row = { read: ['team'], projectId: '207' };

    assert.strictEqual(canRead(row, resolveAccess(withRoles('staff', 'project:207'))), true);
    assert.strictEqual(canRead(row, resolveAccess(withRoles('staff'))), false);
    assert.strictEqual(canRead(row, resolveAccess(withRoles('staff', 'project:300'))), false);
    assert.strictEqual(canRead(row, resolveAccess(withRoles('sysadmin'))), true);
  });

  await t.test('the team arm reaches the emitted SQL as bound parameters', () => {
    const access = resolveAccess(withRoles('staff', 'project:207'));
    const { clause, params } = visibilityFor(access, 'projectId');

    assert.match(clause, /ARRAY_CONTAINS\(c\.read, 'team'\) AND c\.projectId IN \(@roleT0\)/);
    assert.match(clause, / OR /, 'the team arm GRANTS — it is an OR, never an AND');
    assert.deepStrictEqual(params.find(p => p.name === '@roleT0'),
      { name: '@roleT0', value: '207' });
  });

  await t.test('a project IS its own scope, so the team arm compares id there', () => {
    const access = resolveAccess(withRoles('staff', 'project:207'));
    assert.match(visibilityFor(access, 'id').clause, /AND c\.id IN \(@roleT0\)/);
    assert.strictEqual(canRead({ read: ['team'], id: '207' }, access, 'id'), true);
    assert.strictEqual(canRead({ read: ['team'], id: '300' }, access, 'id'), false);
  });

  await t.test('an unknown partition field emits no team arm', () => {
    // The one value that reaches SQL uninterpolated. Unknown means no arm, not a guessed field.
    const access = resolveAccess(withRoles('staff', 'project:207'));
    const { clause, params } = readClause(access.roles,
      { teams: access.teams, partitionField: 'ownerId' });

    assert.ok(!clause.includes('ownerId'), 'the caller does not name the compared field');
    assert.ok(!clause.includes("ARRAY_CONTAINS(c.read, 'team')"), 'no team arm at all');
    assert.deepStrictEqual(params.map(p => p.name), ['@role0', '@role1']);
    assert.strictEqual(canRead({ read: ['team'], ownerId: '207' }, access, 'ownerId'), false);
  });

  await t.test('a caller prefix cannot collide with the team parameters', () => {
    // `@roleTeam0` used to be both this clause's first team id and the other clause's first role.
    const merged = andClauses(
      readClause(['public'], { teams: ['207'] }),
      readClause(['public'], { teams: ['207'], prefix: '@roleTeam' })
    );

    assert.deepStrictEqual(merged.params.map(p => p.name),
      ['@role0', '@roleT0', '@roleTeam0', '@roleTeamT0']);
  });

  await t.test('a staff API key with projectScope is still scoped', () => {
    // The issuer's restriction, and it must not be turned into a grant.
    const access = resolveAccess(keyScoped(['staff'], ['207']));

    assert.strictEqual(access.tier, TIER.SCOPED);
    assert.match(visibilityFor(access, 'projectId').clause, /c\.projectId IN \(@scope0\)/);
    assert.strictEqual(canRead({ projectId: '300', read: ['public'] }, access), false);
    assert.strictEqual(canRead({ projectId: '300', read: ['staff'] }, access), false);
    assert.strictEqual(canRead({ projectId: '207', read: ['staff'] }, access), true);
  });

  await t.test('no project: role means not scoped, not scoped-to-nothing', () => {
    // Scoped-to-nothing renders as `false` and would hide even public data from an ordinary
    // logged-in user. Absence of scope must fall to the public tier instead.
    const access = resolveAccess(withRoles('project-team'));
    assert.strictEqual(access.tier, TIER.PUBLIC);
    assert.strictEqual(access.projectScope, null);
    assert.deepStrictEqual(access.teams, []);
  });

  await t.test('an explicit empty projectScope claim still means scoped-to-nothing', () => {
    const access = resolveAccess(keyScoped([], []));
    assert.strictEqual(access.tier, TIER.SCOPED);
    assert.strictEqual(scopeClause(access, 'projectId').clause, 'false');
  });

  await t.test('a privileged key is still narrowed by its scope', () => {
    // This used to assert the opposite — that privilege discarded the scope — which is exactly the
    // leak: a credential minted with a projectScope read the whole corpus, so the restriction its
    // issuer asked for did nothing and said nothing.
    const access = resolveAccess(keyScoped(['sysadmin'], ['207']));
    assert.strictEqual(access.tier, TIER.SCOPED);

    // Privilege lifts the ROLE predicate; the project narrowing survives.
    const { clause, params } = visibilityFor(access, 'projectId');
    assert.strictEqual(clause,
      "(NOT ARRAY_CONTAINS(c.read, 'compliance')) AND (c.projectId IN (@scope0))");
    assert.deepStrictEqual(params, [{ name: '@scope0', value: '207' }]);
  });

  await t.test('a scoped privileged key still reads private rows INSIDE its scope', () => {
    // Scope narrows which projects; it must not downgrade the caller to public within them.
    const access = resolveAccess(keyScoped(['demi-service-read'], ['207']));

    assert.strictEqual(canRead({ projectId: '207', read: ['sysadmin'] }, access), true);
    assert.strictEqual(canRead({ projectId: '999', read: ['sysadmin'] }, access), false,
      'scope binds the point read too');
  });

  await t.test('an unscoped privileged caller is unrestricted, bar the sealed compartment', () => {
    const access = resolveAccess(withRoles('sysadmin'));
    assert.strictEqual(access.tier, TIER.PRIVILEGED);
    assert.strictEqual(access.projectScope, null);
    assert.strictEqual(visibilityFor(access, 'projectId').clause,
      "(NOT ARRAY_CONTAINS(c.read, 'compliance'))");
  });

  await t.test('systemAccess() cannot be scoped — it takes no request', () => {
    const access = systemAccess();
    assert.strictEqual(access.tier, TIER.PRIVILEGED);
    assert.strictEqual(access.projectScope, null);
    assert.deepStrictEqual(access.teams, []);
    assert.strictEqual(visibilityFor(access, 'projectId').clause,
      "(NOT ARRAY_CONTAINS(c.read, 'compliance'))");
  });

  await t.test('systemAccess is level 0', () => {
    assert.strictEqual(systemAccess().level, 0);
  });

  await t.test('resolveAccess carries a level', () => {
    assert.strictEqual(resolveAccess({}).level, 4);
    assert.strictEqual(resolveAccess({ user: { realm_access: { roles: ['sysadmin'] } } }).level, 1);
    assert.strictEqual(resolveAccess(withRoles('staff')).level, 2);
    assert.strictEqual(resolveAccess(withRoles('staff', 'project:207')).level, 2);
  });

  await t.test('a bare role name is never treated as a project id', () => {
    // The requested example was a role literally named `ajax`. Classifying bare names as project
    // facts would silently turn every role type into one.
    const access = resolveAccess(withRoles('ajax'));
    assert.strictEqual(access.tier, TIER.PUBLIC);
    assert.deepStrictEqual(access.teams, []);
    assert.ok(access.roles.includes('ajax'), 'it is a role TYPE, usable in read[]');
  });

  await t.test('malformed and duplicate project roles are handled', () => {
    const access = resolveAccess(withRoles('project:', 'project:  ', 'project:207', 'project:207'));
    assert.deepStrictEqual(access.teams, ['207'], 'empty ids dropped, duplicates collapsed');
  });

  await t.test('being on a team does not grant a role the caller lacks', () => {
    const access = resolveAccess(withRoles('project:207'));
    assert.strictEqual(
      canRead({ id: '207', read: ['sysadmin'], isPublished: false }, access, 'id'), false);
  });
});
test('canRead — point reads bypass the query predicate', async (t) => {
  const pub = { tier: TIER.PUBLIC, roles: ['public'], projectScope: null, teams: [] };
  const admin = { tier: TIER.PRIVILEGED, roles: ['public', 'sysadmin'], projectScope: null, teams: [] };

  await t.test('public cannot read a privately-ACL\'d item', () => {
    assert.strictEqual(canRead({ read: ['sysadmin'], isPublished: false }, pub), false);
  });

  await t.test('public can read a public item', () => {
    assert.strictEqual(canRead({ read: ['public'] }, pub), true);
  });

  await t.test('admin reads anything', () => {
    assert.strictEqual(canRead({ read: ['sysadmin'] }, admin), true);
  });

  await t.test('there is no isPublished fallback — it mirrors read[], it never grants', () => {
    assert.strictEqual(canRead({ isPublished: true }, pub), false);
    assert.strictEqual(canRead({}, pub), false, 'no ACL and no flag must not be public');
    assert.strictEqual(canRead(null, pub), false);
  });

  await t.test('a scoped caller cannot reach a project outside its scope BY ID', () => {
    // The regression that matters: the partition filter must not be bypassable via a point
    // read. A public-ACL'd document in a project the caller is not scoped to stays invisible.
    const scoped = {
      tier: TIER.SCOPED, roles: ['public', 'project-team'], projectScope: ['207'], teams: []
    };
    assert.strictEqual(canRead({ projectId: '207', read: ['public'] }, scoped), true);
    assert.strictEqual(canRead({ projectId: '999', read: ['public'] }, scoped), false);
  });
});

// The sealed compartment (docs/rbac-architecture.md §1, "Level 0"). A level-0 row sits in its
// ordinary container with `read: ['compliance']`, so the ONLY thing keeping it sealed is that
// every caller without that role carries an exclusion — the privileged ones especially, whose
// predicate would otherwise collapse to `true`.
test('level 0 — the sealed compartment', async (t) => {
  const SEALED = { id: 'p1', projectId: 'p1', read: readForLevel(0) };
  const access = (roles, extra = {}) => resolveAccess({ user: { realm_access: { roles } }, ...extra });

  await t.test('sysadmin cannot read a compliance-only row', () => {
    assert.strictEqual(canRead(SEALED, access(['sysadmin'])), false);
    assert.match(readClause(['sysadmin']).clause, /NOT ARRAY_CONTAINS/);

    // Every other privileged role, since each of them short-circuits the same way.
    for (const role of ['demi-admin', 'demi-service-read', 'demi-service-write', 'staff']) {
      assert.strictEqual(canRead(SEALED, access([role])), false, `${role} must not read a sealed row`);
    }
  });

  await t.test('an unprivileged caller carries the exclusion on its own arm', () => {
    // The anonymous clause ends in the exclusion; deleting the AND leaves `staff` reading a row
    // that carries both `public` and `compliance`.
    const anon = readClause([]);
    assert.match(anon.clause, /AND NOT ARRAY_CONTAINS\(c\.read, 'compliance'\)$/);
    assert.match(readClause(['staff']).clause, /AND NOT ARRAY_CONTAINS/);
    assert.strictEqual(canRead({ id: 'p2', projectId: 'p2', read: ['public', 'compliance'] }, access([])), false);
    assert.strictEqual(canRead({ id: 'p2', projectId: 'p2', read: ['staff', 'compliance'] }, access(['staff'])), false);
  });

  await t.test('a row without read[] is dropped by the point read as by the list', () => {
    // `NOT ARRAY_CONTAINS` is undefined on a row with no `read`, so lists drop it for every caller;
    // canRead answers the same, privileged callers and systemAccess included.
    for (const a of [access(['sysadmin']), systemAccess(), access([])]) {
      assert.strictEqual(canRead({ id: 'p3', projectId: 'p3' }, a), false);
    }
  });

  await t.test('systemAccess excludes compliance-only rows', () => {
    // Exports, seed, reconcile and the extraction worker all read through it.
    assert.ok(!systemAccess().roles.includes('compliance'), 'the role list must stay compliance-free');
    assert.strictEqual(canRead(SEALED, systemAccess()), false);
  });

  await t.test('break-glass key has no compliance role', () => {
    // One shared secret must not open the compartment (doc §1, condition 1).
    process.env.ADMIN_API_KEY = 'break-glass-for-this-test';
    t.after(() => { delete process.env.ADMIN_API_KEY; });

    let identity;
    authenticate(
      { header: (name) => (name === 'X-Api-Key' ? 'break-glass-for-this-test' : null) },
      (user) => { identity = user; },
      (status, error) => assert.fail(`break-glass refused: ${status} ${error}`)
    );

    assert.ok(identity, 'the break-glass path must still authenticate');
    assert.ok(!identity.realm_access.roles.includes('compliance'));
    assert.strictEqual(canRead(SEALED, resolveAccess({ user: identity })), false);
  });

  await t.test('compliance reads it', () => {
    const holder = access(['compliance']);
    assert.strictEqual(canRead(SEALED, holder), true);
    assert.strictEqual(readClause(holder.roles).clause.includes('NOT ARRAY_CONTAINS'), false,
      'the holder is the one caller with nothing to exclude');

    // And the compartment is not a wider tier: `compliance` is not privileged, so a level-2 row
    // is no more visible to it than to any other unprivileged caller.
    assert.strictEqual(canRead({ id: 'p2', projectId: 'p2', read: readForLevel(2) }, holder), false);
  });

  await t.test('a credential can never name the sealed level', () => {
    // `levels` are 1-3, and levelTokens() maps nothing else, so the credential arm cannot match a
    // row whose only token is `compliance` — the exclusion is not what carries this, the vocabulary is.
    const credentialed = access(['public']);
    credentialed.credentials = [{ scope: { type: 'project', ids: ['p1'] }, levels: [0, 1, 2, 3] }];
    assert.strictEqual(canRead(SEALED, credentialed), false);
    assert.ok(!readClause(credentialed.roles, { credentials: credentialed.credentials })
      .params.some(p => p.value === 'compliance'), 'no arm binds the sealed token as a grant');
  });
});
