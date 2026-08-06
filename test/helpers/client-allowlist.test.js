'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../../src/config');
const { applyClientAllowlist } = require('../../src/helpers/auth');

function tokenFrom(azp, roles) {
  return { azp, preferred_username: 'service-account-' + azp, realm_access: { roles } };
}

function withAllowlist(list, fn) {
  const previous = config.allowedClients;
  config.allowedClients = list;
  try { return fn(); } finally { config.allowedClients = previous; }
}

test('client allowlist', async (t) => {
  await t.test('empty allowlist is permissive — the shipped default must not lock anyone out', () => {
    // DEMI's own frontend and eagle-admin's staff users share this realm. Defaulting to ON would
    // have logged real users out the moment this deployed, so "empty means permissive" is the
    // behaviour under test, not an oversight.
    const token = tokenFrom('demi-frontend', ['sysadmin']);
    withAllowlist([], () => {
      assert.deepStrictEqual(applyClientAllowlist(token).realm_access.roles, ['sysadmin']);
    });
  });

  await t.test('a listed client keeps its privileges', () => {
    withAllowlist(['eagle-admin-console'], () => {
      const out = applyClientAllowlist(tokenFrom('eagle-admin-console', ['staff', 'public']));
      assert.deepStrictEqual(out.realm_access.roles, ['staff', 'public']);
    });
  });

  await t.test('an unlisted client is DEMOTED, not rejected', () => {
    // Demotion rather than 401 on purpose: a stray token should lose privileges, not break a page
    // that only ever needed public reads.
    withAllowlist(['eagle-admin-console'], () => {
      const out = applyClientAllowlist(tokenFrom('some-other-app', ['sysadmin', 'staff', 'public']));
      assert.deepStrictEqual(out.realm_access.roles, ['public']);
      assert.ok(out, 'must still return an identity');
    });
  });

  await t.test('demotion strips every SECURE_ROLE including the new read tier', () => {
    withAllowlist(['known'], () => {
      const out = applyClientAllowlist(tokenFrom('unknown', ['demi-service-read', 'demi-admin', 'compliance']));
      assert.deepStrictEqual(out.realm_access.roles, ['compliance']);
    });
  });

  await t.test('a token with no azp is treated as unlisted when the allowlist is on', () => {
    withAllowlist(['known'], () => {
      const out = applyClientAllowlist({ realm_access: { roles: ['sysadmin'] } });
      assert.deepStrictEqual(out.realm_access.roles, []);
    });
  });

  await t.test('client_id is accepted as an alias for azp', () => {
    withAllowlist(['known'], () => {
      const out = applyClientAllowlist({ client_id: 'known', realm_access: { roles: ['sysadmin'] } });
      assert.deepStrictEqual(out.realm_access.roles, ['sysadmin']);
    });
  });
});
