'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../../src/config');
const { useConfig } = require('./use-config');

test('useConfig sets the overrides inside one test and restores them after it', async (t) => {
  const before = { realm: config.keycloakRealm, clientId: config.keycloakClientId };

  await t.test('inside the test the overrides hold', (t) => {
    useConfig(t, { keycloakRealm: 'suite-realm', keycloakClientId: 'suite-client' });
    assert.strictEqual(config.keycloakRealm, 'suite-realm');
    assert.strictEqual(config.keycloakClientId, 'suite-client');
  });

  assert.strictEqual(config.keycloakRealm, before.realm);
  assert.strictEqual(config.keycloakClientId, before.clientId);
});
