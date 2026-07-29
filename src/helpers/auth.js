'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const config = require('../config');

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
  const apiKey = req.header('X-Api-Key');
  const validKeys = [
    config.doclingKey,
    process.env.DOCLING_API_KEY,
    process.env.ADMIN_API_KEY
  ].filter(Boolean);

  if (apiKey && validKeys.length > 0 && matchesConfiguredKey(apiKey, validKeys)) {
    return onSuccess({
      preferred_username: 'internal-service',
      realm_access: { roles: ['sysadmin', 'staff', 'demi-admin'] }
    });
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
      console.warn('[demi-api] Warning: keycloakEnabled is false in non-test environment.');
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
        console.error('[demi-api] JWT verification error:', err.message);
        return onFailure(401, `Unauthorized. JWT verification failed: ${err.message}`);
      }

      const roles = decoded.realm_access?.roles || [];
      const hasPermission = roles.includes('sysadmin') || roles.includes('staff') || roles.includes('demi-admin');

      if (!hasPermission) {
        return onFailure(403, 'Forbidden. User does not possess admin or staff permissions.');
      }

      return onSuccess(decoded);
    });
    return;
  }

  return onFailure(401, 'Unauthorized. Valid X-Api-Key or Bearer token required.');
}

module.exports = {
  authenticate
};
