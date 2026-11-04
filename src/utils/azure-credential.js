'use strict';

let credential = null;

/** The credential for this process. A host with IDENTITY_ENDPOINT (App Service, Functions; not the
 * devbox VM) goes straight to its user-assigned identity; elsewhere the default chain. */
function createCredential(env = process.env) {
  const identity = require('@azure/identity');
  const clientId = env.AZURE_CLIENT_ID;
  // App Insights records every failed leg of the default chain as an exception, even when a later leg succeeds.
  if (clientId && env.IDENTITY_ENDPOINT) return new identity.ManagedIdentityCredential({ clientId });
  return new identity.DefaultAzureCredential(clientId ? { managedIdentityClientId: clientId } : undefined);
}

/** An Entra token for one scope from the one process credential. @azure/identity loads lazily so
 * importing this module costs nothing where nothing calls Azure. */
async function getToken(scope) {
  if (!credential) credential = createCredential();
  // The credential caches and refreshes internally, so this is not a network call per use.
  const token = await credential.getToken(scope);
  return token && token.token;
}

const ARM_SCOPE = 'https://management.azure.com/.default';
const FRONT_DOOR_API_VERSION = '2024-02-01';
const AZURE_REQUEST_TIMEOUT_MS = 30000;
// Plain ARM name characters only: `.`/`..` segments, `?`, `#` and `%` would change the URL the token goes to.
const SEGMENT = String.raw`(?!\.{1,2}(?:/|$))[A-Za-z0-9._()-]+`;
const FRONT_DOOR_RULE_ID = new RegExp(String.raw`^/subscriptions/${SEGMENT}/resourceGroups/${SEGMENT}` +
  String.raw`/providers/Microsoft\.Cdn/profiles/${SEGMENT}/ruleSets/${SEGMENT}/rules/${SEGMENT}$`, 'i');

/** One REST call with a bearer token for `scope` from the given TokenCredential; returns the fetch Response. */
async function azureRequest(credential, scope, method, url, body) {
  const { token } = await credential.getToken(scope);
  return fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(AZURE_REQUEST_TIMEOUT_MS)
  });
}

/** The ARM URL of a Front Door rules engine rule, or null when `ruleId` is not one. */
function frontDoorRuleUrl(ruleId) {
  if (!FRONT_DOOR_RULE_ID.test(ruleId || '')) return null;
  return `https://management.azure.com${ruleId}?api-version=${FRONT_DOOR_API_VERSION}`;
}

module.exports = { getToken, createCredential, azureRequest, frontDoorRuleUrl, ARM_SCOPE };
