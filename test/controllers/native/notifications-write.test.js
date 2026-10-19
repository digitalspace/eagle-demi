'use strict';

// The notification write routes end to end through the dispatcher: route guards, the write
// handler and the domain, over a fake repository.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

const config = require('../../../src/config');
const notifications = require('../../../src/repositories/notifications');
const { withServer } = require('../../helpers/with-server');

const NOTIFICATION_ID = '5c1f7a3e9b1d2c0012390001';
const STORED = Object.freeze({
  id: NOTIFICATION_ID, eagleId: NOTIFICATION_ID, sourceSystem: 'eagle', name: 'Mine expansion',
  region: 'Kootenay', pcp: 'none', read: ['staff', 'sysadmin'], isPublished: false, _etag: 'e1'
});

/** Fake storage holding `stored`; returns the rows written. */
function fakeStore(t, stored = STORED) {
  const store = { written: [] };
  t.mock.method(notifications, 'getById', async (access, id) => stored && id === stored.id ? { ...stored } : null);
  t.mock.method(notifications, 'upsert', async (row) => { store.written.push(row); return { ...row, _etag: 'e2' }; });
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
    result = { status: res.status, body: await res.json() };
  });
  return result;
}

const ROUTES = {
  create: (roles, body = { name: 'Quarry' }) => send('POST', '/notifications', roles, body),
  update: (roles, body = { name: 'Mine' }, id = NOTIFICATION_ID) => send('PUT', `/notifications/${id}`, roles, body),
  publish: (roles) => send('PUT', `/notifications/${NOTIFICATION_ID}/publish`, roles),
  unpublish: (roles) => send('PUT', `/notifications/${NOTIFICATION_ID}/unpublish`, roles)
};

test('notification write routes', async (t) => {
  t.beforeEach((t) => {
    const keycloakEnabled = config.keycloakEnabled;
    config.keycloakEnabled = false;
    t.after(() => { config.keycloakEnabled = keycloakEnabled; });
  });
  t.afterEach(() => t.mock.restoreAll());

  await t.test('staff creates a notification: 201, unpublished, read withheld', async (t) => {
    const store = fakeStore(t, null);
    const res = await ROUTES.create(['staff']);
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.id, store.written[0].id);
    assert.strictEqual(res.body.name, 'Quarry');
    assert.strictEqual(res.body.sourceSystem, 'demi');
    assert.strictEqual(res.body.isPublished, false);
    assert.strictEqual(res.body.read, undefined, 'read[] never leaves the service');
  });

  await t.test('a create with an unknown key is a 400 naming it and stores nothing', async (t) => {
    const store = fakeStore(t, null);
    const res = await ROUTES.create(['staff'], { name: 'Quarry', owner: 'x' });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.fields.owner);
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('sysadmin replaces a notification: 200, fields left out are blanked', async (t) => {
    const store = fakeStore(t);
    const res = await ROUTES.update(['sysadmin']);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.name, 'Mine');
    assert.strictEqual(store.written[0].region, null);
  });

  await t.test('an update of a missing notification is 404', async (t) => {
    fakeStore(t);
    const res = await ROUTES.update(['staff'], { name: 'x' }, '5c1f7a3e9b1d2c0012399999');
    assert.strictEqual(res.status, 404);
  });

  await t.test('publish then unpublish move public in and out of the read', async (t) => {
    const store = fakeStore(t);
    const published = await ROUTES.publish(['staff']);
    assert.strictEqual(published.status, 200);
    assert.strictEqual(published.body.isPublished, true);
    assert.ok(store.written[0].read.includes('public'));

    const unpublished = await ROUTES.unpublish(['staff']);
    assert.strictEqual(unpublished.status, 200);
    assert.ok(!store.written[1].read.includes('public'));
  });

  await t.test('a write that keeps losing its etag race is a 503', async (t) => {
    fakeStore(t);
    t.mock.method(notifications, 'upsert', async () => { throw Object.assign(new Error('precondition'), { code: 412 }); });
    const res = await ROUTES.publish(['staff']);
    assert.strictEqual(res.status, 503);
  });

  for (const roles of [['project-system-admin'], ['demi-service-write'], ['demi-admin'], ['public']]) {
    for (const name of Object.keys(ROUTES)) {
      await t.test(`${roles.join('+')} is refused on ${name}`, async (t) => {
        const store = fakeStore(t);
        const res = await ROUTES[name](roles);
        assert.strictEqual(res.status, 403);
        assert.strictEqual(store.written.length, 0);
      });
    }
  }
});
