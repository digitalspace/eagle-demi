'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

// The two data layers run side by side until cutover and need DIFFERENT database names:
// `epic` for the Mongo-API client, `demi` for the NoSQL one. They must therefore not read the
// same environment variable.
//
// Setting COSMOS_DATABASE=demi for the NoSQL client silently repointed the LIVE legacy app at
// the new, empty database. Every endpoint returned [] with HTTP 200, because queryContainer
// swallows the error rather than surfacing it.

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
    // The legacy client owns that variable and needs `epic`.
    assert.strictEqual(load({ COSMOS_DATABASE: 'epic' }), 'demi');
  });

  await t.test('its own variable overrides', () => {
    assert.strictEqual(load({ COSMOS_NOSQL_DATABASE: 'demi-test' }), 'demi-test');
  });

  await t.test('the two modules read different variables', () => {
    const legacy = fs.readFileSync(require.resolve('../../src/db/cosmos'), 'utf8');
    const nosql = fs.readFileSync(require.resolve('../../src/db/cosmos-nosql'), 'utf8');

    const legacyReads = /process\.env\.COSMOS_DATABASE\b/.test(legacy);
    const nosqlReads = /process\.env\.COSMOS_DATABASE\b/.test(nosql);

    assert.ok(legacyReads, 'sanity: the legacy client still reads COSMOS_DATABASE');
    assert.ok(!nosqlReads,
      'the NoSQL client must not read COSMOS_DATABASE — it would repoint the live legacy app');
  });
});
