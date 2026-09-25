'use strict';

/**
 * Callers for the request-level auth suites, as the registry sees them.
 *
 * `stubRegistry` swaps the api-keys repository for an in-memory map, so a key minted through
 * POST /admin/api-keys in the same test authenticates afterwards. `presentedKey` is a registry key
 * sent as X-Api-Key; `gatewayCaller` is a row APIM proves, sent with the headers the gateway stamps.
 */

const apiKeys = require('../../src/repositories/api-keys');
const { generateKey } = require('../../src/helpers/api-key');
const { forgetCachedKey } = require('../../src/helpers/auth');

const GATEWAY_SECRET = 'gateway-secret-for-the-suites';

/** Set an environment variable for one test, and put the old value back after it. */
function setEnv(t, name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

function registryRow(fields) {
  return {
    hash: null, roles: [], projectScope: null, expiresAt: null, revokedAt: null, ...fields
  };
}

/** A registry key presented as X-Api-Key: its row, and the headers that authenticate as it. */
function presentedKey(name, roles, projectScope = null) {
  const { keyId, plaintext, hash } = generateKey('test');
  return {
    row: registryRow({ id: keyId, name, hash, roles, projectScope }),
    headers: { 'x-api-key': plaintext }
  };
}

/** A row APIM proves: id `apim:<name>`, no key material, reached only through the gateway. */
function gatewayCaller(t, name, roles, projectScope = null) {
  setEnv(t, 'APIM_GATEWAY_SECRET', GATEWAY_SECRET);
  return {
    row: registryRow({ id: `apim:${name}`, name, roles, projectScope }),
    headers: { 'x-gateway-secret': GATEWAY_SECRET, 'x-apim-subscription': name }
  };
}

/** The registry as a map, seeded with `rows`. Cached lookups are dropped on both sides of the test. */
function stubRegistry(t, rows = []) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const forgetAll = () => { for (const id of byId.keys()) forgetCachedKey(id); };

  forgetAll();
  t.mock.method(apiKeys, 'getById', async (id) => byId.get(String(id)) || null);
  t.mock.method(apiKeys, 'upsert', async (row) => { byId.set(row.id, row); return row; });
  t.mock.method(apiKeys, 'touchLastUsed', async () => {});
  t.after(forgetAll);
  return byId;
}

module.exports = { setEnv, presentedKey, gatewayCaller, stubRegistry };
