'use strict';

// The group routes end to end through the dispatcher: route guards, the write handler and the
// domain, and the members read, over fake repositories.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

const config = require('../../../src/config');
const groups = require('../../../src/repositories/groups');
const projects = require('../../../src/repositories/projects');
const users = require('../../../src/repositories/users');
const { withServer } = require('../../helpers/with-server');

const PROJECT_ID = 'p-public';
const GROUP_ID = '5c1f7a3e9b1d2c0012370001';
const USER_A = '5c1f7a3e9b1d2c0012380001';
const USER_B = '5c1f7a3e9b1d2c0012380002';
const STORED = Object.freeze({
  id: GROUP_ID, eagleId: GROUP_ID, projectId: PROJECT_ID, sourceSystem: 'eagle', name: 'Agencies',
  members: [USER_A], links: [], read: ['staff', 'sysadmin'], isPublished: false, _etag: 'e1'
});

/** Fake storage holding `stored` under a public project; returns the rows written and deleted. */
function fakeStore(t, stored = STORED) {
  const store = { written: [], deleted: [], userQueries: [] };
  const byId = async (access, id) => stored && id === stored.id ? { ...stored } : null;
  t.mock.method(groups, 'getById', byId);
  t.mock.method(groups.native, 'getById', byId);
  t.mock.method(groups, 'upsert', async (row) => { store.written.push(row); return { ...row, _etag: 'e2' }; });
  t.mock.method(groups, 'deleteById', async (...args) => { store.deleted.push(args); return true; });
  t.mock.method(projects, 'getById', async (access, id) =>
    id === PROJECT_ID ? { id, read: ['public', 'staff', 'sysadmin'] } : null);
  t.mock.method(users.native, 'list', async (access, opts) => {
    store.userQueries.push(opts);
    return [{ id: USER_A, displayName: 'Pat', email: 'pat@example.com', read: ['staff'] }];
  });
  t.mock.method(users.native, 'count', async () => 1);
  return store;
}

async function send(method, path, roles, body) {
  const token = jwt.sign({ sub: 'kc-1', preferred_username: 'idir-user', realm_access: { roles } }, 'suite-only');
  let result;
  await withServer(async (call) => {
    const res = await call(`/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    result = { status: res.status, body: await res.json(), total: res.headers.get('x-total-count') };
  });
  return result;
}

const ROUTES = {
  create: (roles, body = { projectId: PROJECT_ID, name: 'Nations' }) => send('POST', '/groups', roles, body),
  update: (roles, body = { name: 'Nations' }, id = GROUP_ID) => send('PUT', `/groups/${id}`, roles, body),
  delete: (roles) => send('DELETE', `/groups/${GROUP_ID}`, roles),
  members: (roles, query = '') => send('GET', `/groups/${GROUP_ID}/members${query}`, roles),
  addMembers: (roles, body = { members: [USER_B] }) => send('POST', `/groups/${GROUP_ID}/members`, roles, body),
  removeMember: (roles, userId = USER_A) => send('DELETE', `/groups/${GROUP_ID}/members/${userId}`, roles)
};

test('group routes', async (t) => {
  t.beforeEach((t) => {
    const keycloakEnabled = config.keycloakEnabled;
    config.keycloakEnabled = false;
    t.after(() => { config.keycloakEnabled = keycloakEnabled; });
  });
  t.afterEach(() => t.mock.restoreAll());

  await t.test('staff creates a group: 201, staff-only, read withheld', async (t) => {
    const store = fakeStore(t);
    const res = await ROUTES.create(['staff']);
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.id, store.written[0].id);
    assert.strictEqual(res.body.name, 'Nations');
    assert.strictEqual(res.body.sourceSystem, 'demi');
    assert.strictEqual(res.body.isPublished, false);
    assert.strictEqual(res.body.read, undefined, 'read[] never leaves the service');
  });

  await t.test('a create under an unknown project is a 400 naming projectId', async (t) => {
    fakeStore(t);
    const res = await ROUTES.create(['staff'], { projectId: 'p-missing' });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.fields.projectId);
  });

  await t.test('project-system-admin renames a group: 200 with the new name', async (t) => {
    const store = fakeStore(t);
    // demi-admin passes authMiddleware but not requireRole on its own; project-system-admin admits it.
    const res = await ROUTES.update(['project-system-admin', 'demi-admin']);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.name, 'Nations');
    assert.strictEqual(store.written[0].name, 'Nations');
  });

  await t.test('an update naming members is a 400: only name is writable', async (t) => {
    const store = fakeStore(t);
    const res = await ROUTES.update(['staff'], { members: [USER_B] });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.fields.members);
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('an update of a missing group is 404', async (t) => {
    fakeStore(t);
    const res = await ROUTES.update(['staff'], { name: 'x' }, '5c1f7a3e9b1d2c0012379999');
    assert.strictEqual(res.status, 404);
  });

  await t.test('sysadmin deletes a group: 200 and the row is removed', async (t) => {
    const store = fakeStore(t);
    const res = await ROUTES.delete(['sysadmin']);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(store.deleted, [[GROUP_ID, PROJECT_ID, 'e1']]);
  });

  await t.test('staff adds a member: 200 with the new list', async (t) => {
    const store = fakeStore(t);
    const res = await ROUTES.addMembers(['staff']);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.members, [USER_A, USER_B]);
    assert.deepStrictEqual(store.written[0].members, [USER_A, USER_B]);
  });

  await t.test('staff removes a member by the second path parameter', async (t) => {
    const store = fakeStore(t);
    const res = await ROUTES.removeMember(['staff']);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(store.written[0].members, []);
  });

  await t.test('a malformed member id on remove is a 400 naming userId', async (t) => {
    const store = fakeStore(t);
    const res = await ROUTES.removeMember(['staff'], 'nope');
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.fields.userId);
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('the members read asks the users read for the group members only, paged and counted', async (t) => {
    const store = fakeStore(t);
    const res = await ROUTES.members(['staff'], '?sort=displayName&count=true');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.map(user => user.id), [USER_A]);
    assert.strictEqual(res.body[0].read, undefined);
    assert.strictEqual(res.total, '1');
    const params = store.userQueries[0].criteria.flatMap(c => c.params || []);
    assert.deepStrictEqual(params.filter(p => p.name.startsWith('@member')).map(p => p.value), [USER_A]);
  });

  await t.test('the members read of a missing group is 404 and reads no users', async (t) => {
    const store = fakeStore(t, null);
    const res = await ROUTES.members(['staff']);
    assert.strictEqual(res.status, 404);
    assert.strictEqual(store.userQueries.length, 0);
  });

  await t.test('a write that keeps losing its etag race is a 503', async (t) => {
    fakeStore(t);
    t.mock.method(groups, 'upsert', async () => { throw Object.assign(new Error('precondition'), { code: 412 }); });
    const res = await ROUTES.addMembers(['staff']);
    assert.strictEqual(res.status, 503);
  });

  for (const roles of [['demi-service-write'], ['demi-admin'], ['public']]) {
    for (const name of Object.keys(ROUTES)) {
      await t.test(`${roles.join('+')} is refused on ${name}`, async (t) => {
        const store = fakeStore(t);
        const res = await ROUTES[name](roles);
        assert.strictEqual(res.status, 403);
        assert.strictEqual(store.written.length + store.deleted.length + store.userQueries.length, 0);
      });
    }
  }
});
