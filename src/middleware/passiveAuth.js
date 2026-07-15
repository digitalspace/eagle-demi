'use strict';

const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const config = require('../config');

// Initialize JWKS client with caching for performance
const clientInstance = jwksClient({
  strictSsl: true,
  jwksUri: config.ssoJwksUri,
  cache: true,
  cacheMaxAge: 86400000, // 24 hours
  rateLimit: true,
  jwksRequestsPerMinute: 5
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

module.exports = (req, res, next) => {
  // 1. System-to-System API Key Check
  const apiKey = req.header('X-Api-Key');
  const expectedKey = process.env.DOCLING_API_KEY;

  if (expectedKey && apiKey && apiKey === expectedKey) {
    req.user = {
      preferred_username: 'internal-service',
      realm_access: { roles: ['sysadmin', 'staff', 'demi-admin'] }
    };
    return next();
  }

  // Development/Testing fallback (bypassed in production)
  if (process.env.NODE_ENV !== 'production' && apiKey === 'eagle-demi-api-key') {
    req.user = {
      preferred_username: 'internal-service',
      realm_access: { roles: ['sysadmin', 'staff', 'demi-admin'] }
    };
    return next();
  }

  // 2. User Keycloak Bearer Token Check
  const authHeader = req.header('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];

    if (!config.keycloakEnabled) {
      // Local testing / Keycloak bypass (do not verify signature, only decode)
      try {
        const decoded = jwt.decode(token);
        if (decoded && decoded.realm_access && decoded.realm_access.roles) {
          req.user = decoded;
        }
      } catch (err) {
        // Silent catch for passive authentication
      }
      return next();
    }

    // Verify token against remote Keycloak JWKS
    let kid;
    try {
      const decoded = jwt.decode(token, { complete: true });
      if (!decoded || !decoded.header || !decoded.header.kid) {
        return next();
      }
      kid = decoded.header.kid;
    } catch (err) {
      return next();
    }

    const options = {
      algorithms: ['RS256'],
      issuer: config.ssoIssuer
    };

    jwt.verify(token, getKey, options, (err, decoded) => {
      if (!err && decoded) {
        req.user = decoded;
      }
      return next();
    });
    return;
  }

  return next();
};
