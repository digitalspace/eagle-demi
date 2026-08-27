'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

const config = require('../../src/config');
const { isAllowedClient, authenticate } = require('../../src/helpers/auth');

function tokenFrom(azp, roles) {
  return { azp, preferred_username: 'service-account-' + azp, realm_access: { roles } };
}

function withAllowlist(list, fn) {
  const previous = config.allowedClients;
  config.allowedClients = list;
  try { return fn(); } finally { config.allowedClients = previous; }
}

test('client allowlist', async (t) => {
  await t.test('empty allowlist admits any client', () => {
    // The dev and local case only: src/config.js refuses to boot test or prod on an empty list.
    withAllowlist([], () => {
      assert.strictEqual(isAllowedClient(tokenFrom('anything', ['sysadmin'])), true);
    });
  });

  await t.test('a listed azp is admitted', () => {
    withAllowlist(['eagle-admin-console'], () => {
      assert.strictEqual(isAllowedClient(tokenFrom('eagle-admin-console', ['staff'])), true);
    });
  });

  await t.test('an unlisted azp is refused', () => {
    withAllowlist(['eagle-admin-console'], () => {
      assert.strictEqual(isAllowedClient(tokenFrom('some-other-app', ['sysadmin'])), false);
    });
  });

  await t.test('client_id is accepted as an alias for azp', () => {
    withAllowlist(['known'], () => {
      assert.strictEqual(isAllowedClient({ client_id: 'known', realm_access: { roles: ['sysadmin'] } }), true);
    });
  });

  await t.test('a token with no azp is refused when the list is on', () => {
    withAllowlist(['known'], () => {
      assert.strictEqual(isAllowedClient({ realm_access: { roles: ['sysadmin'] } }), false);
    });
  });
});

test('an unlisted client gets 401, not a demoted identity', async (t) => {
  t.afterEach(() => {
    t.mock.restoreAll();
    config.keycloakEnabled = true;
  });

  config.keycloakEnabled = true;
  t.mock.method(jwt, 'decode', () => ({ header: { kid: 'key-id' } }));
  t.mock.method(jwt, 'verify', (token, getKey, options, callback) => {
    callback(null, tokenFrom('some-other-app', ['sysadmin', 'staff', 'public']));
  });

  const req = { header: (name) => (name === 'Authorization' ? 'Bearer mock-token' : null) };

  let failure = null;
  let successRan = false;

  withAllowlist(['eagle-admin-console'], () => {
    authenticate(
      req,
      () => { successRan = true; },
      (status, message) => { failure = { status, message }; }
    );
  });

  assert.strictEqual(successRan, false, 'a refused client must never reach onSuccess');
  assert.strictEqual(failure.status, 401);
  assert.strictEqual(failure.message, 'Unauthorized. Client is not permitted to call this API.');
});
