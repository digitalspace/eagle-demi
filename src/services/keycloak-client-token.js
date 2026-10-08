'use strict';

/**
 * Client-credentials bearer for a confidential Keycloak client. `issuer` is the realm URL,
 * `<keycloakUrl>/realms/<realm>`. `fetch` is a test seam; it defaults to the global one at call time.
 *
 * @returns {Promise<{accessToken: string, expiresIn: number|null}>}
 */
async function clientCredentialsToken({ issuer, clientId, clientSecret, timeoutMs = null, fetch: get = globalThis.fetch }) {
  const res = await get(`${issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {})
  });
  if (!res.ok) throw new Error(`token for ${clientId}: HTTP ${res.status}`);
  const body = await res.json();
  if (!body || typeof body.access_token !== 'string' || !body.access_token) {
    throw new Error(`token for ${clientId}: the response carries no access_token`);
  }
  const expiresIn = Number(body.expires_in);
  return { accessToken: body.access_token, expiresIn: Number.isFinite(expiresIn) ? expiresIn : null };
}

module.exports = { clientCredentialsToken };
