'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const CONFIG = path.join(__dirname, '..', 'src', 'config');

// src/config.js reads the environment once at require time, so each case has to clear the module
// cache before it loads.
function loadConfig(environment, allowedClients) {
  const previousEnv = process.env.ENVIRONMENT;
  const previousList = process.env.DEMI_ALLOWED_CLIENTS;

  if (environment === undefined) delete process.env.ENVIRONMENT;
  else process.env.ENVIRONMENT = environment;

  if (allowedClients === undefined) delete process.env.DEMI_ALLOWED_CLIENTS;
  else process.env.DEMI_ALLOWED_CLIENTS = allowedClients;

  delete require.cache[require.resolve(CONFIG)];

  try {
    return require(CONFIG);
  } finally {
    if (previousEnv === undefined) delete process.env.ENVIRONMENT;
    else process.env.ENVIRONMENT = previousEnv;

    if (previousList === undefined) delete process.env.DEMI_ALLOWED_CLIENTS;
    else process.env.DEMI_ALLOWED_CLIENTS = previousList;

    delete require.cache[require.resolve(CONFIG)];
  }
}

test('DEMI_ALLOWED_CLIENTS is required in the deployed environments', async (t) => {
  await t.test('ENVIRONMENT=test with no DEMI_ALLOWED_CLIENTS refuses to boot', () => {
    assert.throws(() => loadConfig('test', undefined), /DEMI_ALLOWED_CLIENTS/);
  });

  await t.test('ENVIRONMENT=prod with no DEMI_ALLOWED_CLIENTS refuses to boot', () => {
    assert.throws(() => loadConfig('prod', undefined), /DEMI_ALLOWED_CLIENTS/);
  });

  await t.test('an empty string is the same as unset', () => {
    // The bicep app setting is always present; the failure mode is a blank value, not a missing key.
    assert.throws(() => loadConfig('test', ''), /DEMI_ALLOWED_CLIENTS/);
  });

  await t.test('ENVIRONMENT=test boots with a client named', () => {
    const config = loadConfig('test', 'eagle-admin-console');
    assert.deepStrictEqual(config.allowedClients, ['eagle-admin-console']);
  });

  await t.test('ENVIRONMENT=dev boots with none', () => {
    const config = loadConfig('dev', undefined);
    assert.deepStrictEqual(config.allowedClients, []);
    assert.strictEqual(config.environmentName, 'dev');
  });
});
