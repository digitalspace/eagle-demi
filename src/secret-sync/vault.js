'use strict';

/**
 * Key Vault reads for one run.
 *
 * `DefaultAzureCredential` with the user-assigned client id: the app carries exactly one
 * user-assigned identity (`demi-identity-<env>`, which already holds Key Vault Secrets User), and
 * the credential has no other way to choose between several.
 *
 * A missing secret is `null`, not a throw — the caller decides what a missing name means, and for
 * this sync it means "leave the live copy alone and fail the run". Any other error still throws.
 */

const { SecretClient } = require('@azure/keyvault-secrets');
const { DefaultAzureCredential } = require('@azure/identity');

/**
 * @returns {Function} async (name) => { value, version } | null
 */
function createVaultReader({
  vaultUri = process.env.KEY_VAULT_URI,
  clientId = process.env.AZURE_CLIENT_ID
} = {}) {
  if (!vaultUri) throw new Error('KEY_VAULT_URI is not set');

  const client = new SecretClient(vaultUri, new DefaultAzureCredential({
    managedIdentityClientId: clientId
  }));

  // Per READER, not per process: a reader is made once per run, so a value rotated between runs is
  // read fresh, while the token secret shared by every group in a namespace is read once.
  const cache = new Map();

  return async function readSecret(name) {
    if (cache.has(name)) return cache.get(name);

    let result = null;
    try {
      const secret = await client.getSecret(name);
      result = { value: secret.value, version: secret.properties.version };
    } catch (err) {
      const notFound = err.statusCode === 404 || err.code === 'SecretNotFound';
      if (!notFound) throw err;
    }

    cache.set(name, result);
    return result;
  };
}

module.exports = { createVaultReader };
