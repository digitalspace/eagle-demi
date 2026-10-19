'use strict';

// The update writes end to end through the dispatcher: route guards, the write handler and the
// domain, over fake repositories.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

const config = require('../../../src/config');
const updates = require('../../../src/repositories/updates');
const documents = require('../../../src/repositories/documents');
const updateParent = require('../../../src/helpers/update-parent');
const { withServer } = require('../../helpers/with-server');

const PROJECT_ID = '5c1f7a3e9b1d2c0012340001';
const UPDATE_ID = '5c1f7a3e9b1d2c0012350001';
const STORED = Object.freeze({
  id: UPDATE_ID, eagleId: UPDATE_ID, projectId: PROJECT_ID, headline: 'Site work begins', status: 'draft',
  active: false, pinned: false, publishDate: '2024-01-01T00:00:00.000Z', dateAdded: '2024-01-01T00:00:00.000Z',
  attachments: [], read: ['staff', 'sysadmin'], isPublished: false, _etag: 'e1'
});

/** Fake storage holding STORED under a public project; returns the rows written. */
function fakeStore(t) {
  const store = { written: [] };
  t.mock.method(updates, 'getById', async (access, id) => id === STORED.id ? { ...STORED } : null);
  t.mock.method(updates, 'upsert', async (row) => { store.written.push(row); return { ...row, _etag: 'e2' }; });
  t.mock.method(updateParent, 'readParent', async (eagleId) =>
    eagleId === PROJECT_ID ? { id: 'p-1', kind: 'project', read: ['public', 'staff', 'sysadmin'] } : null);
  t.mock.method(documents, 'listByIdsUnscoped', async () => []);
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
  create: (roles, body = { projectId: PROJECT_ID, headline: 'Open house' }) => send('POST', '/updates', roles, body),
  update: (roles, body = { headline: 'Open house moved' }, id = UPDATE_ID) => send('PUT', `/updates/${id}`, roles, body),
  archive: (roles, id = UPDATE_ID) => send('DELETE', `/updates/${id}`, roles)
};

test('update writes', async (t) => {
  t.beforeEach((t) => {
    const keycloakEnabled = config.keycloakEnabled;
    config.keycloakEnabled = false;
    t.after(() => { config.keycloakEnabled = keycloakEnabled; });
  });
  t.afterEach(() => t.mock.restoreAll());

  await t.test('staff creates an update: 201 DEMI draft, read withheld', async (t) => {
    const store = fakeStore(t);
    const res = await ROUTES.create(['staff']);
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.id, store.written[0].id);
    assert.strictEqual(res.body.status, 'draft');
    assert.strictEqual(res.body.sourceSystem, 'demi');
    assert.strictEqual(res.body.read, undefined, 'read[] never leaves the service');
  });

  await t.test('a create with an unknown field is a 400 naming it', async (t) => {
    const store = fakeStore(t);
    const res = await ROUTES.create(['staff'], { projectId: PROJECT_ID, write: ['public'] });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.fields.write);
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('sysadmin updates: 200 with the new headline', async (t) => {
    const store = fakeStore(t);
    const res = await ROUTES.update(['sysadmin']);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.headline, 'Open house moved');
    assert.strictEqual(store.written[0].headline, 'Open house moved');
  });

  await t.test('an update carrying a stale _etag is a 409', async (t) => {
    const store = fakeStore(t);
    const res = await ROUTES.update(['staff'], { headline: 'x', _etag: 'e0' });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('an update of a missing row is 404', async (t) => {
    fakeStore(t);
    const res = await ROUTES.update(['staff'], { headline: 'x' }, '5c1f7a3e9b1d2c0012359999');
    assert.strictEqual(res.status, 404);
  });

  await t.test('staff deletes: 200 and the row is archived, not removed', async (t) => {
    const store = fakeStore(t);
    const res = await ROUTES.archive(['staff']);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'archived');
    assert.strictEqual(store.written[0].id, UPDATE_ID);
  });

  await t.test('a delete of a missing row is 404', async (t) => {
    fakeStore(t);
    const res = await ROUTES.archive(['staff'], '5c1f7a3e9b1d2c0012359999');
    assert.strictEqual(res.status, 404);
  });

  for (const roles of [['demi-service-write'], ['demi-admin'], ['idir']]) {
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
