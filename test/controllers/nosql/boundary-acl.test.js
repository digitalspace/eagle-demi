'use strict';

// Boundaries: the ACL a written row carries, the keys an answer withholds, the keys an update takes.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

const config = require('../../../src/config');
const { withServer } = require('../../helpers/with-server');

const boundaries = require('../../../src/repositories/boundaries');
const boundaryController = require('../../../src/controllers/nosql/boundary');

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };
}

test('a written boundary carries the ladder tokens for its level', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  async function create(isPublished) {
    let saved;
    t.mock.method(boundaries, 'upsert', async (doc) => { saved = doc; return doc; });

    await boundaryController.createBoundary({
      body: { type: 'Municipality', name: 'Fort St. John', isPublished }
    }, mockRes());

    return saved;
  }

  await t.test('a new unpublished boundary still reads as level 2 after P3-2', async () => {
    const saved = await create(false);

    assert.deepStrictEqual(saved.read, ['staff'], 'the level the legacy ACL already meant');
    assert.strictEqual(saved.isPublished, false);
  });

  await t.test('a published boundary reads as level 4', async () => {
    // Reference geography defaults to published, which is what all 281 stored rows are.
    const saved = await create(undefined);

    assert.deepStrictEqual(saved.read, ['staff', 'idir', 'public']);
    assert.strictEqual(saved.isPublished, true);
  });
});

// What a Cosmos read hands back: the served fields, the ACL and every system field.
const STORED = Object.freeze({
  id: 'static_electoralDistricts_1', type: 'electoralDistricts', name: 'Skeena', code: 'SKE',
  isPublished: true, read: ['staff', 'idir', 'public'],
  _etag: 'e1', _rid: 'r1', _self: 'dbs/x/colls/y/docs/z', _attachments: 'attachments/', _ts: 1
});
const UNSERVED = ['read', '_etag', '_rid', '_self', '_attachments', '_ts'];

async function send(method, path, roles, body) {
  const headers = { 'content-type': 'application/json' };
  if (roles) {
    const token = jwt.sign({ sub: 'kc-1', preferred_username: 'idir-user', realm_access: { roles } }, 'suite-only');
    headers.authorization = `Bearer ${token}`;
  }
  let result;
  await withServer(async (call) => {
    const res = await call(`/api${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    result = { status: res.status, body: await res.json() };
  });
  return result;
}

function assertServed(row, label) {
  for (const key of UNSERVED) assert.ok(!Object.hasOwn(row, key), `${label}: ${key} served`);
  assert.strictEqual(row.name, 'Skeena', label);
}

test('boundary answers carry no ACL and no Cosmos system fields', async (t) => {
  t.beforeEach((t) => {
    const keycloakEnabled = config.keycloakEnabled;
    config.keycloakEnabled = false;
    t.after(() => { config.keycloakEnabled = keycloakEnabled; });
    t.mock.method(boundaries, 'listByType', async () => ({ items: [structuredClone(STORED)], pageSize: 1000 }));
    t.mock.method(boundaries, 'getById', async (access, id) => (id === STORED.id ? structuredClone(STORED) : null));
    t.mock.method(boundaries, 'upsert', async (row) => ({ ...STORED, ...row }));
  });
  t.afterEach(() => t.mock.restoreAll());

  for (const [who, roles] of [['anonymous', undefined], ['staff', ['staff']]]) {
    await t.test(`${who} lists and reads by id`, async () => {
      const list = await send('GET', '/boundaries?type=electoralDistricts', roles);
      assert.strictEqual(list.status, 200);
      assertServed(list.body[0], `${who} list`);

      const one = await send('GET', `/boundaries/${STORED.id}`, roles);
      assert.strictEqual(one.status, 200);
      assertServed(one.body, `${who} by id`);
    });
  }

  await t.test('create and update answer the saved row without them', async () => {
    const created = await send('POST', '/boundaries', ['staff'], { type: 'electoralDistricts', name: 'Skeena' });
    assert.strictEqual(created.status, 201);
    assertServed(created.body, 'create');

    const updated = await send('PUT', `/boundaries/${STORED.id}`, ['staff'], { code: 'SK' });
    assert.strictEqual(updated.status, 200);
    assertServed(updated.body, 'update');
  });

  await t.test('update refuses an unknown body key and stores nothing', async () => {
    const res = await send('PUT', `/boundaries/${STORED.id}`, ['staff'], { name: 'Skeena', zzExtra: 'x' });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /zzExtra/);
    assert.strictEqual(boundaries.upsert.mock.callCount(), 0);
  });

  await t.test('update still takes a fetched row sent back with id, type, read and updatedAt', async () => {
    const body = { id: STORED.id, type: STORED.type, read: STORED.read, updatedAt: '2020-01-01T00:00:00.000Z',
      name: 'Skeena', code: 'SK', isPublished: true };
    const res = await send('PUT', `/boundaries/${STORED.id}`, ['staff'], body);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(boundaries.upsert.mock.calls[0].arguments[0].code, 'SK');
  });
});
