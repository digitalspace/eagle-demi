'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { main } = require('../../src/scripts/seed-config');

function fakeRepo(existing) {
  const store = { doc: existing };
  return {
    store,
    repo: {
      async get() { return store.doc; },
      async upsert(doc) { store.doc = doc; return doc; }
    }
  };
}

test('seed-config', async (t) => {
  t.beforeEach((tt) => tt.mock.method(console, 'log', () => {}));

  await t.test('a run without --live writes nothing', async () => {
    const { store, repo } = fakeRepo(null);
    await main([], { configRepository: repo });
    assert.strictEqual(store.doc, null);
  });

  await t.test('--live leaves an existing document alone without --force', async () => {
    const existing = { id: 'config', BANNER_COLOUR: 'sentinel' };
    const { store, repo } = fakeRepo(existing);
    await main(['--live'], { configRepository: repo });
    assert.strictEqual(store.doc, existing);
  });

  await t.test('--live --force overwrites an existing document from app settings', async () => {
    const { store, repo } = fakeRepo({ id: 'config', BANNER_COLOUR: 'sentinel' });
    await main(['--live', '--force'], { configRepository: repo });
    assert.notStrictEqual(store.doc.BANNER_COLOUR, 'sentinel');
    assert.strictEqual(typeof store.doc.KEYCLOAK_ENABLED, 'boolean');
  });
});
