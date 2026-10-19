'use strict';

// The comment period writes end to end through the dispatcher: route guards, the write handler
// and the domain, over fake repositories.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

const config = require('../../../src/config');
const commentPeriods = require('../../../src/repositories/comment-periods');
const comments = require('../../../src/repositories/comments');
const projects = require('../../../src/repositories/projects');
const { withServer } = require('../../helpers/with-server');

const PROJECT_ID = 'p-public';
const PERIOD_ID = '5c1f7a3e9b1d2c0012340001';
const STORED = Object.freeze({
  id: PERIOD_ID, eagleId: PERIOD_ID, projectId: PROJECT_ID, sourceSystem: 'eagle', instructions: 'old',
  commentIdCount: 4, read: ['staff', 'sysadmin'], isPublished: false, _etag: 'e1'
});

/** Fake storage holding `stored` under a public project; returns the rows written and deleted. */
function fakeStore(t, stored = STORED) {
  const store = { written: [], deleted: [] };
  t.mock.method(commentPeriods, 'getById', async (access, id) => stored && id === stored.id ? { ...stored } : null);
  t.mock.method(commentPeriods, 'upsert', async (row) => { store.written.push(row); return { ...row, _etag: 'e2' }; });
  t.mock.method(commentPeriods, 'deleteById', async (id) => { store.deleted.push(id); return true; });
  t.mock.method(projects, 'getById', async (access, id) =>
    id === PROJECT_ID ? { id, read: ['public', 'staff', 'sysadmin'] } : null);
  t.mock.method(comments, 'setAclForPeriod', async () => ({ succeeded: 0, failed: 0 }));
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
  create: (roles, body = { projectId: PROJECT_ID, instructions: 'Tell us' }) => send('POST', '/comment-periods', roles, body),
  update: (roles, body = { instructions: 'new' }, id = PERIOD_ID) => send('PUT', `/comment-periods/${id}`, roles, body),
  delete: (roles) => send('DELETE', `/comment-periods/${PERIOD_ID}`, roles),
  publish: (roles) => send('PUT', `/comment-periods/${PERIOD_ID}/publish`, roles, {}),
  unpublish: (roles) => send('PUT', `/comment-periods/${PERIOD_ID}/unpublish`, roles, {})
};

test('comment period writes', async (t) => {
  t.beforeEach((t) => {
    const keycloakEnabled = config.keycloakEnabled;
    config.keycloakEnabled = false;
    t.after(() => { config.keycloakEnabled = keycloakEnabled; });
  });
  t.afterEach(() => t.mock.restoreAll());

  await t.test('staff creates a period: 201 with the stored row, read withheld', async (t) => {
    const store = fakeStore(t);
    const res = await ROUTES.create(['staff']);
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.id, store.written[0].id);
    assert.strictEqual(res.body.sourceSystem, 'demi');
    assert.strictEqual(res.body.commentIdCount, 0);
    assert.strictEqual(res.body.read, undefined, 'read[] never leaves the service');
  });

  await t.test('an unknown key on create is a 400 naming it', async (t) => {
    const store = fakeStore(t);
    const res = await ROUTES.create(['staff'], { projectId: PROJECT_ID, write: ['public'] });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.fields.write);
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('sysadmin updates: 200 with the new field', async (t) => {
    const store = fakeStore(t);
    const res = await ROUTES.update(['sysadmin']);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.instructions, 'new');
    assert.strictEqual(store.written[0].instructions, 'new');
  });

  await t.test('an update of a missing period is 404', async (t) => {
    fakeStore(t);
    const res = await ROUTES.update(['staff'], { instructions: 'new' }, '5c1f7a3e9b1d2c0012349999');
    assert.strictEqual(res.status, 404);
  });

  await t.test('staff deletes: 200 and the row is removed', async (t) => {
    const store = fakeStore(t);
    const res = await ROUTES.delete(['staff']);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(store.deleted, [PERIOD_ID]);
  });

  await t.test('staff publishes: 200 and isPublished true', async (t) => {
    const store = fakeStore(t);
    const res = await ROUTES.publish(['staff']);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.isPublished, true);
    assert.ok(store.written[0].read.includes('public'));
  });

  await t.test('staff unpublishes: 200 and isPublished false', async (t) => {
    fakeStore(t, { ...STORED, read: ['public', 'staff', 'sysadmin'], isPublished: true });
    const res = await ROUTES.unpublish(['staff']);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.isPublished, false);
  });

  await t.test('publish under a private project is a 409', async (t) => {
    const store = fakeStore(t, { ...STORED, projectId: 'p-private' });
    t.mock.method(projects, 'getById', async (access, id) => ({ id, read: ['staff', 'sysadmin'] }));
    const res = await ROUTES.publish(['staff']);
    assert.strictEqual(res.status, 409);
    assert.match(res.body.error, /above the level of its project/);
    assert.strictEqual(store.written.length, 0);
  });

  for (const name of ['update', 'delete', 'publish', 'unpublish']) {
    await t.test(`${name} of an ENGAGE period is a 409 and writes nothing`, async (t) => {
      const store = fakeStore(t, { ...STORED, sourceSystem: 'engage' });
      const res = await ROUTES[name](['staff']);
      assert.strictEqual(res.status, 409);
      assert.match(res.body.error, /ENGAGE/);
      assert.strictEqual(store.written.length + store.deleted.length, 0);
    });
  }

  for (const roles of [['demi-service-write'], ['demi-admin'], ['project-system-admin', 'demi-admin']]) {
    for (const name of Object.keys(ROUTES)) {
      await t.test(`${roles.join('+')} is refused on ${name}`, async (t) => {
        const store = fakeStore(t);
        const res = await ROUTES[name](roles);
        assert.strictEqual(res.status, 403);
        assert.strictEqual(store.written.length + store.deleted.length, 0);
      });
    }
  }
});
