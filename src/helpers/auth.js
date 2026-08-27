'use strict';

const crypto = require('crypto');
const { logger } = require('../utils/logger');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const config = require('../config');
const apiKeys = require('../repositories/api-keys');
const { parseKey, verify } = require('./api-key');

/**
 * Verified registry lookups, cached to keep a Cosmos point read off the hot path.
 *
 * The full record is cached, INCLUDING its digest, so `verify` still runs on every request — a
 * cached entry never means a presented secret goes unchecked. Revocation on this instance is
 * immediate via `forgetCachedKey`; on any other instance it takes up to TTL. That bound is the
 * price of the cache and is written into the runbook rather than left to be discovered.
 */
const KEY_CACHE_TTL_MS = 60_000;
const keyCache = new Map();

function forgetCachedKey(keyId) {
  keyCache.delete(String(keyId));
}

/**
 * @returns {{record: object|null, fresh: boolean}}  `fresh` is true only on a cache MISS, which is
 * what bounds the usage stamp below to one Cosmos write per key per TTL instead of one per request.
 */
async function loadKeyRecord(keyId, now = Date.now()) {
  const cached = keyCache.get(keyId);
  if (cached && now - cached.at < KEY_CACHE_TTL_MS) {
    return { record: cached.record, fresh: false };
  }

  const record = await apiKeys.getById(keyId);
  keyCache.set(keyId, { record, at: now });
  return { record, fresh: true };
}

/**
 * Resolve a registry key to an identity, or null.
 *
 * Returns the same shape the Keycloak path produces, so everything downstream — rolesFor,
 * resolveAccess, the SQL and OData predicates — is untouched by the existence of API keys.
 * `projectScope` rides along because `access-sql.projectScopeFor` already honours it.
 */
async function resolveRegistryKey(parsed) {
  const { record, fresh } = await loadKeyRecord(parsed.keyId);

  if (!verify(record, parsed.secret)) return null;

  // Fire-and-forget: a bookkeeping write must never fail an authenticated request. Only on a cache
  // miss, so a busy consumer costs one Cosmos write per TTL rather than one per request — this path
  // runs on public passiveAuth reads too, and lastUsedAt at minute resolution is all anyone wants
  // from it.
  if (fresh) apiKeys.touchLastUsed(record.id);

  return {
    preferred_username: `key:${record.name}`,
    keyId: record.id,
    realm_access: { roles: Array.isArray(record.roles) ? record.roles : [] },
    projectScope: Array.isArray(record.projectScope) ? record.projectScope : undefined
  };
}

/**
 * Client allowlist for verified Keycloak tokens.
 *
 * Empty means permissive, which is the dev and local case only — `src/config.js` refuses to boot
 * test or prod on an empty list. An unlisted client is rejected outright rather than demoted to
 * the public tier: one behaviour, so no caller is ever half-admitted.
 */
function isAllowedClient(decoded) {
  const allowed = config.allowedClients;
  if (!Array.isArray(allowed) || allowed.length === 0) return true;

  const azp = decoded && (decoded.azp || decoded.client_id);
  return Boolean(azp && allowed.includes(azp));
}

/**
 * Constant-time comparison of a presented API key against the configured keys.
 * Never use `includes()`/`===` here — those leak key material through timing.
 */
function matchesConfiguredKey(presented, validKeys) {
  const presentedBuf = Buffer.from(String(presented));
  let matched = false;
  for (const valid of validKeys) {
    const validBuf = Buffer.from(String(valid));
    // Compare every candidate (no early exit) so timing does not reveal which key matched.
    if (presentedBuf.length === validBuf.length && crypto.timingSafeEqual(presentedBuf, validBuf)) {
      matched = true;
    }
  }
  return matched;
}

// Single shared JWKS client instance with caching
const clientInstance = jwksClient({
  strictSsl: true,
  jwksUri: config.ssoJwksUri,
  cache: true,
  cacheMaxAge: 86400000, // 24 hours
  rateLimit: true,
  jwksRequestsPerMinute: 30
});

function getKey(header, callback) {
  clientInstance.getSigningKey(header.kid, (err, key) => {
    if (err) {
      callback(err);
    } else {
      callback(null, key.publicKey || key.rsaPublicKey);
    }
  });
}

/**
 * Authenticates request via X-Api-Key or Keycloak Bearer token.
 *
 * @param {object} req Express request
 * @param {function} onSuccess Callback when auth succeeds: fn(user)
 * @param {function} onFailure Callback when auth fails: fn(status, error)
 */
function authenticate(req, onSuccess, onFailure) {
  // 1. System-to-System API Key Check.
  // Keys come from configuration ONLY. Never hardcode a literal here — this repo is public,
  // and any literal in this list is a world-readable unconditional sysadmin credential.
  //
  // ADMIN_API_KEY only. `DOCLING_API_KEY` used to be in this list, which made the secret DEMI
  // sends OUTBOUND to docling (as an X-Api-Key header) simultaneously an INBOUND credential
  // granting sysadmin. A logged request header or a compromised extraction host was therefore
  // full admin. An outbound secret must never be an inbound one.
  const apiKey = req.header('X-Api-Key');

  // Break-glass FIRST: one shared secret, full privileges, no identity. It exists so the first
  // registry key can be minted and so there is a way in if the registry is unreachable — which is
  // exactly why it cannot be shadowed. Checked before the registry branch because an ADMIN_API_KEY
  // that happens to be shaped like `demi_<env>_<id>_<secret>` would otherwise parse as a registry
  // key, take that branch, miss in Cosmos and 401 — permanently disabling the one credential whose
  // whole purpose is working when nothing else does. It costs one timingSafeEqual, no Cosmos read.
  const validKeys = [process.env.ADMIN_API_KEY].filter(Boolean);

  if (apiKey && validKeys.length > 0 && matchesConfiguredKey(apiKey, validKeys)) {
    logger.info('[demi-api] Authenticated internal-service via break-glass ADMIN_API_KEY');
    return onSuccess({
      preferred_username: 'internal-service',
      realm_access: { roles: ['sysadmin', 'staff', 'demi-admin'] }
    });
  }

  // Registry key: the normal case, and the only path that yields a per-consumer identity with its
  // own roles, expiry and revocation.
  // Async, so it owns the outcome of this call from here — never fall through after this branch.
  const parsed = apiKey ? parseKey(apiKey) : null;
  if (parsed) {
    resolveRegistryKey(parsed)
      .then((user) => {
        if (!user) {
          return onFailure(401, 'Unauthorized. Invalid, expired or revoked API key.');
        }
        logger.info(`[demi-api] Authenticated ${user.preferred_username} (key ${user.keyId})`);
        return onSuccess(user);
      })
      .catch((err) => {
        logger.error(`[demi-api] API key lookup failed: ${err.message}`);
        return onFailure(401, 'Unauthorized. Invalid, expired or revoked API key.');
      });
    return;
  }

  // Testing fallback only — guarded, and never reachable outside the test runner.
  if (process.env.NODE_ENV === 'test' && apiKey === 'eagle-demi-api-key') {
    return onSuccess({
      preferred_username: 'internal-service',
      realm_access: { roles: ['sysadmin', 'staff', 'demi-admin'] }
    });
  }

  // 2. User Keycloak Bearer Token Check
  const authHeader = req.header('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];

    if (!config.keycloakEnabled) {
      if (process.env.NODE_ENV === 'test') {
        try {
          const decoded = jwt.decode(token);
          if (decoded && decoded.realm_access && decoded.realm_access.roles) {
            return onSuccess(decoded);
          }
        } catch (_err) {
          return onFailure(401, 'Unauthorized. Invalid Bearer token structure.');
        }
        // Unverified token with no usable roles — fail rather than falling through to
        // the JWKS path, which cannot succeed while keycloak is disabled.
        return onFailure(401, 'Unauthorized. Invalid Bearer token structure.');
      }
      logger.warn('[demi-api] Warning: keycloakEnabled is false in non-test environment.');
      return onFailure(401, 'Unauthorized. Keycloak signature verification required.');
    }

    try {
      const decoded = jwt.decode(token, { complete: true });
      if (!decoded || !decoded.header || !decoded.header.kid) {
        return onFailure(401, 'Unauthorized. JWT header or kid is missing.');
      }
    } catch (_err) {
      return onFailure(401, 'Unauthorized. Malformed Bearer token.');
    }

    const options = {
      algorithms: ['RS256'],
      issuer: config.ssoIssuer
    };

    jwt.verify(token, getKey, options, (err, decoded) => {
      if (err) {
        logger.error(`[demi-api] JWT verification error: ${err.message}`);
        return onFailure(401, `Unauthorized. JWT verification failed: ${err.message}`);
      }

      // AUTHENTICATION ONLY. A verified token is a verified token — whether its bearer may reach
      // a given route is the route's decision, and it is made in `middleware/auth.js`.
      //
      // This function used to reject any token without sysadmin/staff/demi-admin. That is correct
      // for admin routes and wrong for the other caller: `middleware/passiveAuth.js` caught the
      // 403, logged "continuing as anonymous", and left `req.user` unset. So a valid Keycloak user
      // carrying `project:207` or any other role type was indistinguishable from a logged-out
      // visitor, `resolveAccess()` never returned TIER.SCOPED, and `projectScopeFor()` could never
      // fire — it reads roles off a `req.user` the 403 had already prevented from existing.
      const azp = decoded.azp || decoded.client_id;
      if (!isAllowedClient(decoded)) {
        logger.warn(`[demi-api] Client '${azp || 'unknown'}' is not in DEMI_ALLOWED_CLIENTS; refused.`);
        return onFailure(401, 'Unauthorized. Client is not permitted to call this API.');
      }

      logger.info(`[demi-api] Authenticated ${decoded.preferred_username || 'token'} (client ${azp || 'unknown'})`);
      return onSuccess(decoded);
    });
    return;
  }

  return onFailure(401, 'Unauthorized. Valid X-Api-Key or Bearer token required.');
}

module.exports = {
  authenticate,
  isAllowedClient,
  forgetCachedKey,
  KEY_CACHE_TTL_MS
};
