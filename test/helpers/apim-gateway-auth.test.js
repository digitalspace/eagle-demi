'use strict';

/**
 * The APIM branch of `authenticate()`: the app trusts the gateway, never the headers.
 *
 * Every case here is a request that CAN reach the app directly — the Function App host stays
 * public — so what is being proved is that the subscription header buys nothing without the
 * shared secret.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const apiKeys = require('../../src/repositories/api-keys');
const { authenticate, forgetCachedKey } = require('../../src/helpers/auth');

const SECRET = 'gateway-secret-value-32-bytes-long';
const ROW_ID = 'apim:eagle-api';

function reqWith(headers) {
  return { header: (name) => headers[name] ?? null };
}

/** Resolves to {user} or {status, error} — whichever callback authenticate() reaches. */
function run(headers) {
  return new Promise((resolve) => {
    authenticate(
      reqWith(headers),
      (user) => resolve({ user }),
      (status, error) => resolve({ status, error })
    );
  });
}

function stubRegistry(t, rows) {
  t.mock.method(apiKeys, 'getById', async (id) => rows[id] || null);
  t.mock.method(apiKeys, 'touchLastUsed', async () => {});
}

function row(overrides = {}) {
  return {
    id: ROW_ID,
    name: 'eagle-api',
    hash: 'unused-on-this-path',
    roles: ['demi-service-write'],
    projectScope: null,
    expiresAt: null,
    revokedAt: null,
    ...overrides
  };
}

function withSecret(t, value) {
  const previous = process.env.APIM_GATEWAY_SECRET;
  process.env.APIM_GATEWAY_SECRET = value;
  t.after(() => {
    if (previous === undefined) delete process.env.APIM_GATEWAY_SECRET;
    else process.env.APIM_GATEWAY_SECRET = previous;
  });
}

test('the right secret plus a subscription name authenticates as that consumer', async (t) => {
  withSecret(t, SECRET);
  stubRegistry(t, { [ROW_ID]: row() });

  const { user } = await run({ 'X-Gateway-Secret': SECRET, 'X-APIM-Subscription': 'eagle-api' });

  assert.strictEqual(user.preferred_username, 'key:eagle-api');
  // The party id credentials and access-sql key off — the registry row, not the raw header.
  assert.strictEqual(user.keyId, ROW_ID);
  assert.deepStrictEqual(user.realm_access.roles, ['demi-service-write']);
  forgetCachedKey(ROW_ID);
});

test('a wrong gateway secret makes the subscription header worth nothing', async (t) => {
  withSecret(t, SECRET);
  stubRegistry(t, { [ROW_ID]: row() });

  const { status } = await run({ 'X-Gateway-Secret': 'not-the-secret', 'X-APIM-Subscription': 'eagle-api' });

  assert.strictEqual(status, 401);
  assert.strictEqual(apiKeys.getById.mock.callCount(), 0, 'no lookup for an unproven caller');
});

test('a subscription header with no secret header at all is ignored', async (t) => {
  withSecret(t, SECRET);
  stubRegistry(t, { [ROW_ID]: row() });

  const { status } = await run({ 'X-APIM-Subscription': 'eagle-api' });

  assert.strictEqual(status, 401);
  assert.strictEqual(apiKeys.getById.mock.callCount(), 0);
});

test('an unset APIM_GATEWAY_SECRET disables the branch entirely', async (t) => {
  withSecret(t, '');
  stubRegistry(t, { [ROW_ID]: row() });

  const { status } = await run({ 'X-Gateway-Secret': '', 'X-APIM-Subscription': 'eagle-api' });

  assert.strictEqual(status, 401);
  assert.strictEqual(apiKeys.getById.mock.callCount(), 0, 'an empty secret must never match');
});

test('an unresolved Key Vault reference is refused as a secret', async (t) => {
  // App Service hands the app the literal reference string when it cannot read the vault, and that
  // string is public in this repository — accepting it would be a world-readable bypass.
  const literal = '@Microsoft.KeyVault(VaultName=demi-kv-test;SecretName=apim-gateway-secret)';
  withSecret(t, literal);
  stubRegistry(t, { [ROW_ID]: row() });

  const { status } = await run({ 'X-Gateway-Secret': literal, 'X-APIM-Subscription': 'eagle-api' });

  assert.strictEqual(status, 401);
  assert.strictEqual(apiKeys.getById.mock.callCount(), 0);
});

test('a subscription with no registry row gets no identity', async (t) => {
  withSecret(t, SECRET);
  stubRegistry(t, {});

  const { status, error } = await run({ 'X-Gateway-Secret': SECRET, 'X-APIM-Subscription': 'stranger' });

  assert.strictEqual(status, 401);
  assert.match(error, /API Management subscription/);
});

test('a revoked row is refused even though APIM accepted the key', async (t) => {
  withSecret(t, SECRET);
  stubRegistry(t, { [ROW_ID]: row({ revokedAt: new Date().toISOString() }) });

  const { status } = await run({ 'X-Gateway-Secret': SECRET, 'X-APIM-Subscription': 'eagle-api' });

  assert.strictEqual(status, 401);
  forgetCachedKey(ROW_ID);
});

test('a presented X-Api-Key still owns the outcome during the dual-accept window', async (t) => {
  withSecret(t, SECRET);
  stubRegistry(t, { [ROW_ID]: row() });

  // Break-glass path: no registry read, and the APIM headers change nothing about it.
  process.env.ADMIN_API_KEY = 'break-glass-for-this-test';
  t.after(() => { delete process.env.ADMIN_API_KEY; });

  const { user } = await run({
    'X-Api-Key': 'break-glass-for-this-test',
    'X-Gateway-Secret': SECRET,
    'X-APIM-Subscription': 'eagle-api'
  });

  assert.strictEqual(user.preferred_username, 'internal-service');
  assert.strictEqual(apiKeys.getById.mock.callCount(), 0);
});
