'use strict';

const crypto = require('crypto');
const { logger } = require('../utils/logger');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const config = require('../config');
const apiKeys = require('../repositories/api-keys');
const { parseKey, verify, isLive, isStorableId } = require('./api-key');
const { acceptedValues } = require('../utils/rotating-secret');

/**
 * The cached record keeps its digest, so `verify` still runs on every request. A revoke is instant
 * on this instance via `forgetCachedKey`, up to the TTL on others.
 */
const KEY_CACHE_TTL_MS = 60_000;
const KEY_CACHE_MAX = 10_000;
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
  // Misses are cached too, so random key ids would otherwise grow the heap without bound.
  if (keyCache.size >= KEY_CACHE_MAX) keyCache.clear();
  keyCache.set(keyId, { record, at: now });
  return { record, fresh: true };
}

/**
 * Same identity shape as the Keycloak path, so rolesFor, resolveAccess and the predicates need no
 * key-specific code. `access-sql.projectScopeFor` honours `projectScope`.
 */
async function resolveRegistryKey(parsed) {
  // Keys carry the environment that minted them; any other one cannot exist here, so skip the read.
  if (parsed.env !== config.environmentName) return null;

  const { record, fresh } = await loadKeyRecord(parsed.keyId);

  if (!verify(record, parsed.secret)) return null;

  // Fire-and-forget so bookkeeping never fails a request; cache misses only, so one Cosmos write
  // per key per TTL even on public passiveAuth reads.
  if (fresh) apiKeys.touchLastUsed(record.id);

  return identityFor(record);
}

// Marks an identity built from a registry row. A Symbol key, so a token's claims, which become
// req.user wholesale on the Keycloak path, can never carry it: JSON has no Symbol keys.
const REGISTRY_IDENTITY = Symbol('registry-identity');

/** The identity a registry row grants. Shared by the presented-key and APIM paths. */
function identityFor(record) {
  return {
    preferred_username: `key:${record.name}`,
    keyId: record.id,
    realm_access: { roles: Array.isArray(record.roles) ? record.roles : [] },
    projectScope: Array.isArray(record.projectScope) ? record.projectScope : undefined,
    [REGISTRY_IDENTITY]: true
  };
}

/** True only for an identity `identityFor` built, so its `keyId` is a registry row id. */
function isRegistryIdentity(user) {
  return Boolean(user && user[REGISTRY_IDENTITY] === true);
}

/**
 * The Function host is public (Consumption APIM has no VNet), so gateway headers are attacker input
 * until the shared secret matches. Unset or unresolved Key Vault reference disables the path.
 */
function fromGateway(req) {
  const accepted = acceptedValues('APIM_GATEWAY_SECRET');
  if (accepted.length === 0) return false;

  // The header bag as well as req.header(): utils/caller-ip.js asks this question from the request
  // log and the audit writer, which are handed request-shaped objects that carry headers only.
  const presented = (req.header ? req.header('X-Gateway-Secret') : null) ||
    ((req.headers || {})['x-gateway-secret']) || '';
  return matchesConfiguredKey(presented, accepted);
}

/**
 * APIM verified the subscription key; the registry row carries roles, expiry and revocation. Its id
 * `apim:<name>` cannot collide with a minted key, so one container and cache serve both paths.
 */
async function resolveGatewaySubscription(name) {
  const id = `apim:${name}`;
  if (!isStorableId(id)) return null;

  const { record, fresh } = await loadKeyRecord(id);
  if (!isLive(record)) return null;

  if (fresh) apiKeys.touchLastUsed(record.id);

  return identityFor(record);
}

/**
 * Empty list = permissive, dev and local only (`src/config.js` refuses an empty list on test and
 * prod). An unlisted client is rejected, not demoted to public, so no caller is half-admitted.
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
 * Is this the break-glass ADMIN_API_KEY? Through config, so an unresolved Key Vault reference is
 * no key at all rather than a shared secret every caller can read off the template.
 */
function isBreakGlassKey(apiKey) {
  const validKeys = [config.adminApiKey].filter(Boolean);
  return Boolean(apiKey) && validKeys.length > 0 && matchesConfiguredKey(apiKey, validKeys);
}

/** Would `authenticate` accept this X-Api-Key? A failed registry lookup counts as no. */
async function isValidApiKey(apiKey) {
  if (isBreakGlassKey(apiKey)) return true;
  const parsed = apiKey ? parseKey(apiKey) : null;
  if (!parsed) return false;
  try {
    return Boolean(await resolveRegistryKey(parsed));
  } catch (err) {
    logger.error(`[demi-api] API key lookup failed: ${err.message}`);
    return false;
  }
}

/** Catch for a failed registry read: an outage, not a bad credential, so the caller may retry. */
function lookupFailed(what, onFailure) {
  return (err) => {
    logger.error(`[demi-api] ${what} lookup failed`, { error: err.message, stack: err.stack });
    return onFailure(503, 'Authentication is unavailable. Retry the request.');
  };
}

/**
 * Authenticates request via X-Api-Key or Keycloak Bearer token.
 *
 * @param {object} req Express request
 * @param {function} onSuccess Callback when auth succeeds: fn(user)
 * @param {function} onFailure Callback when auth fails: fn(status, error)
 */
function authenticate(req, onSuccess, onFailure) {
  // Keys from config only; the repo is public. Never accept `DOCLING_API_KEY` here: an outbound
  // secret must never be an inbound credential.
  const apiKey = req.header('X-Api-Key');

  // APIM edge. A presented X-Api-Key still wins, so the dual-accept window — machine callers on
  // their old registry keys, direct to the app — is untouched by any of this.
  const subscription = !apiKey && fromGateway(req) ? String(req.header('X-APIM-Subscription') || '').trim() : '';
  if (subscription) {
    resolveGatewaySubscription(subscription)
      .then((user) => {
        if (!user) {
          logger.warn(`[demi-api] APIM subscription '${subscription}' has no registry row; refused.`);
          return onFailure(401, 'Unauthorized. Unknown API Management subscription.');
        }
        logger.info(`[demi-api] Authenticated ${user.preferred_username} via APIM (${subscription})`);
        return onSuccess(user);
      })
      .catch(lookupFailed('APIM subscription', onFailure));
    return;
  }

  // Break-glass before the registry: an ADMIN_API_KEY shaped like a registry key would otherwise
  // miss in Cosmos and 401, locking out the one way in when the registry is down.
  if (isBreakGlassKey(apiKey)) {
    logger.info('[demi-api] Authenticated internal-service via break-glass ADMIN_API_KEY');
    // No `compliance`: one shared secret must not open the sealed compartment
    // (docs/rbac-architecture.md §1, condition 1).
    return onSuccess({
      preferred_username: 'internal-service',
      realm_access: { roles: ['sysadmin', 'staff', 'demi-admin'] }
    });
  }

  // Registry key, async: it owns the outcome from here, so never fall through after this branch.
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
      .catch(lookupFailed('API key', onFailure));
    return;
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
      issuer: config.ssoIssuer,
      // Absent rather than empty: jsonwebtoken treats a falsy `audience` as a claim to match, so
      // passing '' would reject every token instead of skipping the check.
      ...(config.ssoAudience ? { audience: config.ssoAudience } : {})
    };

    jwt.verify(token, getKey, options, (err, decoded) => {
      if (err) {
        // The reason stays in the log: the body is read by unauthenticated callers.
        logger.warn(`[demi-api] JWT verification error: ${err.message}`);
        return onFailure(401, 'Unauthorized. JWT verification failed.');
      }

      // Authentication only; route access is `middleware/auth.js`. A role check here would leave
      // passiveAuth callers anonymous, so scoped `project:` users never reach TIER.SCOPED.
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
  fromGateway,
  isValidApiKey,
  matchesConfiguredKey,
  isAllowedClient,
  isRegistryIdentity,
  forgetCachedKey,
  KEY_CACHE_MAX
};
