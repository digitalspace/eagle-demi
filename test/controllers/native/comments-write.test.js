'use strict';

// The comment writes end to end through the dispatcher: route guards, the write handler and the
// domain, over fake repositories.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

const config = require('../../../src/config');
const comments = require('../../../src/repositories/comments');
const commentPeriods = require('../../../src/repositories/comment-periods');
const { withServer } = require('../../helpers/with-server');

const PROJECT_ID = 'p-public';
const PERIOD_ID = '5c1f7a3e9b1d2c0012340001';
const COMMENT_ID = '5c1f7a3e9b1d2c0012350001';
const STORED = Object.freeze({
  id: COMMENT_ID, eagleId: COMMENT_ID, periodId: PERIOD_ID, projectId: PROJECT_ID, sourceSystem: 'eagle',
  comment: 'Keep the trail open', author: 'Pat', isAnonymous: true, eaoStatus: 'Pending', commentId: 7,
  read: ['staff', 'sysadmin'], isPublished: false, _etag: 'e1'
});

/** Fake storage holding `stored` under a public period; returns the rows written. */
function fakeStore(t, stored = STORED) {
  const store = { written: [] };
  t.mock.method(comments, 'getById', async (access, id) => stored && id === stored.id ? { ...stored } : null);
  t.mock.method(comments, 'upsert', async (row) => { store.written.push(row); return { ...row, _etag: 'e2' }; });
  t.mock.method(commentPeriods, 'getById', async (access, id) =>
    id === PERIOD_ID ? { id, projectId: PROJECT_ID, read: ['public', 'staff', 'sysadmin'] } : null);
  t.mock.method(commentPeriods, 'nextCommentId', async () => 8);
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
  create: (roles, body = { periodId: PERIOD_ID, comment: 'Protect the creek' }) => send('POST', '/comments', roles, body),
  update: (roles, body = { eaoNotes: 'checked' }, id = COMMENT_ID) => send('PUT', `/comments/${id}`, roles, body),
  status: (roles, body = { status: 'Published' }) => send('PUT', `/comments/${COMMENT_ID}/status`, roles, body)
};

test('comment writes', async (t) => {
  t.beforeEach((t) => {
    const keycloakEnabled = config.keycloakEnabled;
    config.keycloakEnabled = false;
    t.after(() => { config.keycloakEnabled = keycloakEnabled; });
  });
  t.afterEach(() => t.mock.restoreAll());

  await t.test('staff creates a comment: 201 numbered from the period, read withheld', async (t) => {
    const store = fakeStore(t);
    const res = await ROUTES.create(['staff']);
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.id, store.written[0].id);
    assert.strictEqual(res.body.commentId, 8);
    assert.strictEqual(res.body.sourceSystem, 'demi');
    assert.strictEqual(res.body.read, undefined, 'read[] never leaves the service');
  });

  await t.test('a malformed document id on create is a 400 naming documents', async (t) => {
    const store = fakeStore(t);
    const res = await ROUTES.create(['staff'], { periodId: PERIOD_ID, documents: ['nope'] });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.fields.documents);
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('a create under an unknown period is a 400 naming periodId', async (t) => {
    fakeStore(t);
    const res = await ROUTES.create(['staff'], { periodId: '5c1f7a3e9b1d2c0012349999' });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.fields.periodId);
  });

  await t.test('sysadmin updates: 200 with the new field', async (t) => {
    const store = fakeStore(t);
    const res = await ROUTES.update(['sysadmin']);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.eaoNotes, 'checked');
    assert.strictEqual(store.written[0].eaoNotes, 'checked');
  });

  await t.test('an update of a missing comment is 404', async (t) => {
    fakeStore(t);
    const res = await ROUTES.update(['staff'], { eaoNotes: 'x' }, '5c1f7a3e9b1d2c0012359999');
    assert.strictEqual(res.status, 404);
  });

  await t.test('staff publishes through the status route: 200 and isPublished true', async (t) => {
    const store = fakeStore(t);
    const res = await ROUTES.status(['staff']);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.eaoStatus, 'Published');
    assert.strictEqual(res.body.isPublished, true);
    assert.ok(store.written[0].read.includes('public'));
  });

  await t.test("eagle-api's nested status body is a 400", async (t) => {
    const store = fakeStore(t);
    const res = await ROUTES.status(['staff'], { status: { status: 'Published' } });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.fields.status);
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('a status write that keeps losing its etag race is a 503', async (t) => {
    fakeStore(t);
    t.mock.method(comments, 'upsert', async () => { throw Object.assign(new Error('precondition'), { code: 412 }); });
    const res = await ROUTES.status(['staff']);
    assert.strictEqual(res.status, 503);
  });

  for (const roles of [['demi-service-write'], ['demi-admin'], ['project-system-admin', 'demi-admin']]) {
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
