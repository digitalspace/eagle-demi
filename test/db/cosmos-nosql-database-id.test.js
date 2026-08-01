'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

// The Mongo-API client is gone, but COSMOS_DATABASE=epic remains set on the deployed app until
// the app settings are cleaned up with the account. The NoSQL client must keep ignoring it.
//
// Why this test outlives the layer it was written for: setting COSMOS_DATABASE=demi for the
// NoSQL client once silently repointed the LIVE legacy app at the new, empty database, and every
// endpoint answered [] with HTTP 200. The lesson is that this client owns its OWN variable.

const load = (env) => {
  const key = require.resolve('../../src/db/cosmos-nosql');
  delete require.cache[key];
  const prev = { ...process.env };
  Object.assign(process.env, env);
  try {
    return require('../../src/db/cosmos-nosql').DATABASE_ID;
  } finally {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    delete require.cache[key];
  }
};

test('the NoSQL database name cannot collide with the legacy one', async (t) => {
  await t.test('defaults to demi with nothing set', () => {
    assert.strictEqual(load({}), 'demi');
  });

  await t.test('COSMOS_DATABASE does NOT influence it', () => {
    // Still set to `epic` on the deployed app; reading it here would point this client at a
    // database that does not exist under the NoSQL account.
    assert.strictEqual(load({ COSMOS_DATABASE: 'epic' }), 'demi');
  });

  await t.test('its own variable overrides', () => {
    assert.strictEqual(load({ COSMOS_NOSQL_DATABASE: 'demi-test' }), 'demi-test');
  });
});
