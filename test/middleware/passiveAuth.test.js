'use strict';

process.env.NODE_ENV = 'test';
process.env.DOCLING_API_KEY = 'eagle-demi-api-key';

const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');
const passiveAuthMiddleware = require('../../src/middleware/passiveAuth');
const { resolveAccess, TIER } = require('../../src/helpers/access-sql');
const { filterFor } = require('../../src/helpers/access-odata');
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

  // The regression this ticket exists for. Before the fix, `authenticate()` rejected any verified
  // token without sysadmin/staff/demi-admin with a 403; passiveAuth caught it and continued as
  // anonymous, so `req.user` stayed unset and the scoped tier was unreachable. This test fails on
  // the old code (req.user === undefined) and passes on the new.
  await t.test('populates req.user for a verified token that is NOT privileged', () => {
    config.keycloakEnabled = true;

    t.mock.method(jwt, 'decode', () => ({ header: { kid: 'key-id' } }));
    t.mock.method(jwt, 'verify', (token, getKey, options, callback) => {
      callback(null, {
        preferred_username: 'scoped-user',
        realm_access: { roles: ['compliance', 'project:207'] }
      });
    });

    const req = {
      header: (name) => (name === 'Authorization' ? 'Bearer mock-token' : null)
    };
    let nextCalled = false;
    const next = () => {
      nextCalled = true;
    };

    passiveAuthMiddleware(req, {}, next);

    assert.ok(nextCalled);
    assert.ok(req.user, 'a verified non-privileged token must still populate req.user');
    assert.strictEqual(req.user.preferred_username, 'scoped-user');
    assert.deepStrictEqual(req.user.realm_access.roles, ['compliance', 'project:207']);
  });

  // The payoff, end to end: a populated req.user is only useful if it reaches the ACL. This is the
  // seam that was dead — `project:` roles did nothing at all.
  await t.test('a non-privileged token reaches the ACL as a team grant', () => {
    config.keycloakEnabled = true;

    t.mock.method(jwt, 'decode', () => ({ header: { kid: 'key-id' } }));
    t.mock.method(jwt, 'verify', (token, getKey, options, callback) => {
      callback(null, { realm_access: { roles: ['compliance', 'project:207'] } });
    });

    const req = {
      header: (name) => (name === 'Authorization' ? 'Bearer mock-token' : null)
    };
    passiveAuthMiddleware(req, {}, () => {});

    const access = resolveAccess(req);
    // A realm project role GRANTS a team. It never restricts, so this caller is not scoped.
    assert.strictEqual(access.tier, TIER.PUBLIC);
    assert.strictEqual(access.projectScope, null);
    assert.deepStrictEqual(access.teams, ['207']);
    // `project:207` is the team dimension; it must NOT leak into the role list.
    assert.ok(access.roles.includes('compliance'));
    assert.ok(!access.roles.some(r => r.startsWith('project:')));

    const { filter, empty } = filterFor(access);
    assert.strictEqual(empty, false);
    assert.match(filter, /read\/any\(r: search\.in\(r, 'public,compliance', ','\)\)/);
    assert.match(filter, / or \(read\/any\(r: r eq 'team'\) and search\.in\(projectId, '207', ','\)\)/);
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
