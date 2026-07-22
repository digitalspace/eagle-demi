'use strict';

process.env.NODE_ENV = 'test';
process.env.DOCLING_API_KEY = 'eagle-demi-api-key';

const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');
const passiveAuthMiddleware = require('../../src/middleware/passiveAuth');
const config = require('../../src/config');

test('Passive Auth Middleware Tests', async (t) => {

  t.afterEach(() => {
    t.mock.restoreAll();
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

    passiveAuthMiddleware(req, res, next);

    assert.ok(nextCalled);
    assert.ok(req.user);
    assert.strictEqual(req.user.preferred_username, 'internal-service');
    assert.ok(req.user.realm_access.roles.includes('sysadmin'));
  });

  await t.test('calls next() but does NOT populate req.user when invalid X-Api-Key is provided', () => {
    const req = {
      header: (name) => {
        if (name === 'X-Api-Key') return 'wrong-api-key';
        return null;
      }
    };
    let nextCalled = false;
    const next = () => {
      nextCalled = true;
    };
    const res = {};

    passiveAuthMiddleware(req, res, next);

    assert.ok(nextCalled);
    assert.strictEqual(req.user, undefined);
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

    passiveAuthMiddleware(req, res, next);

    assert.ok(nextCalled);
    assert.ok(req.user);
    assert.strictEqual(req.user.preferred_username, 'test-user');
    assert.ok(req.user.realm_access.roles.includes('demi-admin'));
  });

  await t.test('calls next() without user when Bearer token decoding fails', () => {
    config.keycloakEnabled = false;

    t.mock.method(jwt, 'decode', () => {
      throw new Error('Invalid token format');
    });

    const req = {
      header: (name) => {
        if (name === 'Authorization') return 'Bearer bad-token';
        return null;
      }
    };

    let nextCalled = false;
    const next = () => {
      nextCalled = true;
    };
    const res = {};

    passiveAuthMiddleware(req, res, next);

    assert.ok(nextCalled);
    assert.strictEqual(req.user, undefined);
  });
});
