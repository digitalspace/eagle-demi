'use strict';

/**
 * The public config seeder.
 *
 * No network and no Cosmos: the source fetch and the repository are injected, so what is asserted
 * is the part that decides what lands in a document an anonymous site reads — the filter, the
 * environment the payload is read FROM, and that a dry run writes nothing.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  DEFAULT_CONFIG_URLS, parseArgs, eagleConfigUrl, buildDocument, seed
} = require('../../src/scripts/seed-public-config');
const { PUBLIC_KEYS } = require('../../src/controllers/config');

/** eagle-api's live /api/config, shortened: allowlisted keys plus the ones DEMI must not store. */
const EAGLE_PAYLOAD = {
  ENVIRONMENT: 'test',
  BANNER_COLOUR: 'orange',
  API_PATH: '/api',
  SEARCH_API_PATH: '/demi-search',
  DEMI_PROJECTS_PATH: '/demi-projects',
  ADMIN_PATH: '/admin',
  ACCESS_GATE: true,
  SHOW_SURVEY_BANNER: false,
  KEYCLOAK_URL: 'https://test.loginproxy.gov.bc.ca/auth',
  KEYCLOAK_CLIENT_ID: 'eagle-admin-console',
  ANALYTICS_API_URL: '',
  BUILD_ID: 'abc1234',
  API_LOCATION: ''
};

function stubRepository(existing = null) {
  const upserts = [];
  return {
    upserts,
    getPublic: async () => existing,
    upsertPublic: async (doc) => { upserts.push(doc); return { id: 'public', ...doc }; }
  };
}

const deps = (repository) => ({ fetchJson: async () => EAGLE_PAYLOAD, repository });

test('seed-public-config', async (t) => {
  t.afterEach(() => { delete process.env.EAGLE_CONFIG_URL; });

  await t.test('stores only the keys the controller will serve', () => {
    const doc = buildDocument(EAGLE_PAYLOAD);

    assert.equal(doc.SEARCH_API_PATH, '/demi-search');
    // The public site does not log in, and BUILD_ID has to keep coming from the deploy package.
    assert.ok(!('KEYCLOAK_URL' in doc));
    assert.ok(!('KEYCLOAK_CLIENT_ID' in doc));
    assert.ok(!('BUILD_ID' in doc));
    assert.ok(!('API_LOCATION' in doc));
    assert.ok(!('ANALYTICS_API_URL' in doc));
    for (const key of Object.keys(doc)) {
      assert.ok(PUBLIC_KEYS.includes(key), `${key} is not in PUBLIC_KEYS`);
    }
  });

  await t.test('a false value is stored, an absent one is not', () => {
    const doc = buildDocument({ ENVIRONMENT: 'test', ACCESS_GATE: false, SURVEY_URL: null });

    assert.equal(doc.ACCESS_GATE, false);
    assert.ok(!('SURVEY_URL' in doc), 'a null would become a value the public site has to interpret');
    assert.ok(!('CONTENT_SEARCH' in doc));
  });

  await t.test('reads the environment it is running in, not a flag', () => {
    assert.equal(eagleConfigUrl('test'), DEFAULT_CONFIG_URLS.test);
    assert.equal(eagleConfigUrl('prod'), DEFAULT_CONFIG_URLS.prod);
    assert.equal(eagleConfigUrl('dev'), DEFAULT_CONFIG_URLS.dev);
    assert.match(DEFAULT_CONFIG_URLS.prod, /^https:\/\/projects\.eao\.gov\.bc\.ca\//);
  });

  await t.test('an unknown environment throws instead of falling back to dev', () => {
    // Seeding prod's container from the dev payload would publish dev paths to the public site
    // and look like it worked.
    assert.throws(() => eagleConfigUrl('staging'), /EAGLE_CONFIG_URL/);
  });

  await t.test('EAGLE_CONFIG_URL overrides the default', () => {
    process.env.EAGLE_CONFIG_URL = 'https://eagle-test.example/api/config';
    assert.equal(eagleConfigUrl('prod'), 'https://eagle-test.example/api/config');
  });

  await t.test('parses its flags', () => {
    assert.deepEqual(parseArgs([]), { live: false, force: false });
    assert.deepEqual(parseArgs(['--live', '--force']), { live: true, force: true });
  });

  await t.test('a dry run writes nothing', async () => {
    const repository = stubRepository();

    const result = await seed([], deps(repository));

    assert.equal(result.written, false);
    assert.equal(repository.upserts.length, 0, 'a dry run reached the database');
    assert.equal(result.document.SEARCH_API_PATH, '/demi-search');
  });

  await t.test('--live writes the filtered document', async () => {
    const repository = stubRepository();

    const result = await seed(['--live'], deps(repository));

    assert.equal(result.written, true);
    assert.equal(repository.upserts.length, 1);
    assert.ok(!('BUILD_ID' in repository.upserts[0]));
    assert.equal(repository.upserts[0].ACCESS_GATE, true);
  });

  await t.test('an existing document is not overwritten without --force', async () => {
    const repository = stubRepository({ id: 'public', ENVIRONMENT: 'test' });

    const result = await seed(['--live'], deps(repository));

    assert.equal(result.written, false);
    assert.equal(repository.upserts.length, 0);

    const forced = await seed(['--live', '--force'], deps(repository));
    assert.equal(forced.written, true);
    assert.equal(repository.upserts.length, 1);
  });

  await t.test('refuses a response that is not an eagle-api config payload', async () => {
    // An rproxy that falls through to the SPA answers 200; a JSON error envelope parses fine and
    // would otherwise be filtered down to an empty document the controller then serves.
    const repository = stubRepository();

    await assert.rejects(
      seed(['--live'], { fetchJson: async () => ({ error: 'not found' }), repository }),
      /ENVIRONMENT/);
    assert.equal(repository.upserts.length, 0);
  });
});
