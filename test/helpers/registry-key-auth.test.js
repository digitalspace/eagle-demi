'use strict';

/**
 * The `X-Api-Key` registry branch of `authenticate()` — the async path that owns the outcome of
 * every API-key request. The helper's parsing and verification are covered in api-key.test.js;
 * what is covered here is the wiring around them: the identity handed to the caller, the lookup
 * cache, and the usage stamp.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const apiKeys = require('../../src/repositories/api-keys');
const { generateKey } = require('../../src/helpers/api-key');
const { authenticate, forgetCachedKey } = require('../../src/helpers/auth');

function reqWith(apiKey) {
  return { header: (name) => (name === 'X-Api-Key' ? apiKey : null) };
}

/** Resolves to {user} or {status, error} — whichever callback authenticate() reaches. */
function run(apiKey) {
  return new Promise((resolve) => {
    authenticate(
      reqWith(apiKey),
      (user) => resolve({ user }),
      (status, error) => resolve({ status, error })
    );
  });
}

function stub(t, record) {
  const touched = [];
  t.mock.method(apiKeys, 'getById', async () => record);
  t.mock.method(apiKeys, 'touchLastUsed', async (keyId) => { touched.push(keyId); });
  return touched;
}

function stored(overrides = {}) {
  const { keyId, plaintext, hash } = generateKey('test');
  return {
    plaintext,
    record: {
      id: keyId,
      name: 'nrpti-importer',
      hash,
      roles: ['demi-service-read'],
      projectScope: null,
      expiresAt: null,
      revokedAt: null,
      ...overrides
    }
  };
}

test('a valid registry key authenticates as its own consumer', async (t) => {
  const { plaintext, record } = stored();
  stub(t, record);

  const { user } = await run(plaintext);

  assert.strictEqual(user.preferred_username, 'key:nrpti-importer');
  assert.strictEqual(user.keyId, record.id);
  assert.deepStrictEqual(user.realm_access.roles, ['demi-service-read']);
  forgetCachedKey(record.id);
});

test('a revoked key is rejected, and the rejection does not say which half was wrong', async (t) => {
  const { plaintext, record } = stored({ revokedAt: new Date().toISOString() });
  stub(t, record);

  const { status, error } = await run(plaintext);

  assert.strictEqual(status, 401);
  assert.match(error, /Invalid, expired or revoked/);
  forgetCachedKey(record.id);
});

test('the usage stamp is by id and happens once per cache TTL, not once per request', async (t) => {
  // It used to pass the whole cached RECORD to an upsert, which rewrote every field — including
  // putting `revokedAt: null` back from a copy cached before the revocation. Passing the id is
  // what makes the write a patch that cannot erase what it does not name, and the cache-miss
  // condition is what keeps it off the hot path of a busy consumer.
  const { plaintext, record } = stored();
  const touched = stub(t, record);

  await run(plaintext);
  await run(plaintext);
  await run(plaintext);

  assert.deepStrictEqual(touched, [record.id], 'one stamp for three requests');
  forgetCachedKey(record.id);
});

test('a key that is not ours is not looked up at all', async (t) => {
  const touched = stub(t, null);

  // No `demi_` prefix, so parseKey returns null and the break-glass comparison owns the outcome.
  const { status } = await run('some-other-service-key');

  assert.strictEqual(status, 401);
  assert.strictEqual(apiKeys.getById.mock.callCount(), 0, 'no Cosmos read for a foreign key');
  assert.deepStrictEqual(touched, []);
});
