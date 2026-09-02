'use strict';

/**
 * Who may mint a `compliance` key (docs/rbac-architecture.md §1, condition 3).
 *
 * The route's own gate is `requireAdmin`, which every `staff`, `sysadmin` and `demi-admin` caller
 * passes, and `compliance` is grantable — so without the caller check any of them mints itself into
 * the sealed compartment, and the level-0 exclusion in `access-sql.js` protects nothing.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const apiKeys = require('../../../src/repositories/api-keys');
const controller = require('../../../src/controllers/nosql/api-key');
const { GRANTABLE_ROLES } = require('../../../src/controllers/nosql/api-key');

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };
}

/** Mint as a caller holding `roles`, capturing whatever reaches the registry. */
async function mint(callerRoles, body, t) {
  const stored = [];
  t.mock.method(apiKeys, 'getById', async () => null);
  t.mock.method(apiKeys, 'upsert', async (record) => { stored.push(record); return record; });

  const res = mockRes();
  await controller.createApiKey({
    body,
    user: { preferred_username: 'admin.person', realm_access: { roles: callerRoles } }
  }, res);

  return { res, stored };
}

test('minting a compliance key', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('an admin without compliance cannot mint a compliance key', async (t) => {
    const { res, stored } = await mint(['sysadmin'], { name: 'ce', roles: ['compliance'] }, t);

    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body, { error: 'compliance is not grantable by this caller' });
    assert.deepStrictEqual(stored, [], 'a refused mint writes nothing');
  });

  await t.test('a compliance holder can mint a compliance key', async (t) => {
    const { res, stored } = await mint(
      ['sysadmin', 'compliance'], { name: 'ce', roles: ['compliance'] }, t);

    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(stored[0].roles, ['compliance']);
  });

  await t.test('the gate is on the caller, not on the list', () => {
    // Dropping `compliance` from GRANTABLE_ROLES would answer the same 400 for the wrong reason —
    // "unknown role" — and leave the compartment unable to issue its own keys at all.
    assert.ok(GRANTABLE_ROLES.includes('compliance'));
  });

  await t.test('a key that grants nothing sealed is unaffected', async (t) => {
    const { res } = await mint(['sysadmin'], { name: 'importer', roles: ['demi-service-read'] }, t);
    assert.strictEqual(res.statusCode, 201);
  });
});
