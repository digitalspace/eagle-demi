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

  await t.test('an unrecognised ENVIRONMENT with no DEMI_ALLOWED_CLIENTS refuses to boot', () => {
    // The guard is deny-unless-dev: a new environment name must not admit the whole realm.
    assert.throws(() => loadConfig('staging', undefined), /DEMI_ALLOWED_CLIENTS/);
  });

  await t.test('ENVIRONMENT=dev boots with none', () => {
    const config = loadConfig('dev', undefined);
    assert.deepStrictEqual(config.allowedClients, []);
    assert.strictEqual(config.environmentName, 'dev');
  });
});

test('TRUSTED_PROXY_IPS refuses anything that is not an IPv4 address or CIDR block', () => {
  const configPath = path.resolve(__dirname, '..', 'src', 'config.js');
  const previous = process.env.TRUSTED_PROXY_IPS;
  try {
    // A malformed entry can never match a proxy, so a typo would silently put every visitor back
    // on one shared quota key. Load must fail instead.
    process.env.TRUSTED_PROXY_IPS = '142.34.194.121,not-an-ip';
    delete require.cache[configPath];
    assert.throws(() => require(configPath), /TRUSTED_PROXY_IPS must be a comma list/);

    process.env.TRUSTED_PROXY_IPS = '142.34.194.121, 10.0.0.0/8';
    delete require.cache[configPath];
    assert.deepStrictEqual(require(configPath).trustedProxyIps, ['142.34.194.121', '10.0.0.0/8']);
  } finally {
    if (previous === undefined) delete process.env.TRUSTED_PROXY_IPS; else process.env.TRUSTED_PROXY_IPS = previous;
    delete require.cache[configPath];
  }
});
