'use strict';

// The CAC routes end to end through the dispatcher: route guards, the handlers and the domain,
// over a fake project repository and fake eagle-notify calls.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

const config = require('../../../src/config');
const projects = require('../../../src/repositories/projects');
const notify = require('../../../src/services/notify');
const { withServer } = require('../../helpers/with-server');

const EAGLE_ID = '5c1f7a3e9b1d2c0012340001';
const PROJECT_ID = `eagle-${EAGLE_ID}`;
const STORED = Object.freeze({
  id: PROJECT_ID, eagleId: EAGLE_ID, read: ['staff', 'sysadmin'], isPublished: false, name: 'Mine',
  projectCAC: true, projectCACPublished: false, cacEmail: 'cac@example.com', _etag: 'e1'
});

/** Fake storage holding one project; returns the rows written. */
function fakeStore(t) {
  const store = { written: [] };
  t.mock.method(projects, 'getById', async (access, id) => (id === STORED.id ? structuredClone(STORED) : null));
  t.mock.method(projects, 'upsert', async (row) => { store.written.push(row); return { ...row, _etag: 'e2' }; });
  return store;
}

function fakeNotify(t, fn) {
  t.mock.method(notify, 'unsubscribeCac', fn);
  t.mock.method(notify, 'unsubscribeCacMember', fn);
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

const BASE = `/projects/${PROJECT_ID}/cac`;
const ROUTES = {
  get: (roles) => send('GET', BASE, roles),
  create: (roles, body = { cacEmail: 'cac@example.com' }) => send('POST', BASE, roles, body),
  remove: (roles) => send('DELETE', BASE, roles),
  publish: (roles) => send('PUT', `${BASE}/publish`, roles),
  unpublish: (roles) => send('PUT', `${BASE}/unpublish`, roles),
  removeMember: (roles, body = { address: 'm@example.com' }) => send('POST', `${BASE}/members/remove`, roles, body)
};

test('CAC routes', async (t) => {
  t.beforeEach((t) => {
    const keycloakEnabled = config.keycloakEnabled;
    config.keycloakEnabled = false;
    t.after(() => { config.keycloakEnabled = keycloakEnabled; });
  });
  t.afterEach(() => t.mock.restoreAll());

  await t.test('staff reads the CAC fields, uncached, nothing else of the project', async (t) => {
    fakeStore(t);
    const res = await ROUTES.get(['staff']);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.cache, 'private, no-store');
    assert.strictEqual(res.body.cacEmail, 'cac@example.com');
    assert.strictEqual(res.body.name, undefined);
    assert.strictEqual(res.body.read, undefined, 'read[] never leaves the service');
  });

  await t.test('GET and writes answer exactly the three CAC fields, for staff and sysadmin', async (t) => {
    fakeStore(t);
    const keys = ['cacEmail', 'projectCAC', 'projectCACPublished'];
    for (const roles of [['staff'], ['sysadmin']]) {
      assert.deepStrictEqual(Object.keys((await ROUTES.get(roles)).body).sort(), keys, roles[0]);
      assert.deepStrictEqual(Object.keys((await ROUTES.publish(roles)).body).sort(), keys, roles[0]);
    }
  });

  await t.test('sysadmin creates a CAC: 201', async (t) => {
    fakeStore(t);
    const res = await ROUTES.create(['sysadmin']);
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.projectCAC, true);
  });

  await t.test('staff publishes and unpublishes: 200', async (t) => {
    fakeStore(t);
    assert.strictEqual((await ROUTES.publish(['staff'])).body.projectCACPublished, true);
    assert.strictEqual((await ROUTES.unpublish(['staff'])).body.projectCACPublished, false);
  });

  await t.test('staff deletes the CAC: 200 after eagle-notify ends the subscriptions', async (t) => {
    const store = fakeStore(t);
    fakeNotify(t, async () => ({ status: 'unsubscribed', count: 2 }));
    const res = await ROUTES.remove(['staff']);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(store.written[0].projectCAC, false);
  });

  await t.test('staff removes a member: 200, no row written', async (t) => {
    const store = fakeStore(t);
    fakeNotify(t, async () => ({ status: 'unsubscribed', alreadyUnsubscribed: false }));
    const res = await ROUTES.removeMember(['staff']);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('eagle-notify failing is 502 and the row is unchanged', async (t) => {
    const store = fakeStore(t);
    fakeNotify(t, async () => { throw new notify.NotifyError('eagle-notify answered 500', { status: 500 }); });
    const results = [await ROUTES.remove(['staff']), await ROUTES.removeMember(['staff'])];
    assert.deepStrictEqual(results.map(res => res.status), [502, 502]);
    assert.match(results[0].body.error, /Nothing was changed/);
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('notify not configured is 503 on delete and member removal', async (t) => {
    const store = fakeStore(t);
    fakeNotify(t, async () => { throw new notify.NotifyError('notify not configured', { configured: false }); });
    const results = [await ROUTES.remove(['staff']), await ROUTES.removeMember(['staff'])];
    assert.deepStrictEqual(results.map(res => res.status), [503, 503]);
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('a bad address is 400 naming the field', async (t) => {
    fakeStore(t);
    const res = await ROUTES.removeMember(['staff'], { address: 'nope' });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.fields.address);
  });

  await t.test('a caller without staff or sysadmin is refused on every route', async (t) => {
    const store = fakeStore(t);
    let called = 0;
    fakeNotify(t, async () => { called++; return { count: 0 }; });
    const results = [
      await ROUTES.get(['project-system-admin']),
      await ROUTES.create(['project-system-admin']),
      await ROUTES.remove(['public']),
      await ROUTES.publish(['idir']),
      await ROUTES.unpublish(['project-system-admin']),
      await ROUTES.removeMember(['public'])
    ];
    assert.deepStrictEqual(results.map(res => res.status), [403, 403, 403, 403, 403, 403]);
    assert.strictEqual(store.written.length, 0);
    assert.strictEqual(called, 0);
  });
});
