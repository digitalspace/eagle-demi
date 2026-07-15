'use strict';

process.env.NODE_ENV = 'test';
process.env.DOCLING_API_KEY = 'eagle-demi-api-key';

const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');
const authMiddleware = require('../../src/middleware/auth');
const config = require('../../src/config');

test('Auth Middleware Tests', async (t) => {

  t.afterEach(() => {
    t.mock.restoreAll();
    // Reset config changes
    config.keycloakEnabled = true;
  });

  await t.test('calls next() and populates req.user when valid X-Api-Key is provided', () => {
    const req = {
      header: (name) => {
        if (name === 'X-Api-Key') return 'eagle-demi-api-key';
        return null;
      }
    };
    let nextCalled = false;
    const next = () => {
      nextCalled = true;
    };
    const res = {};

    authMiddleware(req, res, next);

    assert.ok(nextCalled);
    assert.ok(req.user);
    assert.strictEqual(req.user.preferred_username, 'internal-service');
    assert.ok(req.user.realm_access.roles.includes('sysadmin'));
  });

  await t.test('decodes without verification when Keycloak is disabled and valid Bearer is provided', () => {
    config.keycloakEnabled = false;

    const mockPayload = {
      preferred_username: 'test-user',
      realm_access: { roles: ['demi-admin'] }
    };

    t.mock.method(jwt, 'decode', () => mockPayload);

    const req = {
      header: (name) => {
        if (name === 'Authorization') return 'Bearer mock-jwt-token';
        return null;
      }
    };

    let nextCalled = false;
    const next = () => {
      nextCalled = true;
    };
    const res = {};

    authMiddleware(req, res, next);

    assert.ok(nextCalled);
    assert.ok(req.user);
    assert.strictEqual(req.user.preferred_username, 'test-user');
    assert.ok(req.user.realm_access.roles.includes('demi-admin'));
  });

  await t.test('returns 401 when Bearer token is completely missing or invalid', () => {
    const req = {
      header: () => null
    };

    let statusVal = 0;
    let jsonVal = null;
    const res = {
      status: (val) => {
        statusVal = val;
        return {
          json: (data) => {
            jsonVal = data;
          }
        };
      }
    };
    const next = () => {};

    authMiddleware(req, res, next);

    assert.strictEqual(statusVal, 401);
    assert.ok(jsonVal.error.includes('Valid X-Api-Key or Bearer token required'));
  });

  await t.test('returns 403 when Bearer token is verified but lacks required roles', () => {
    config.keycloakEnabled = true;

    // Stub jwt.decode to return kid
    t.mock.method(jwt, 'decode', () => ({ header: { kid: 'key-id' } }));

    // Stub jwt.verify to call callback with success, but user has no roles
    t.mock.method(jwt, 'verify', (token, getKey, options, callback) => {
      callback(null, {
        preferred_username: 'regular-user',
        realm_access: { roles: ['guest'] }
      });
    });

    const req = {
      header: (name) => {
        if (name === 'Authorization') return 'Bearer mock-token';
        return null;
      }
    };

    let statusVal = 0;
    let jsonVal = null;
    const res = {
      status: (val) => {
        statusVal = val;
        return {
          json: (data) => {
            jsonVal = data;
          }
        };
      }
    };
    const next = () => {};

    authMiddleware(req, res, next);

    assert.strictEqual(statusVal, 403);
    assert.ok(jsonVal.error.includes('Forbidden. User does not possess admin or staff permissions'));
  });

  await t.test('returns 401 when Bearer token verification fails', () => {
    config.keycloakEnabled = true;

    // Stub jwt.decode to return kid
    t.mock.method(jwt, 'decode', () => ({ header: { kid: 'key-id' } }));

    // Stub jwt.verify to call callback with error
    t.mock.method(jwt, 'verify', (token, getKey, options, callback) => {
      callback(new Error('invalid signature'));
    });

    const req = {
      header: (name) => {
        if (name === 'Authorization') return 'Bearer mock-token';
        return null;
      }
    };

    let statusVal = 0;
    let jsonVal = null;
    const res = {
      status: (val) => {
        statusVal = val;
        return {
          json: (data) => {
            jsonVal = data;
          }
        };
      }
    };
    const next = () => {};

    authMiddleware(req, res, next);

    assert.strictEqual(statusVal, 401);
    assert.ok(jsonVal.error.includes('JWT verification failed: invalid signature'));
  });
});

