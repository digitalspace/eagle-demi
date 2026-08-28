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

const { plan, sync, summaryLine, usernameFor } = require('../../src/scripts/sync-track-teams');

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

  return {
    log, tokens, roleMap, users: realmUsers,
    clientToken: async (clientId) => { tokens.push(clientId); return `token-${clientId}`; },
    // Keycloak's `search` is a substring match, which is what this mimics.
    listProjectRoles: async () => [...roleMap.values()].filter(r => r.name.includes('project:')),
    roleUsers: async (name) => realmUsers.filter(u => u.roles.has(name))
      .map(u => ({ id: u.id, username: u.username })),
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

const fakeFetch = (teams, seen = {}) => async (url, headers) => {
  seen.url = url;
  seen.headers = headers;
  return teams;
};

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
    '[track-teams] mode=live projects=2 users=2 grants=3 revokes=0 unmatched=0 failures=0');
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
  const teams = [{ project_id: 1, staff: [BO] }];
  const kc = fakeKc({
    roles: ['project:1', 'project:2', 'staff', 'demi-admin'],
    users: [realmBo(['project:1', 'project:2', 'staff', 'demi-admin'])]
  });

  await sync(['--live'], { fetchJson: fakeFetch(teams), kc });

  assert.deepStrictEqual(kc.log, [['revoke', 'u-bo', ['project:2']]]);
  assert.deepStrictEqual([...kc.users[0].roles].sort(),
    ['demi-admin', 'project:1', 'staff']);
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
  const decided = plan([{ project_id: 1, staff: [ADA] }], {
    current: new Map([['aaaa1111@idir', new Set(['project:9', 'staff'])]]),
    roles: new Set(['project:1', 'project:9'])
  });

  assert.deepStrictEqual(decided.grants, [{ username: 'aaaa1111@idir', roles: ['project:1'] }]);
  assert.deepStrictEqual(decided.revokes, [{ username: 'aaaa1111@idir', roles: ['project:9'] }]);
  assert.deepStrictEqual(decided.rolesToCreate, []);
});
