'use strict';

let credential = null;

/**
 * The credential for this process. Inside an App Service or Functions host that carries a
 * user-assigned identity (the platform sets IDENTITY_ENDPOINT; a VM such as the devbox does not),
 * go straight to that identity. Everywhere else, including the devbox and local `az login`, keep
 * DefaultAzureCredential's chain.
 */
function createCredential(env = process.env) {
  const identity = require('@azure/identity');
  const clientId = env.AZURE_CLIENT_ID;
  // App Insights records every failed leg of the default chain as an exception, even when a later leg succeeds.
  if (clientId && env.IDENTITY_ENDPOINT) return new identity.ManagedIdentityCredential({ clientId });
  return new identity.DefaultAzureCredential(clientId ? { managedIdentityClientId: clientId } : undefined);
}

/**
 * An Entra token for one scope, from the app's user-assigned identity.
 *
 * One credential per process, several scopes: the audit writer publishes to Azure Monitor, the
 * admin read routes query Log Analytics and ARM. Required lazily, matching src/db/cosmos-nosql.js:
 * importing this module must not pull in @azure/identity where nothing calls Azure.
 */
async function getToken(scope) {
  if (!credential) credential = createCredential();
  // The credential caches and refreshes internally, so this is not a network call per use.
  const token = await credential.getToken(scope);
  return token && token.token;
}

module.exports = { getToken, createCredential };
