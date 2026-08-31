'use strict';

/**
 * The caller-chosen id on `POST /api/admin/api-keys` — the only way an APIM subscription's
 * identity row comes into existence, and the one place a caller influences a registry id at all.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const apiKeys = require('../../../src/repositories/api-keys');
const controller = require('../../../src/controllers/nosql/api-key');

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };
}

const ADMIN = { preferred_username: 'admin.person' };

function create(body, res = mockRes()) {
  return controller.createApiKey({ body, user: ADMIN }, res).then(() => res);
}

test('APIM identity rows', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('an apim: id is accepted and the row carries no key material', async (t) => {
    let stored;
    t.mock.method(apiKeys, 'getById', async () => null);
    t.mock.method(apiKeys, 'upsert', async (record) => { stored = record; return record; });

    const res = await create({
      id: 'apim:eagle-api', name: 'eagle-api', roles: ['demi-service-write'], allowWrite: true
    });

    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(stored.id, 'apim:eagle-api');
    assert.deepStrictEqual(stored.roles, ['demi-service-write']);
    // No secret exists for this row, so `verify` fails closed and the X-Api-Key path can never
    // authenticate it — the gateway is the only way in.
    assert.strictEqual(stored.hash, null);
    assert.strictEqual(res.body.key, undefined, 'nothing to hand back: there is no key');
    // APIM owns the subscription's lifecycle; a 90-day default would kill the consumer silently.
    assert.strictEqual(stored.expiresAt, null);
  });

  await t.test('an ordinary mint still gets a random id and its plaintext once', async (t) => {
    let stored;
    t.mock.method(apiKeys, 'getById', async () => null);
    t.mock.method(apiKeys, 'upsert', async (record) => { stored = record; return record; });

    const res = await create({ name: 'importer', roles: ['demi-service-read'] });

    assert.strictEqual(res.statusCode, 201);
    assert.match(stored.id, /^[0-9a-f]{16}$/);
    assert.match(res.body.key, /^demi_/);
    assert.strictEqual(typeof stored.hash, 'string');
    assert.ok(stored.expiresAt, 'a real key still expires');
  });

  await t.test('any other id is refused, so no caller can squat or overwrite one', async (t) => {
    const upserted = [];
    t.mock.method(apiKeys, 'getById', async () => null);
    t.mock.method(apiKeys, 'upsert', async (record) => { upserted.push(record); return record; });

    const rejected = ['deadbeefdeadbeef', 'apim:Eagle_API', 'apim:', 'admin', '../apim:x', 42,
      { id: 1 }, ['apim:eagle-api']];
    for (const id of rejected) {
      const res = await create({ id, name: 'x', roles: ['demi-service-read'] });
      assert.strictEqual(res.statusCode, 400, `id ${JSON.stringify(id)} must be refused`);
      assert.match(res.body.error, /apim:<subscription-name>/);
    }

    assert.deepStrictEqual(upserted, [], 'a refused id writes nothing');
  });

  await t.test('a duplicate id is a 409, never a silent overwrite', async (t) => {
    // There is no update endpoint by design; upserting over a live row would be the one way to
    // widen its roles after issuance.
    const upserted = [];
    t.mock.method(apiKeys, 'getById', async (id) => ({ id, name: 'eagle-api', roles: ['demi-service-read'] }));
    t.mock.method(apiKeys, 'upsert', async (record) => { upserted.push(record); return record; });

    const res = await create({
      id: 'apim:eagle-api', name: 'eagle-api', roles: ['demi-admin'], allowWrite: true
    });

    assert.strictEqual(res.statusCode, 409);
    assert.deepStrictEqual(upserted, []);
  });

  await t.test('an apim row is still held to the role rules', async (t) => {
    t.mock.method(apiKeys, 'getById', async () => null);
    t.mock.method(apiKeys, 'upsert', async (record) => record);

    const unknown = await create({ id: 'apim:extractor', name: 'extractor', roles: ['wizard'] });
    assert.strictEqual(unknown.statusCode, 400);

    const unconfirmed = await create({
      id: 'apim:extractor', name: 'extractor', roles: ['demi-service-write']
    });
    assert.strictEqual(unconfirmed.statusCode, 400, 'allowWrite is still required');
  });
});
