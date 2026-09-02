'use strict';

/**
 * The reconcile is the whole point of this script, so the realm is an in-memory fake and every
 * assertion is on what it was ASKED to write — literal role names, literal user ids, in order.
 * Nothing here reaches Track or Keycloak.
 */

process.env.NODE_ENV = 'test';
process.env.TRACK_API_BASE = 'https://track.example';
process.env.TRACK_CLIENT_ID = 'demi-track-reader';

const test = require('node:test');
const assert = require('node:assert');

const {
  plan, sync, summaryLine, usernameFor, run, keycloakClient, exitCodeFor, drainAudit
} = require('../../src/scripts/sync-track-teams');
const accessSql = require('../../src/helpers/access-sql');

// Track staff rows. The IDIR GUID is upper case in Track and lower case in Keycloak usernames.
const ADA = { staff_id: 10, idir_user_id: 'AAAA1111', email: 'ada@gov.bc.ca', is_active: true };
const BO = { staff_id: 11, idir_user_id: 'BBBB2222', email: 'bo@gov.bc.ca', is_active: true };

/** Bo is on both projects; the desired set is the union, not the last project seen. */
const TEAMS = [
  { project_id: 1, staff: [ADA, BO] },
  { project_id: 2, staff: [BO] }
];

const realmAda = (roles = []) =>
  ({ id: 'u-ada', username: 'aaaa1111@idir', email: 'ada@gov.bc.ca', roles });
const realmBo = (roles = []) =>
  ({ id: 'u-bo', username: 'bbbb2222@idir', email: 'bo@gov.bc.ca', roles });

/**
 * An in-memory realm. Reads are not logged; every WRITE is, in order, because "created the role
 * before granting it" is one of the things worth failing on.
 */
function fakeKc({ roles = [], users = [] } = {}) {
  const roleMap = new Map(roles.map(name => [name, { id: `role-${name}`, name }]));
  const realmUsers = users.map(u => ({ ...u, roles: new Set(u.roles) }));
  const byId = (id) => realmUsers.find(u => u.id === id);
  const log = [];
  const tokens = [];
  const enumerated = [];

  return {
    log, tokens, enumerated, roleMap, users: realmUsers,
    clientToken: async (clientId) => { tokens.push(clientId); return `token-${clientId}`; },
    // Every realm role, `staff` and `demi-admin` included: the script's own prefix filter is what
    // has to keep them out, so the fake must not do that filtering for it.
    listProjectRoles: async () => [...roleMap.values()],
    roleUsers: async (name) => {
      enumerated.push(name);
      return realmUsers.filter(u => u.roles.has(name))
        .map(u => ({ id: u.id, username: u.username }));
    },
    findByUsername: async (username) => realmUsers.find(u => u.username === username) || null,
    findByEmail: async (email) => realmUsers.find(u => u.email === email) || null,
    createRole: async (name) => {
      log.push(['createRole', name]);
      if (!roleMap.has(name)) roleMap.set(name, { id: `role-${name}`, name });
      return roleMap.get(name);
    },
    grant: async (userId, reps) => {
      log.push(['grant', userId, reps.map(r => r.name)]);
      for (const r of reps) byId(userId).roles.add(r.name);
    },
    revoke: async (userId, reps) => {
      log.push(['revoke', userId, reps.map(r => r.name)]);
      for (const r of reps) byId(userId).roles.delete(r.name);
    }
  };
}

/** Track answers two endpoints on the same bearer: the team feed and the project list. */
const fakeFetch = (teams, seen = {}, projects = []) => async (url, headers) => {
  const teamFeed = url.endsWith('/team-members');
  if (teamFeed) { seen.url = url; seen.headers = headers; }
  else seen.projectsUrl = url;
  return teamFeed ? teams : projects;
};

/**
 * The `credentials` repository, in memory, with the real narrow-or-revoke behaviour. Every call is
 * logged, because "read once, touched the closed project and nothing else" is the whole assertion.
 */
function fakeCredentials(rows = [], { throwsFor } = {}) {
  const live = rows.map(r => ({ ...r, scope: { ...r.scope, ids: [...r.scope.ids] } }));
  const calls = [];
  const over = (projectId) => live.filter(r => !r.revokedAt && r.scope.ids.includes(projectId));
  return {
    calls, rows: live,
    listLiveProjectScoped: async () => {
      calls.push(['listLive']);
      return live.filter(r => !r.revokedAt);
    },
    revokeForProject: async (projectId, cause) => {
      calls.push(['revoke', projectId, cause]);
      if (throwsFor === projectId) throw new Error('cosmos said no');
      const hit = over(projectId);
      for (const row of hit) {
        const remaining = row.scope.ids.filter(id => id !== projectId);
        if (remaining.length) row.scope.ids = remaining;
        else row.revokedAt = '2026-09-02T00:00:00.000Z';
        row.cause = cause;
      }
      return hit;
    }
  };
}

const projectGrant = (id, ids) => ({ id, scope: { type: 'project', ids } });

const CLOSED_AND_OPEN = [
  { id: 1, is_project_closed: true, project_state: 'Closed' },
  { id: 2, is_project_closed: false, project_state: 'Operation' }
];

const TWO_AND_ONE = [
  projectGrant('c1', ['1']),
  projectGrant('c2', ['1']),
  projectGrant('c3', ['2'])
];

test('usernameFor never doubles the @idir suffix Track already carries', () => {
  assert.strictEqual(usernameFor({ idir_user_id: 'AAAA1111@idir' }), 'aaaa1111@idir');
  assert.strictEqual(usernameFor({ idir_user_id: 'AAAA1111' }), 'aaaa1111@idir');
});

test('a user on two projects is granted both roles, and the feed is read with a bearer', async () => {
  const kc = fakeKc({ roles: ['project:1', 'project:2'], users: [realmAda(), realmBo()] });
  const seen = {};

  const summary = await sync(['--live'], { fetchJson: fakeFetch(TEAMS, seen), kc });

  assert.strictEqual(seen.url, 'https://track.example/api/v1/projects/team-members');
  assert.deepStrictEqual(seen.headers, { Authorization: 'Bearer token-demi-track-reader' });
  assert.deepStrictEqual(kc.tokens, ['demi-track-reader']);
  assert.deepStrictEqual(kc.log, [
    ['grant', 'u-ada', ['project:1']],
    ['grant', 'u-bo', ['project:1', 'project:2']]
  ]);
  assert.strictEqual(summaryLine(summary),
    '[track-teams] mode=live projects=2 users=2 grants=3 revokes=0 unmatched=0 ' +
    'closedProjects=0 credentialsRevoked=0 failures=0');
});

test('a departed staff member loses every project role they held', async () => {
  const departed = [
    { project_id: 1, staff: [ADA, { ...BO, is_active: false }] },
    { project_id: 2, staff: [{ ...BO, is_active: false }] }
  ];
  const kc = fakeKc({
    roles: ['project:1', 'project:2'],
    users: [realmAda(['project:1']), realmBo(['project:1', 'project:2'])]
  });

  const summary = await sync(['--live'], { fetchJson: fakeFetch(departed), kc });

  assert.deepStrictEqual(kc.log, [['revoke', 'u-bo', ['project:1', 'project:2']]]);
  assert.deepStrictEqual([...kc.users[1].roles], []);
  assert.strictEqual(summary.grants, 0);
  assert.strictEqual(summary.revokes, 2);
  assert.strictEqual(summary.users, 1, 'only the staff member still on a team is counted');
});

test('a staff row nothing can be matched to mints no role', async () => {
  const teams = [{ project_id: 1, staff: [
    { staff_id: 99, is_active: true },
    { staff_id: 98, email: 'ghost@gov.bc.ca', is_active: true }
  ] }];
  const kc = fakeKc({ roles: ['project:1'], users: [realmAda()] });

  const summary = await sync(['--live'], { fetchJson: fakeFetch(teams), kc });

  assert.deepStrictEqual(kc.log, [], 'no identity, no write of any kind');
  assert.deepStrictEqual(summary.plan.unmatched, ['98', '99']);
  assert.strictEqual(summary.unmatched, 2);
  assert.strictEqual(summary.grants, 0);
});

test('a dry run writes nothing and still reports the plan', async () => {
  const kc = fakeKc({ roles: [], users: [realmAda(), realmBo()] });

  const summary = await sync([], { fetchJson: fakeFetch(TEAMS), kc });

  assert.deepStrictEqual(kc.log, []);
  assert.strictEqual(summary.mode, 'dry-run');
  assert.deepStrictEqual(summary.plan.rolesToCreate, ['project:1', 'project:2']);
  assert.strictEqual(summary.grants, 3, 'the counts are what a --live run would do');
  assert.deepStrictEqual([...kc.users[0].roles], []);
});

test('a stale project role is revoked and the hand-granted roles are left alone', async () => {
  const teams = [{ project_id: 1, staff: [BO] }, { project_id: 2, staff: [] }];
  const kc = fakeKc({
    roles: ['project:1', 'project:2', 'staff', 'demi-admin'],
    users: [realmBo(['project:1', 'project:2', 'staff', 'demi-admin'])]
  });

  await sync(['--live'], { fetchJson: fakeFetch(teams), kc });

  assert.deepStrictEqual(kc.log, [['revoke', 'u-bo', ['project:2']]]);
  assert.deepStrictEqual([...kc.users[0].roles].sort(),
    ['demi-admin', 'project:1', 'staff']);
  assert.deepStrictEqual(kc.enumerated, ['project:1', 'project:2'],
    'a hand-granted role is not even read, let alone written');
});

test('a project role Track does not know is left alone', async () => {
  const teams = [{ project_id: 1, staff: [ADA] }];
  const kc = fakeKc({
    roles: ['project:1', 'project:eagle-abc'],
    users: [realmAda(['project:1', 'project:eagle-abc'])]
  });

  const summary = await sync(['--live'], { fetchJson: fakeFetch(teams), kc });

  assert.deepStrictEqual(kc.log, [],
    'an Eagle-only project has no Track team, so nothing here may take its scope away');
  assert.strictEqual(summary.revokes, 0);
  assert.deepStrictEqual([...kc.users[0].roles].sort(), ['project:1', 'project:eagle-abc']);
});

test('a Track project with an empty team revokes its holders', async () => {
  const teams = [{ project_id: 2, staff: [] }];
  const kc = fakeKc({ roles: ['project:2'], users: [realmBo(['project:2'])] });

  const summary = await sync(['--live'], { fetchJson: fakeFetch(teams), kc });

  assert.deepStrictEqual(kc.log, [['revoke', 'u-bo', ['project:2']]],
    'the feed lists the project, so an empty team means the team is empty');
  assert.strictEqual(summary.revokes, 1);
});

test('a missing realm role is created before it is granted', async () => {
  const teams = [{ project_id: 3, staff: [ADA] }];
  const kc = fakeKc({ roles: [], users: [realmAda()] });

  await sync(['--live'], { fetchJson: fakeFetch(teams), kc });

  assert.deepStrictEqual(kc.log, [
    ['createRole', 'project:3'],
    ['grant', 'u-ada', ['project:3']]
  ]);
});

test('a staff row with no IDIR GUID is matched on email', () => {
  const byEmail = new Map([['bo@gov.bc.ca', 'bbbb2222@idir']]);

  assert.strictEqual(usernameFor({ email: 'BO@gov.bc.ca' }, byEmail), 'bbbb2222@idir');
  assert.strictEqual(usernameFor(ADA, byEmail), 'aaaa1111@idir',
    'the GUID wins when it is there, and Keycloak holds it lower case');
  assert.strictEqual(usernameFor({ staff_id: 1 }, byEmail), null);
});

test('plan touches no role outside the project: prefix', () => {
  const decided = plan([{ project_id: 1, staff: [ADA] }, { project_id: 9, staff: [] }], {
    current: new Map([['aaaa1111@idir', new Set(['project:9', 'staff'])]]),
    roles: new Set(['project:1', 'project:9'])
  });

  assert.deepStrictEqual(decided.grants, [{ username: 'aaaa1111@idir', roles: ['project:1'] }]);
  assert.deepStrictEqual(decided.revokes, [{ username: 'aaaa1111@idir', roles: ['project:9'] }]);
  assert.deepStrictEqual(decided.rolesToCreate, []);
});

test('a live run is refused before the team-grant model exists', async () => {
  const held = Object.getOwnPropertyDescriptor(accessSql, 'teamsFor');
  delete accessSql.teamsFor;
  try {
    const kc = fakeKc({ roles: [], users: [realmAda(), realmBo()] });

    const summary = await run({ live: true, deps: { fetchJson: fakeFetch(TEAMS), kc } });

    assert.deepStrictEqual(kc.log, [], 'no role is created and none is granted');
    assert.strictEqual(summary.mode, 'refused');
    assert.strictEqual(summary.grants, 3, 'the plan is still reported');
  } finally {
    if (held) Object.defineProperty(accessSql, 'teamsFor', held);
  }
});

test('an expired admin token is refreshed once', async (t) => {
  const bodies = [
    { access_token: 'admin-token' },
    401,
    { access_token: 'fresh-token' },
    [{ name: 'project:1' }]
  ];
  const urls = [];
  t.mock.method(global, 'fetch', async (url) => {
    urls.push(String(url));
    const body = bodies.shift();
    if (body === 401) return { ok: false, status: 401, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  });

  const roles = await keycloakClient().listProjectRoles();

  assert.deepStrictEqual(roles, [{ name: 'project:1' }], 'the retry is what the caller gets back');
  assert.strictEqual(urls.filter(u => u.endsWith('/protocol/openid-connect/token')).length, 2,
    'a run longer than the token lifetime re-mints instead of failing the night');
  assert.strictEqual(urls.length, 4, 'and it retries the call once, not in a loop');
});

test('role listing pages past 1000', async (t) => {
  const page = (n, tag) => Array.from({ length: n }, (_, i) => ({ name: `project:${tag}${i}` }));
  const bodies = [{ access_token: 'admin-token' }, page(1000, 'a'), page(3, 'b')];
  const urls = [];
  t.mock.method(global, 'fetch', async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => bodies.shift() };
  });

  const roles = await keycloakClient().listProjectRoles();

  assert.strictEqual(roles.length, 1003, 'both pages, not just the first');
  assert.strictEqual(urls.length, 3, 'a short page ends the walk');
  assert.ok(urls[1].endsWith('first=0&max=1000'), urls[1]);
  assert.ok(urls[2].endsWith('first=1000&max=1000'), urls[2]);
});

test('closing a project revokes its credentials and leaves an open project alone', async () => {
  const kc = fakeKc({ roles: ['project:1', 'project:2'], users: [realmAda(), realmBo()] });
  const credentials = fakeCredentials(TWO_AND_ONE);
  const seen = {};

  const summary = await sync(['--live'],
    { fetchJson: fakeFetch(TEAMS, seen, CLOSED_AND_OPEN), kc, credentials });

  assert.strictEqual(seen.projectsUrl, 'https://track.example/api/v1/projects');
  assert.deepStrictEqual(credentials.calls, [['listLive'], ['revoke', '1', 'project-closed']],
    'one read for the sweep, and the open project is never even asked about');
  assert.deepStrictEqual(credentials.rows.filter(r => r.revokedAt).map(r => r.id), ['c1', 'c2']);
  assert.deepStrictEqual([...new Set(credentials.rows.filter(r => r.cause).map(r => r.cause))],
    ['project-closed']);
  assert.strictEqual(summary.closedProjects, 1);
  assert.strictEqual(summary.credentialsRevoked, 2);
  assert.ok(summaryLine(summary).includes('closedProjects=1 credentialsRevoked=2'),
    summaryLine(summary));
});

test('a dry run revokes no credential and still counts them', async () => {
  const kc = fakeKc({ roles: ['project:1', 'project:2'], users: [realmAda(), realmBo()] });
  const credentials = fakeCredentials(TWO_AND_ONE);

  const summary = await sync([], { fetchJson: fakeFetch(TEAMS, {}, CLOSED_AND_OPEN), kc, credentials });

  assert.deepStrictEqual(credentials.calls, [['listLive']], 'the same one read, no write');
  assert.deepStrictEqual(credentials.rows.filter(r => r.revokedAt), []);
  assert.strictEqual(summary.credentialsRevoked, 2, 'the count is what a --live run would touch');
});

test('a grant over several projects is narrowed, not revoked, when one of them closes', async () => {
  const kc = fakeKc({ roles: ['project:1', 'project:2'], users: [realmAda(), realmBo()] });
  const credentials = fakeCredentials([projectGrant('c1', ['1', '2'])]);

  const summary = await sync(['--live'],
    { fetchJson: fakeFetch(TEAMS, {}, CLOSED_AND_OPEN), kc, credentials });

  assert.deepStrictEqual(credentials.rows[0].scope.ids, ['2'], 'the open project survives');
  assert.strictEqual(credentials.rows[0].revokedAt, undefined);
  assert.strictEqual(summary.credentialsRevoked, 1);
});

test('the credentials listing is read once per run, however many projects are closed', async () => {
  const kc = fakeKc({ roles: ['project:1', 'project:2'], users: [realmAda(), realmBo()] });
  const credentials = fakeCredentials(TWO_AND_ONE);
  const closed = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, is_project_closed: true }));

  const summary = await sync(['--live'], { fetchJson: fakeFetch(TEAMS, {}, closed), kc, credentials });

  assert.strictEqual(credentials.calls.filter(c => c[0] === 'listLive').length, 1);
  assert.deepStrictEqual(credentials.calls.filter(c => c[0] === 'revoke').map(c => c[1]),
    ['1', '2'], 'only the closed projects some live grant actually names');
  assert.strictEqual(summary.closedProjects, 40);
  assert.strictEqual(summary.credentialsRevoked, 3);
});

test('one project whose revoke fails is counted and does not stop the next', async () => {
  const kc = fakeKc({ roles: ['project:1', 'project:2'], users: [realmAda(), realmBo()] });
  const credentials = fakeCredentials(TWO_AND_ONE, { throwsFor: '1' });
  const bothClosed = [
    { id: 1, is_project_closed: true },
    { id: 2, is_project_closed: true }
  ];

  const summary = await run({ live: true, deps: { fetchJson: fakeFetch(TEAMS, {}, bothClosed), kc, credentials } });

  assert.strictEqual(summary.failures, 1);
  assert.strictEqual(summary.credentialsRevoked, 1, 'project 2 is still processed');
  assert.deepStrictEqual(credentials.rows.filter(r => r.revokedAt).map(r => r.id), ['c3']);
  assert.strictEqual(exitCodeFor(summary), 1, 'the night exits non-zero');
});

test('a closed project with no credentials revokes nothing and does not fail', async () => {
  const kc = fakeKc({ roles: ['project:1', 'project:2'], users: [realmAda(), realmBo()] });
  const credentials = fakeCredentials([projectGrant('c3', ['2'])]);

  const summary = await sync(['--live'],
    { fetchJson: fakeFetch(TEAMS, {}, CLOSED_AND_OPEN), kc, credentials });

  assert.strictEqual(summary.closedProjects, 1);
  assert.strictEqual(summary.credentialsRevoked, 0);
  assert.strictEqual(summary.failures, 0);
  assert.deepStrictEqual(credentials.rows.filter(r => r.revokedAt), []);
});

test('project_state Closed counts even when is_project_closed is false', async () => {
  const kc = fakeKc({ roles: ['project:1', 'project:2'], users: [realmAda(), realmBo()] });
  const credentials = fakeCredentials(TWO_AND_ONE);
  const projects = [{ id: 1, is_project_closed: false, project_state: 'Closed' }];

  const summary = await sync(['--live'], { fetchJson: fakeFetch(TEAMS, {}, projects), kc, credentials });

  assert.strictEqual(summary.closedProjects, 1);
  assert.strictEqual(summary.credentialsRevoked, 2);
});

test('a thrown /api/v1/projects read is caught: grants stand and the summary still logs', async () => {
  const kc = fakeKc({ roles: ['project:1', 'project:2'], users: [realmAda(), realmBo()] });
  const fetchProjectsThrows = async (url) => {
    if (url.endsWith('/team-members')) return TEAMS;
    throw new Error('Track is down');
  };

  const summary = await sync(['--live'], { fetchJson: fetchProjectsThrows, kc });

  assert.deepStrictEqual(kc.log, [
    ['grant', 'u-ada', ['project:1']],
    ['grant', 'u-bo', ['project:1', 'project:2']]
  ], 'the Keycloak writes already applied are not rolled back');
  assert.strictEqual(summary.failures, 1);
  assert.strictEqual(summary.closedProjects, 0);
  assert.strictEqual(summary.credentialsRevoked, 0);
  assert.ok(summaryLine(summary).includes('failures=1'), summaryLine(summary));
});

test('drainAudit awaits flush before the CLI would exit', async () => {
  const calls = [];
  await drainAudit({ flush: async () => { calls.push('flush'); } });
  assert.deepStrictEqual(calls, ['flush']);
});

test('drainAudit logs rather than throws when flush rejects', async () => {
  await drainAudit({ flush: async () => { throw new Error('DCR unreachable'); } });
});

test('no COSMOS_ENDPOINT reports zero instead of reaching for Cosmos', async (t) => {
  const kc = fakeKc({ roles: ['project:1', 'project:2'], users: [realmAda(), realmBo()] });
  // The CLI dry-run case, held here rather than assumed: the var is set in every deployed env.
  const held = process.env.COSMOS_ENDPOINT;
  delete process.env.COSMOS_ENDPOINT;
  t.after(() => { if (held !== undefined) process.env.COSMOS_ENDPOINT = held; });

  const summary = await sync([], { fetchJson: fakeFetch(TEAMS, {}, CLOSED_AND_OPEN), kc });

  assert.strictEqual(summary.closedProjects, 1);
  assert.strictEqual(summary.credentialsRevoked, 0);
  assert.strictEqual(summary.failures, 0);
});
