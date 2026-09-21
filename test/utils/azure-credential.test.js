'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ManagedIdentityCredential, DefaultAzureCredential } = require('@azure/identity');
const { createCredential } = require('../../src/utils/azure-credential');

// Constructing a credential makes no network call, so the real classes are safe to build here.
const CLIENT_ID = '00000000-0000-0000-0000-000000000001';

test('App Service or Functions host with a client id uses the managed identity alone', () => {
  const credential = createCredential({
    AZURE_CLIENT_ID: CLIENT_ID,
    IDENTITY_ENDPOINT: 'http://localhost:8081/msi/token'
  });
  assert.ok(credential instanceof ManagedIdentityCredential);
});

test('devbox VM (client id, no IDENTITY_ENDPOINT) keeps the default chain', () => {
  assert.ok(createCredential({ AZURE_CLIENT_ID: CLIENT_ID }) instanceof DefaultAzureCredential);
});

test('local az login (nothing set) keeps the default chain', () => {
  assert.ok(createCredential({}) instanceof DefaultAzureCredential);
});

test('host identity endpoint without a client id keeps the default chain', () => {
  const credential = createCredential({ IDENTITY_ENDPOINT: 'http://localhost:8081/msi/token' });
  assert.ok(credential instanceof DefaultAzureCredential);
});
