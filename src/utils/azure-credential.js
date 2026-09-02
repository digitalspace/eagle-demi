'use strict';

let credential = null;

/**
 * An Entra token for one scope, from the app's user-assigned identity.
 *
 * One credential per process, several scopes: the audit writer publishes to Azure Monitor, the
 * admin read routes query Log Analytics and ARM. Required lazily, matching src/db/cosmos-nosql.js:
 * importing this module must not pull in @azure/identity where nothing calls Azure.
 */
async function getToken(scope) {
  if (!credential) {
    const { DefaultAzureCredential } = require('@azure/identity');
    credential = new DefaultAzureCredential(
      process.env.AZURE_CLIENT_ID
        ? { managedIdentityClientId: process.env.AZURE_CLIENT_ID }
        : undefined
    );
  }
  // The credential caches and refreshes internally, so this is not a network call per use.
  const token = await credential.getToken(scope);
  return token && token.token;
}

module.exports = { getToken };
