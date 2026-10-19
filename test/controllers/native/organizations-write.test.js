'use strict';

// POST /organizations, PUT /organizations/:id and its publish and unpublish end to end through the dispatcher: the route
// guards, the write handler and the domain, over a fake `lists` repository.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

const config = require('../../../src/config');
const lists = require('../../../src/repositories/lists');
const { withServer } = require('../../helpers/with-server');

const ORG_ID = '5c1f7a3e9b1d2c0012340001';
const STORED = Object.freeze({
  id: ORG_ID, eagleId: ORG_ID, kind: 'Organization', sourceSystem: 'eagle',
  name: 'Acme Mining', description: 'staff note', read: ['public', 'staff', 'sysadmin'], isPublished: true, _etag: 'e1'
});

/** Fake `lists` storage holding `stored`; returns the rows written. */
function fakeLists(t, stored = STORED) {
  const written = [];
  t.mock.method(lists, 'getById', async (access, id) => stored && id === stored.id ? { ...stored } : null);
  t.mock.method(lists, 'upsert', async (row) => { written.push(row); return { ...row, _etag: 'e2' }; });
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

const create = (roles, body = { name: 'New Co' }) => send('POST', '/organizations', roles, body);
const update = (roles, body = { city: 'Nelson' }, id = ORG_ID) => send('PUT', `/organizations/${id}`, roles, body);
const publish = (roles) => send('PUT', `/organizations/${ORG_ID}/publish`, roles, {});
const unpublish = (roles) => send('PUT', `/organizations/${ORG_ID}/unpublish`, roles, {});

test('organization writes', async (t) => {
  t.beforeEach((t) => {
    const keycloakEnabled = config.keycloakEnabled;
    config.keycloakEnabled = false;
    t.after(() => { config.keycloakEnabled = keycloakEnabled; });
  });
  t.afterEach(() => t.mock.restoreAll());

  await t.test('staff creates an organization: 201 with the stored row', async (t) => {
    const written = fakeLists(t, null);

    const res = await create(['staff']);

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.name, 'New Co');
    assert.strictEqual(res.body.sourceSystem, 'demi');
    assert.strictEqual(res.body.id, written[0].id);
    assert.strictEqual(res.body.read, undefined, 'read[] never leaves the service');
  });

  await t.test('an unknown key on create is a 400 naming it', async (t) => {
    const written = fakeLists(t, null);
    const res = await create(['staff'], { name: 'X', website: 'https://x.example' });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.fields.website);
    assert.strictEqual(written.length, 0);
  });

  for (const roles of [['demi-service-write'], ['demi-admin']]) {
    await t.test(`${roles[0]} is refused on create`, async (t) => {
      const written = fakeLists(t, null);
      const res = await create(roles);
      assert.strictEqual(res.status, 403);
      assert.strictEqual(written.length, 0);
    });

    await t.test(`${roles[0]} is refused on update`, async (t) => {
      const written = fakeLists(t);
      const res = await update(roles);
      assert.strictEqual(res.status, 403);
      assert.strictEqual(written.length, 0);
    });
  }

  await t.test('project-system-admin is refused on create, whose scopes do not name it', async (t) => {
    const written = fakeLists(t, null);
    const res = await create(['project-system-admin', 'demi-admin']);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(written.length, 0);
  });

  await t.test('a token with project-system-admin and sysadmin updates: 200', async (t) => {
    const written = fakeLists(t);
    const res = await update(['project-system-admin', 'sysadmin']);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.city, 'Nelson');
    assert.strictEqual(written[0].city, 'Nelson');
  });

  await t.test('project-system-admin with a session role that is not staff still updates', async (t) => {
    // demi-admin passes authMiddleware but not requireRole on its own; project-system-admin admits it.
    const written = fakeLists(t);
    const res = await update(['project-system-admin', 'demi-admin']);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(written.length, 1);
  });

  await t.test('a token holding only project-system-admin is refused by authMiddleware', async (t) => {
    const written = fakeLists(t);
    const res = await update(['project-system-admin']);
    assert.strictEqual(res.status, 403);
    assert.match(res.body.error, /admin or staff/);
    assert.strictEqual(written.length, 0);
  });

  await t.test('staff updates: 200', async (t) => {
    fakeLists(t);
    const res = await update(['staff']);
    assert.strictEqual(res.status, 200);
  });

  await t.test('an update of a missing organization is 404', async (t) => {
    fakeLists(t);
    const res = await update(['staff'], { city: 'Nelson' }, '5c1f7a3e9b1d2c0012349999');
    assert.strictEqual(res.status, 404);
  });

  await t.test('an update ignores read and isPublished: 200 with the visibility unchanged', async (t) => {
    const written = fakeLists(t);
    const res = await update(['sysadmin'], { city: 'Nelson', read: ['sysadmin'], isPublished: false });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.isPublished, true);
    assert.deepStrictEqual(written[0].read, STORED.read);
  });

  await t.test('create with isPublished true: 201 and published', async (t) => {
    const written = fakeLists(t, null);
    const res = await create(['staff'], { name: 'Open Co', isPublished: true });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.isPublished, true);
    assert.ok(written[0].read.includes('public'));
  });

  await t.test('staff publishes: 200 and isPublished true', async (t) => {
    const written = fakeLists(t, { ...STORED, read: ['staff', 'sysadmin'], isPublished: false });
    const res = await publish(['staff']);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.isPublished, true);
    assert.ok(written[0].read.includes('public'));
  });

  await t.test('sysadmin unpublishes: 200 and isPublished false', async (t) => {
    const written = fakeLists(t);
    const res = await unpublish(['sysadmin']);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.isPublished, false);
    assert.ok(!written[0].read.includes('public'));
  });

  await t.test('publish of a missing organization is 404', async (t) => {
    const written = fakeLists(t, null);
    const res = await publish(['staff']);
    assert.strictEqual(res.status, 404);
    assert.strictEqual(written.length, 0);
  });

  await t.test('project-system-admin with a session role that is not staff publishes: 200', async (t) => {
    const written = fakeLists(t, { ...STORED, read: ['staff', 'sysadmin'], isPublished: false });
    const res = await publish(['project-system-admin', 'demi-admin']);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(written.length, 1);
  });

  for (const roles of [['demi-service-write'], ['demi-admin'], ['project-system-admin']]) {
    for (const [name, call] of [['publish', publish], ['unpublish', unpublish]]) {
      await t.test(`${roles.join('+')} is refused on ${name}`, async (t) => {
        const written = fakeLists(t);
        const res = await call(roles);
        assert.strictEqual(res.status, 403);
        assert.strictEqual(written.length, 0);
      });
    }
  }
});
