'use strict';

/**
 * putDataSources() PUTs the committed Cosmos data sources on the search service.
 *
 * POST /admin/search-definitions/apply now calls this in process, so a bad PUT has to throw rather
 * than print and carry on — a job that reported success without writing what was asked for is the
 * failure worth pinning. The body it sends is the other one: the connection string and identity are
 * what let the indexers read Cosmos without a key.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const aiSearch = require('../../src/search/ai-search');
const { putDataSources } = require('../../src/scripts/put-search-datasources');

// Placeholders shaped like the real ids, never the real ones: this repo is public.
const SUB = '00000000-0000-0000-0000-000000000000';
const IDENTITY = `/subscriptions/${SUB}/resourceGroups/rg-fake/providers/` +
  'Microsoft.ManagedIdentity/userAssignedIdentities/demi-identity-fake';
const ENV = {
  SEARCH_ENDPOINT: 'https://demi-search-fake.search.windows.net/',
  COSMOS_ENDPOINT: 'https://demi-cosmos-fake.documents.azure.com:443/',
  COSMOS_NOSQL_DATABASE: 'demi',
  DS_SUB: SUB,
  DS_RG: 'rg-fake',
  DS_IDENTITY_ID: IDENTITY
};

// Two committed data sources, in their own directory, so "which ones were written" is unambiguous.
const DS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'demi-datasources-'));
for (const name of ['demi-chunks-ds', 'demi-projects-ds']) {
  fs.writeFileSync(path.join(DS_DIR, `${name}.json`), JSON.stringify({
    name,
    '@odata.etag': '"stale"',
    type: 'cosmosdb',
    container: { name: name.slice('demi-'.length, -'-ds'.length) }
  }));
}
Object.assign(process.env, ENV, { DS_DIR });

/** The search service, replaced: every PUT is recorded, and answered with `status`. */
function service(t, { status = 201 } = {}) {
  const puts = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    puts.push({ url, method: init.method, body: JSON.parse(init.body) });
    return { status, text: async () => 'service body' };
  };
  t.after(() => { globalThis.fetch = original; });
  t.mock.method(aiSearch, 'getToken', async () => 'token');
  return puts;
}

const silent = () => {};

test('put-search-datasources', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('writes every committed data source when no names are given', async (t) => {
    const puts = service(t);

    const written = await putDataSources({ log: silent });

    assert.strictEqual(written, 2);
    assert.deepStrictEqual(puts.map(p => p.body.name), ['demi-chunks-ds', 'demi-projects-ds']);
    assert.deepStrictEqual(puts.map(p => p.method), ['PUT', 'PUT']);
  });

  await t.test('writes only the named data sources', async (t) => {
    const puts = service(t);

    const written = await putDataSources({ names: ['demi-projects-ds'], log: silent });

    assert.strictEqual(written, 1);
    assert.deepStrictEqual(puts.map(p => p.body.name), ['demi-projects-ds']);
  });

  await t.test('points the data source at Cosmos through the search identity', async (t) => {
    const puts = service(t);

    await putDataSources({ names: ['demi-chunks-ds'], log: silent });

    assert.strictEqual(puts[0].body.credentials.connectionString,
      `ResourceId=/subscriptions/${SUB}/resourceGroups/rg-fake/providers/Microsoft.DocumentDB` +
      '/databaseAccounts/demi-cosmos-fake;Database=demi;IdentityAuthType=AccessToken');
    assert.strictEqual(puts[0].body.identity.userAssignedIdentity, IDENTITY);
    // A PUT carrying the etag of the copy on disk is refused once the live one has moved on.
    assert.strictEqual(puts[0].body['@odata.etag'], undefined);
  });

  await t.test('throws on a name no committed data source matches', async (t) => {
    service(t);

    await assert.rejects(
      () => putDataSources({ names: ['demi-typo-ds'], log: silent }),
      /no committed data source named demi-typo-ds/);
  });

  await t.test('throws when the service refuses the PUT', async (t) => {
    service(t, { status: 403 });

    await assert.rejects(
      () => putDataSources({ names: ['demi-chunks-ds'], log: silent }),
      /PUT \/datasources\/demi-chunks-ds -> 403/);
  });

  await t.test('throws when an env var the body is built from is missing', async (t) => {
    const identityId = process.env.DS_IDENTITY_ID;
    t.after(() => { process.env.DS_IDENTITY_ID = identityId; });
    delete process.env.DS_IDENTITY_ID;

    await assert.rejects(
      () => putDataSources({ log: silent }),
      /DS_IDENTITY_ID not set/);
  });
});
