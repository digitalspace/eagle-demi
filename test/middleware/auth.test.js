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

  /** Run the middleware over a verified token carrying `roles`. */
  function withRoles(roles) {
    config.keycloakEnabled = true;
    t.mock.method(jwt, 'decode', () => ({ header: { kid: 'key-id' } }));
    t.mock.method(jwt, 'verify', (token, getKey, options, callback) => {
      callback(null, { preferred_username: 'someone', realm_access: { roles } });
    });

    const out = { nextCalled: false, status: 0, body: null };
    const res = {
      status: (val) => {
        out.status = val;
        return { json: (data) => { out.body = data; } };
      }
    };

    const req = { header: (name) => (name === 'Authorization' ? 'Bearer mock-token' : null) };
    authMiddleware(req, res, () => { out.nextCalled = true; });
    return out;
  }

  await t.test('a staff-only token passes authMiddleware after the SECURE_ROLES change', () => {
    // `staff` is no longer privileged on the row plane, and this gate is not about that: it fronts
    // every write and admin route, so gating it on isPrivileged would lock staff out of the API.
    const out = withRoles(['staff']);
    assert.ok(out.nextCalled);
    assert.strictEqual(out.status, 0, 'nothing may 403 a staff session');
  });

  await t.test('a demi-service-read token still passes authMiddleware', () => {
    // A read tier holding no write role, so `[...WRITE_ROLES]` alone would 403 it.
    const out = withRoles(['demi-service-read']);
    assert.ok(out.nextCalled);
    assert.strictEqual(out.status, 0);
  });

  await t.test('a compliance-only token is still 403 at authMiddleware', () => {
    // Four routes behind this middleware have no second gate. The compartment role reaches its own
    // chain and nothing else.
    const out = withRoles(['compliance']);
    assert.strictEqual(out.nextCalled, false);
    assert.strictEqual(out.status, 403);
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
    // Fixed string: the verification reason goes to the log, not to an unauthenticated caller.
    assert.strictEqual(jsonVal.error, 'Unauthorized. JWT verification failed.');
  });
});

test('JWT verification options', async (t) => {
  // Capture the options object handed to jwt.verify. `verified` is never reached — the middleware
  // 403s a roleless user — and it does not need to be: the assertion is on what was asked for.
  function optionsFor(audience) {
    const previous = config.ssoAudience;
    const previousKeycloak = config.keycloakEnabled;
    config.ssoAudience = audience;
    config.keycloakEnabled = true;

    let captured = null;
    t.mock.method(jwt, 'decode', () => ({ header: { kid: 'key-id' } }));
    t.mock.method(jwt, 'verify', (token, getKey, opts) => { captured = opts; });

    const req = { header: (name) => (name === 'Authorization' ? 'Bearer mock-token' : null) };
    const res = { status: () => ({ json: () => {} }) };

    try {
      authMiddleware(req, res, () => {});
      return captured;
    } finally {
      config.ssoAudience = previous;
      config.keycloakEnabled = previousKeycloak;
      t.mock.restoreAll();
    }
  }

  await t.test('jwt.verify is given the configured audience', () => {
    assert.strictEqual(optionsFor('demi-test-aud').audience, 'demi-test-aud');
  });

  await t.test('no audience configured means no audience option', () => {
    // Not `audience: ''` — jsonwebtoken would read that as a claim to match and reject everything.
    assert.strictEqual('audience' in optionsFor(''), false);
  });

  await t.test('issuer and algorithms are still pinned', () => {
    const options = optionsFor('demi-test-aud');
    assert.deepStrictEqual(options.algorithms, ['RS256']);
    assert.strictEqual(options.issuer, config.ssoIssuer);
  });
});

