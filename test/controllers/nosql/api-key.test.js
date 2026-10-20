'use strict';

/**
 * Who may mint a `compliance` key (docs/rbac-architecture.md §1, condition 3).
 *
 * The route's own gate is `requireAdmin`, which every `staff`, `sysadmin` and `demi-admin` caller
 * passes, and `compliance` is grantable — so without the caller check any of them mints itself into
 * the sealed compartment, and the level-0 exclusion in `access-sql.js` protects nothing.
 */

process.env.NODE_ENV = 'test';
// Before src/config is first required: the audit writer is inert without a collection rule.
process.env.AUDIT_DCR_ENDPOINT = 'https://dcr-test.canadacentral-1.ingest.monitor.azure.com';
process.env.AUDIT_DCR_IMMUTABLE_ID = 'dcr-testimmutableid';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../../src/db/cosmos-nosql');
const audit = require('../../../src/utils/audit');
const apiKeys = require('../../../src/repositories/api-keys');
const controller = require('../../../src/controllers/nosql/api-key');
const { GRANTABLE_ROLES } = require('../../../src/controllers/nosql/api-key');

let rows = [];
audit._setTransport(async (stream, batch) => { rows.push(...batch); });

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

/**
 * Who may mint a `sysadmin` key.
 *
 * Same shape as the compliance gate above and the same reason: `requireAdmin` passes `staff` and
 * `demi-admin` too, and `sysadmin` is grantable — so without a caller check either of them mints
 * itself a key that administers the service, this route included.
 */
test('minting a sysadmin key', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a demi-admin cannot mint a sysadmin key', async (t) => {
    const { res, stored } = await mint(
      ['demi-admin'], { name: 'ops', roles: ['sysadmin'], allowWrite: true }, t);

    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body, { error: 'sysadmin is not grantable by this caller' });
    assert.deepStrictEqual(stored, [], 'a refused mint writes nothing');
  });

  await t.test('a staff caller cannot either', async (t) => {
    const { res, stored } = await mint(
      ['staff'], { name: 'ops', roles: ['sysadmin'], allowWrite: true }, t);

    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(stored, [], 'a refused mint writes nothing');
  });

  await t.test('a sysadmin can mint a sysadmin key', async (t) => {
    // The search definition apply is run with one of these, minted for the run and revoked after,
    // so the gate has to refuse the caller without making the role unmintable.
    const { res, stored } = await mint(
      ['sysadmin'], { name: 'search-definitions run', roles: ['sysadmin'], allowWrite: true }, t);

    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(stored[0].roles, ['sysadmin']);
  });
});

/**
 * Who may mint the rest of the privileged roles.
 *
 * `sysadmin` was gated on its own while `demi-admin` and the two service roles were not, so a
 * `staff` caller — who passes `requireAdmin` — could mint itself a key that reads every row at
 * every level (`SECURE_ROLES`, src/helpers/access-sql.js) and administers the service.
 */
test('minting a privileged key', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a staff caller cannot mint a demi-admin key', async (t) => {
    const { res, stored } = await mint(
      ['staff'], { name: 'ops', roles: ['demi-admin'], allowWrite: true }, t);

    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body, { error: 'demi-admin is not grantable by this caller' });
    assert.deepStrictEqual(stored, [], 'a refused mint writes nothing');
  });

  await t.test('a staff caller cannot mint a demi-service-read key either', async (t) => {
    // Read privilege is the one that does not look like an escalation: the key writes nothing, and
    // it still sees every level-1 row a staff caller may not read.
    const { res, stored } = await mint(
      ['staff'], { name: 'importer', roles: ['demi-service-read'] }, t);

    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body, { error: 'demi-service-read is not grantable by this caller' });
    assert.deepStrictEqual(stored, [], 'a refused mint writes nothing');
  });

  await t.test('a sysadmin can still mint a demi-admin key', async (t) => {
    // The gate refuses the caller, not the role: the service roles are issued from this route and
    // nothing else, so a rule that made them unmintable would take the registry with it.
    const { res, stored } = await mint(
      ['sysadmin'], { name: 'ops', roles: ['demi-admin'], allowWrite: true }, t);

    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(stored[0].roles, ['demi-admin']);
  });

  await t.test('a demi-admin caller can mint a demi-admin key, a role it already holds', async (t) => {
    const { res, stored } = await mint(
      ['demi-admin'], { name: 'ops', roles: ['demi-admin'], allowWrite: true }, t);

    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    assert.deepStrictEqual(stored[0].roles, ['demi-admin']);
  });
});

test('revoking a key', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a repeat revoke answers 200 with the row and writes no second audit row', async (t) => {
    let stored = { id: 'k1', name: 'seeder', roles: ['public'], hash: 'h', revokedAt: null };
    t.mock.method(cosmos, 'readItem', async () => ({ ...stored }));
    const upsert = t.mock.method(cosmos, 'upsert', async (_c, row) => { stored = row; return { ...row }; });
    // Drain the mints above, so rows hold only this test's events.
    await audit.flush();
    rows = [];
    const req = { params: { id: 'k1' }, query: {}, user: { preferred_username: 'admin.person' } };

    const first = mockRes();
    await controller.revokeApiKey(req, first);
    const again = mockRes();
    await controller.revokeApiKey(req, again);
    await audit.flush();

    for (const res of [first, again]) {
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.key.revokedAt, stored.revokedAt);
      assert.strictEqual(res.body.key.hash, undefined, 'the row is still redacted');
    }
    assert.strictEqual(upsert.mock.callCount(), 1, 'the stored revokedAt is kept, not restamped');
    assert.deepStrictEqual(rows.map(r => r.Action), ['apikey.revoke']);
  });
});
