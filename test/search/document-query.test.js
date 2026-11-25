'use strict';

process.env.NODE_ENV = 'test';
// Set before ai-search reads it: with no endpoint searchDocumentIds throws before any request.
process.env.SEARCH_ENDPOINT = 'https://demi-search-test.search.windows.net';

const test = require('node:test');
const assert = require('node:assert');

const { documentsAcl, NOT_UPDATE_IMAGE, indexDocumentsNow } = require('../../src/search/document-query');
const documents = require('../../src/repositories/documents');
const eagleQuery = require('../../src/search/eagle-query');
const aiSearch = require('../../src/search/ai-search');
const { TIER } = require('../../src/helpers/access-sql');

const { captureFetch, stubToken } = require('../helpers/capture-fetch');

stubToken();

/** Answers every search request with `json` and `status`. */
const captureSearch = (t, json, status = 200) => captureFetch(t, () => ({ json, status, ok: status < 400 }));

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
  const calls = captureSearch(t, { '@odata.count': 742, value: [{ id: 'b' }, { id: 'a' }] });

  const out = await aiSearch.searchDocumentIds({
    filter: "projectId eq 'p1'", orderby: 'datePosted desc, id', top: 10, skip: 290
  });

  assert.deepStrictEqual(out.ids, ['b', 'a']);
  assert.strictEqual(out.count, 742);
  const [{ body }] = calls;
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
  const calls = captureSearch(t, { '@odata.count': 1, value: [{ id: 'd1' }] });

  await aiSearch.searchDocumentIds({ keywords: 'river', filter: "projectId eq 'p1'" });

  assert.strictEqual(calls.length, 1, 'no project-name leg');
  assert.notStrictEqual(calls[0].body.search, '*');
  assert.match(calls[0].body.search, /river/);
  assert.strictEqual(calls[0].body.queryType, 'full');
});

// A write that lands between the caller's own write and this index write must win in the index.
test('indexDocumentsNow sends the stored row, not the older one the caller holds', async (t) => {
  t.mock.method(documents, 'readForWrite', async (id, projectId) => ({ id, projectId, read: ['staff'], isDeleted: true }));
  const sent = t.mock.method(aiSearch, 'upsertIndexRows', async (_index, rows) => rows.length);

  await indexDocumentsNow([{ id: 'd1', projectId: '207', read: ['public'], isDeleted: false }]);

  assert.deepStrictEqual(sent.mock.calls.map(c => c.arguments[1].map(row => [row.id, row.read, row.isDeleted])),
    [[['d1', ['staff'], true]]]);
});

test('indexDocumentsNow reads nothing back when search is not configured', async (t) => {
  t.mock.method(aiSearch, 'config', () => ({ configured: false }));
  const read = t.mock.method(documents, 'readForWrite', async () => null);

  await indexDocumentsNow([{ id: 'd1', projectId: '207' }]);

  assert.strictEqual(read.mock.callCount(), 0);
});

test('writeAcls merges isDeleted when a row carries it', async (t) => {
  const calls = captureSearch(t, { value: [] });
  await aiSearch.writeAcls('documents', [{ id: 'd1', read: ['staff'], isPublished: false, isDeleted: true }]);
  assert.strictEqual(calls[0].body.value[0].isDeleted, true);
});

test('writeAcls logs a bad entry and counts it 0, never throws', async (t) => {
  captureSearch(t, { value: [] });
  assert.strictEqual(await aiSearch.writeAcls('documents', [null]), 0);
});

test('upsertIndexRows sends whole rows as mergeOrUpload, since merge refuses a new row', async (t) => {
  const calls = captureSearch(t, { value: [] });
  await aiSearch.upsertIndexRows('documents', [{ id: 'd1', displayName: 'Report' }]);
  assert.deepStrictEqual(calls[0].body.value, [{ '@search.action': 'mergeOrUpload', id: 'd1', displayName: 'Report' }]);
});

test('upsertIndexRows tries once, so a throttled service cannot hold a create', async (t) => {
  const calls = captureSearch(t, {}, 503);
  assert.strictEqual(await aiSearch.upsertIndexRows('documents', [{ id: 'd1' }]), 0);
  assert.strictEqual(calls.length, 1);
});
