'use strict';

process.env.NODE_ENV = 'test';
// Set before ai-search reads it: with no endpoint searchDocumentIds throws before any request.
process.env.SEARCH_ENDPOINT = 'https://demi-search-test.search.windows.net';

const test = require('node:test');
const assert = require('node:assert');

const { documentsAcl, NOT_UPDATE_IMAGE } = require('../../src/search/document-query');
const eagleQuery = require('../../src/search/eagle-query');
const aiSearch = require('../../src/search/ai-search');
const { TIER } = require('../../src/helpers/access-sql');

// Keeps the token lookup off the network; DefaultAzureCredential would hang in CI rather than fail.
const { DefaultAzureCredential } = require('@azure/identity');
DefaultAzureCredential.prototype.getToken = async () => ({
  token: 'test-token',
  expiresOnTimestamp: Date.now() + 60 * 60 * 1000
});

/** Answers every search request with `json`, and records each request body. */
function captureSearch(t, json) {
  const bodies = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => json,
      text: async () => JSON.stringify(json)
    };
  };
  t.after(() => { global.fetch = originalFetch; });
  return bodies;
}

const anonymous = { tier: TIER.PUBLIC, roles: ['public'], projectScope: null, teams: [] };

test('NOT_UPDATE_IMAGE keeps legacy rows by comparing ne, not eq', () => {
  assert.strictEqual(NOT_UPDATE_IMAGE, "documentSource ne 'UPDATE'");
});

test('a Document filter without documentSource carries the update-image clause', () => {
  const { filter } = eagleQuery.buildFilter({}, 'Document', documentsAcl(anonymous), anonymous);
  assert.ok(filter.includes(NOT_UPDATE_IMAGE), filter);
});

test('documentsAcl compares a document-scoped grant on the index key id', () => {
  const access = {
    ...anonymous,
    credentials: [{ scope: { type: 'document', ids: ['d9'] }, levels: [2] }]
  };
  const { filter } = documentsAcl(access);
  assert.ok(filter.includes("search.in(id, 'd9', ',')"), filter);
  assert.ok(!filter.includes('documentId'), filter);
});

test('searchDocumentIds with no keywords sends matchAll and returns ranked ids', async (t) => {
  const bodies = captureSearch(t, { '@odata.count': 742, value: [{ id: 'b' }, { id: 'a' }] });

  const out = await aiSearch.searchDocumentIds({
    filter: "projectId eq 'p1'", orderby: 'datePosted desc, id', top: 10, skip: 290
  });

  assert.deepStrictEqual(out.ids, ['b', 'a']);
  assert.strictEqual(out.count, 742);
  const [body] = bodies;
  assert.strictEqual(body.search, '*');
  assert.strictEqual(body.select, 'id');
  assert.strictEqual(body.searchFields, aiSearch.DOCUMENT_SEARCH_FIELDS);
  assert.strictEqual(body.filter, "projectId eq 'p1'");
  assert.strictEqual(body.orderby, 'datePosted desc, id');
  assert.strictEqual(body.top, 10);
  assert.strictEqual(body.skip, 290);
  assert.strictEqual(body.count, true);
  assert.strictEqual(body.highlight, undefined);
});

test('searchDocumentIds with keywords runs one leg over the document fields only', async (t) => {
  const bodies = captureSearch(t, { '@odata.count': 1, value: [{ id: 'd1' }] });

  await aiSearch.searchDocumentIds({ keywords: 'river', filter: "projectId eq 'p1'" });

  assert.strictEqual(bodies.length, 1, 'no project-name leg');
  assert.notStrictEqual(bodies[0].search, '*');
  assert.match(bodies[0].search, /river/);
  assert.strictEqual(bodies[0].queryType, 'full');
});
