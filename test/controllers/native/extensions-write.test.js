'use strict';

// The extension routes end to end through the dispatcher: route guards, the handlers and the
// domain, over a fake project repository.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

const config = require('../../../src/config');
const projects = require('../../../src/repositories/projects');
const { idOf } = require('../../../src/domain/extensions');
const { withServer } = require('../../helpers/with-server');

const PROJECT_ID = 'eagle-5c1f7a3e9b1d2c0012340001';
const EXTENSION = Object.freeze({ type: 'Extension', appliedTo: 'Application review', start: '2020-01-01T08:00:00.000Z' });
const STORED = Object.freeze({
  id: PROJECT_ID, read: ['staff', 'sysadmin'], isPublished: false, name: 'Mine',
  reviewExtensions: [EXTENSION], reviewSuspensions: [], _etag: 'e1'
});

/** Fake storage holding one project; returns the rows written. */
function fakeStore(t) {
  const store = { written: [] };
  t.mock.method(projects, 'getById', async (access, id) => (id === STORED.id ? structuredClone(STORED) : null));
  t.mock.method(projects, 'upsert', async (row) => { store.written.push(row); return { ...row, _etag: 'e2' }; });
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
    result = { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() };
  });
  return result;
}

const BASE = `/projects/${PROJECT_ID}/extensions`;
const ROUTES = {
  list: (roles, id = PROJECT_ID) => send('GET', `/projects/${id}/extensions`, roles),
  create: (roles, body = { type: 'Extension', appliedTo: 'More time' }) => send('POST', BASE, roles, body),
  update: (roles, extId, body = { type: 'Extension', appliedTo: 'Edited' }) => send('PUT', `${BASE}/${extId}`, roles, body),
  remove: (roles, extId) => send('DELETE', `${BASE}/${extId}`, roles)
};

test('extension routes', async (t) => {
  t.beforeEach((t) => {
    const keycloakEnabled = config.keycloakEnabled;
    config.keycloakEnabled = false;
    t.after(() => { config.keycloakEnabled = keycloakEnabled; });
  });
  t.afterEach(() => t.mock.restoreAll());

  await t.test('staff reads both lists, ids on items, nothing of the project beyond them', async (t) => {
    fakeStore(t);
    const res = await ROUTES.list(['staff']);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.cache, 'private, no-store');
    assert.strictEqual(res.body.reviewExtensions[0].id, idOf(EXTENSION));
    assert.deepStrictEqual(res.body.reviewSuspensions, []);
    assert.strictEqual(res.body.name, undefined);
    assert.strictEqual(res.body.read, undefined, 'read[] never leaves the service');
  });

  await t.test('a read of an unknown project is 404', async (t) => {
    fakeStore(t);
    const res = await ROUTES.list(['staff'], 'eagle-nope');
    assert.strictEqual(res.status, 404);
  });

  await t.test('sysadmin adds an extension: 201 with the new item in its list', async (t) => {
    const store = fakeStore(t);
    const res = await ROUTES.create(['sysadmin']);
    assert.strictEqual(res.status, 201);
    const added = store.written[0].reviewExtensions[1];
    assert.strictEqual(res.body.reviewExtensions[1].id, added.id);
    assert.strictEqual(res.body.reviewExtensions[1].appliedTo, 'More time');
  });

  await t.test('staff replaces an item: 200, same id', async (t) => {
    fakeStore(t);
    const res = await ROUTES.update(['staff'], idOf(EXTENSION));
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.reviewExtensions, [{ type: 'Extension', appliedTo: 'Edited', id: idOf(EXTENSION) }]);
  });

  await t.test('staff deletes an item: 200, gone from its list', async (t) => {
    const store = fakeStore(t);
    const res = await ROUTES.remove(['staff'], idOf(EXTENSION));
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(store.written[0].reviewExtensions, []);
  });

  await t.test('an unknown item is 404 naming the extension', async (t) => {
    fakeStore(t);
    const res = await ROUTES.remove(['staff'], 'nope');
    assert.strictEqual(res.status, 404);
    assert.match(res.body.error, /Extension/);
  });

  await t.test('an invalid body is 400 naming the field', async (t) => {
    const store = fakeStore(t);
    const res = await ROUTES.create(['staff'], { type: 'Extension', start: 'soon' });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.fields.start);
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('a caller without staff or sysadmin is refused on every route', async (t) => {
    const store = fakeStore(t);
    const results = await Promise.all([
      ROUTES.list(['project-system-admin']),
      ROUTES.create(['project-system-admin']),
      ROUTES.update(['public'], idOf(EXTENSION)),
      ROUTES.remove(['idir'], idOf(EXTENSION))
    ]);
    assert.deepStrictEqual(results.map(res => res.status), [403, 403, 403, 403]);
    assert.strictEqual(store.written.length, 0);
  });
});
