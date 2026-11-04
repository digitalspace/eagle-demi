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

const ARM_SCOPE = 'https://management.azure.com/.default';
const FRONT_DOOR_API_VERSION = '2024-02-01';
const FRONT_DOOR_RULE_ID = /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Cdn\/profiles\/[^/]+\/ruleSets\/[^/]+\/rules\/[^/]+$/i;

/** One REST call with a bearer token for `scope` from the given TokenCredential; returns the fetch Response. */
async function azureRequest(credential, scope, method, url, body) {
  const { token } = await credential.getToken(scope);
  return fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
}

/** The ARM URL of a Front Door rules engine rule, or null when `ruleId` is not one. */
function frontDoorRuleUrl(ruleId) {
  if (!FRONT_DOOR_RULE_ID.test(ruleId || '')) return null;
  return `https://management.azure.com${ruleId}?api-version=${FRONT_DOOR_API_VERSION}`;
}

module.exports = { getToken, createCredential, azureRequest, frontDoorRuleUrl, ARM_SCOPE };
