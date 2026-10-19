'use strict';

// The user write routes end to end through the dispatcher: route guards, the write handler and
// the domain, over a fake repository.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

const config = require('../../../src/config');
const users = require('../../../src/repositories/users');
const { withServer } = require('../../helpers/with-server');

const USER_ID = '5c1f7a3e9b1d2c0012380001';
const STORED = Object.freeze({
  id: USER_ID, eagleId: USER_ID, sourceSystem: 'eagle', firstName: 'Ada', lastName: 'Lee',
  email: 'ada@example.ca', orgName: 'Teck', read: ['staff', 'sysadmin'], isPublished: false, _etag: 'e1'
});

/** Fake storage holding `stored`; returns the rows written. */
function fakeStore(t, stored = STORED) {
  const written = [];
  t.mock.method(users, 'getById', async (access, id) => stored && id === stored.id ? { ...stored } : null);
  t.mock.method(users, 'upsert', async (row) => { written.push(row); return { ...row, _etag: 'e2' }; });
  return written;
}

async function send(method, path, roles, body) {
  const token = jwt.sign({ sub: 'kc-1', preferred_username: 'idir-user', realm_access: { roles } }, 'suite-only');
  let result;
  await withServer(async (call) => {
    const res = await call(`/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    });
    result = { status: res.status, body: await res.json() };
  });
  return result;
}

const ROUTES = {
  create: (roles, body = { firstName: 'Bo', email: 'bo@example.ca' }) => send('POST', '/users', roles, body),
  update: (roles, body = { firstName: 'Ada', email: 'ada@example.ca' }, id = USER_ID) =>
    send('PUT', `/users/${id}`, roles, body)
};

test('user write routes', async (t) => {
  t.beforeEach((t) => {
    const keycloakEnabled = config.keycloakEnabled;
    config.keycloakEnabled = false;
    t.after(() => { config.keycloakEnabled = keycloakEnabled; });
  });
  t.afterEach(() => t.mock.restoreAll());

  await t.test('staff creates a user: 201, unpublished, contact fields kept for staff, read withheld', async (t) => {
    const written = fakeStore(t, null);
    const res = await ROUTES.create(['staff']);
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.id, written[0].id);
    assert.strictEqual(res.body.firstName, 'Bo');
    assert.strictEqual(res.body.email, 'bo@example.ca');
    assert.strictEqual(res.body.sourceSystem, 'demi');
    assert.strictEqual(res.body.isPublished, false);
    assert.strictEqual(res.body.read, undefined, 'read[] never leaves the service');
  });

  await t.test('a create with a password is a 400 naming it and stores nothing', async (t) => {
    const written = fakeStore(t, null);
    const res = await ROUTES.create(['staff'], { firstName: 'Bo', password: 'x' });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.fields.password);
    assert.strictEqual(written.length, 0);
  });

  await t.test('project-system-admin with a session role replaces a user: 200, fields left out are blanked', async (t) => {
    // demi-admin passes authMiddleware but not requireRole on its own; project-system-admin admits it.
    const written = fakeStore(t);
    const res = await ROUTES.update(['project-system-admin', 'demi-admin']);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.firstName, 'Ada');
    assert.strictEqual(written[0].lastName, '');
    assert.strictEqual(written[0].orgName, '');
  });

  await t.test('an update of a missing user is 404', async (t) => {
    fakeStore(t);
    const res = await ROUTES.update(['sysadmin'], { firstName: 'x' }, '5c1f7a3e9b1d2c0012389999');
    assert.strictEqual(res.status, 404);
  });

  await t.test('a write that keeps losing its etag race is a 503', async (t) => {
    fakeStore(t);
    t.mock.method(users, 'upsert', async () => { throw Object.assign(new Error('precondition'), { code: 412 }); });
    const res = await ROUTES.update(['staff']);
    assert.strictEqual(res.status, 503);
  });

  for (const roles of [['project-system-admin'], ['demi-service-write'], ['demi-admin'], ['public']]) {
    for (const name of Object.keys(ROUTES)) {
      await t.test(`${roles.join('+')} is refused on ${name}`, async (t) => {
        const written = fakeStore(t);
        const res = await ROUTES[name](roles);
        assert.strictEqual(res.status, 403);
        assert.strictEqual(written.length, 0);
      });
    }
  }
});
