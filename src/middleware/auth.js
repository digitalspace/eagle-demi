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

module.exports = (req, res, next) => {
  // 1. System-to-System API Key Check
  const apiKey = req.header('X-Api-Key');
  const expectedKey = process.env.DOCLING_API_KEY;

  if (expectedKey && apiKey && apiKey === expectedKey) {
    // Grant access as a system user
    req.user = {
      preferred_username: 'internal-service',
      realm_access: { roles: ['sysadmin', 'staff', 'demi-admin'] }
    };
    return next();
  }

  // Testing fallback only
  if (process.env.NODE_ENV === 'test' && apiKey === 'eagle-demi-api-key') {
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
      if (process.env.NODE_ENV === 'test') {
        // Local testing / Keycloak bypass (do not verify signature, only decode)
        try {
          const decoded = jwt.decode(token);
          if (decoded && decoded.realm_access && decoded.realm_access.roles) {
            req.user = decoded;
            return next();
          }
        } catch (err) {
          return res.status(401).json({ error: 'Unauthorized. Invalid Bearer token structure.' });
        }
      } else {
        console.warn('[demi-api] Warning: keycloakEnabled is false in non-test environment. Bearer token signature verification cannot be bypassed.');
        return res.status(401).json({ error: 'Unauthorized. Keycloak signature verification required.' });
      }
    }

    // Verify token against remote Keycloak JWKS
    let kid;
    try {
      const decoded = jwt.decode(token, { complete: true });
      if (!decoded || !decoded.header || !decoded.header.kid) {
        return res.status(401).json({ error: 'Unauthorized. JWT header or kid is missing.' });
      }
      kid = decoded.header.kid;
    } catch (err) {
      return res.status(401).json({ error: 'Unauthorized. Malformed Bearer token.' });
    }

    const options = {
      algorithms: ['RS256'],
      issuer: config.ssoIssuer
    };

    jwt.verify(token, getKey, options, (err, decoded) => {
      if (err) {
        console.error('[demi-api] JWT verification error:', err.message);
        return res.status(401).json({ error: `Unauthorized. JWT verification failed: ${err.message}` });
      }

      // Check if user has required roles (sysadmin, staff, or demi-admin)
      const roles = decoded.realm_access?.roles || [];
      const hasPermission = roles.includes('sysadmin') || roles.includes('staff') || roles.includes('demi-admin');

      if (!hasPermission) {
        return res.status(403).json({ error: 'Forbidden. User does not possess admin or staff permissions.' });
      }

      req.user = decoded;
      return next();
    });
    return;
  }

  // 3. Unauthorized fallback
  return res.status(401).json({ error: 'Unauthorized. Valid X-Api-Key or Bearer token required.' });
};
