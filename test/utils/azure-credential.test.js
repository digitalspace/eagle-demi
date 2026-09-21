'use strict';

const test = require('node:test');
const assert = require('node:assert');

const IDENTITY = require.resolve('@azure/identity');
const { createCredential } = require('../../src/utils/azure-credential');

const CLIENT_ID = '00000000-0000-0000-0000-000000000001';
const HOST_ENDPOINT = 'http://localhost:8081/msi/token';

/** Swap @azure/identity in the require cache for classes that record their constructor options. */
function recordCredentials(t) {
  const original = require.cache[IDENTITY];
  const built = [];
  const recorder = (kind) => class { constructor(options) { built.push({ kind, options }); } };
  require.cache[IDENTITY] = {
    id: IDENTITY,
    filename: IDENTITY,
    loaded: true,
    exports: {
      ManagedIdentityCredential: recorder('managed'),
      DefaultAzureCredential: recorder('default')
    }
  };
  t.after(() => {
    if (original) require.cache[IDENTITY] = original;
    else delete require.cache[IDENTITY];
  });
  return built;
}

test('App Service or Functions host with a client id uses that managed identity alone', (t) => {
  const built = recordCredentials(t);
  createCredential({ AZURE_CLIENT_ID: CLIENT_ID, IDENTITY_ENDPOINT: HOST_ENDPOINT });
  assert.deepStrictEqual(built, [{ kind: 'managed', options: { clientId: CLIENT_ID } }]);
});

test('devbox VM (client id, no IDENTITY_ENDPOINT) keeps the default chain with the client id', (t) => {
  const built = recordCredentials(t);
  createCredential({ AZURE_CLIENT_ID: CLIENT_ID });
  assert.deepStrictEqual(built, [{ kind: 'default', options: { managedIdentityClientId: CLIENT_ID } }]);
});

test('local az login (nothing set) keeps the default chain', (t) => {
  const built = recordCredentials(t);
  createCredential({});
  assert.deepStrictEqual(built, [{ kind: 'default', options: undefined }]);
});

test('host identity endpoint without a client id keeps the default chain', (t) => {
  const built = recordCredentials(t);
  createCredential({ IDENTITY_ENDPOINT: HOST_ENDPOINT });
  assert.deepStrictEqual(built, [{ kind: 'default', options: undefined }]);
});
