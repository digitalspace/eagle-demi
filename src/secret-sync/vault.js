'use strict';

/**
 * A missing secret is `null`, not a throw, so the caller can keep the live copy and fail the run.
 * src/utils/azure-credential.js is the one outside file the package script copies in.
 */

const { SecretClient } = require('@azure/keyvault-secrets');
const { createCredential } = require('../utils/azure-credential');

/**
 * @returns {Function} async (name) => { value, version } | null
 */
function createVaultReader({
  vaultUri = process.env.KEY_VAULT_URI,
  clientId = process.env.AZURE_CLIENT_ID
} = {}) {
  if (!vaultUri) throw new Error('KEY_VAULT_URI is not set');

  const client = new SecretClient(vaultUri, createCredential({
    AZURE_CLIENT_ID: clientId,
    IDENTITY_ENDPOINT: process.env.IDENTITY_ENDPOINT
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
