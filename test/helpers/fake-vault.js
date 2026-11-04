'use strict';

const azureCredential = require('../../src/utils/azure-credential');

let issued = 0;

/** A versionless secret URI no earlier case used, so src/utils/rotating-secret.js starts cold. */
function freshUri() {
  issued += 1;
  return `https://demi-kv-unit.vault.azure.net/secrets/case-${issued}`;
}

/**
 * Stub the vault token and the secret GET. `secrets` maps URI to value; a URI it lacks is a 404.
 * Edit the object later to rotate. Returns the fetch mock.
 */
function fakeVault(t, secrets) {
  t.mock.method(azureCredential, 'getToken', async () => 'fake-vault-token');
  return t.mock.method(globalThis, 'fetch', async (url) => {
    const uri = String(url).split('?')[0];
    return uri in secrets
      ? Response.json({ value: secrets[uri] })
      : Response.json({ error: { code: 'SecretNotFound' } }, { status: 404 });
  });
}

module.exports = { freshUri, fakeVault };
