'use strict';

process.env.NODE_ENV = 'test';
process.env.SEARCH_ENDPOINT = 'https://demi-search-test.search.windows.net';

const test = require('node:test');
const assert = require('node:assert');

const aiSearch = require('../../src/search/ai-search');
const { captureFetch, stubToken } = require('../helpers/capture-fetch');

stubToken();

// With no searchFields the service scores every searchable field, so a second chunk field would
// rescore every passage query the moment the index gains it.
test('a chunk search without a stop word searches content only', async (t) => {
  const calls = captureFetch(t, () => ({ json: { value: [], '@odata.count': 0 } }));

  await aiSearch.searchChunks({ filter: null, keywords: 'river' });

  assert.strictEqual(calls[0].body.searchFields, 'content');
});

// en.microsoft drops `mine` from `content`, so only the standard.lucene copy can match it.
test('a chunk search with a stop word searches and highlights the copy too', async (t) => {
  const calls = captureFetch(t, () => ({ json: { value: [], '@odata.count': 0 } }));

  await aiSearch.searchChunks({ filter: null, keywords: 'Mine water' });

  assert.strictEqual(calls[0].body.searchFields, 'content,contentTokens');
  assert.strictEqual(calls[0].body.highlight, 'content,contentTokens');
});

test('a chunks index without the copy retries on content and says so', async (t) => {
  t.mock.method(require('../../src/utils/logger').logger, 'error', () => {});
  const calls = captureFetch(t, (i) => (i === 0
    ? { ok: false, status: 400, json: { error: { message:
      "Unknown field 'contentTokens' in search field list.\r\nParameter name: searchFields" } } }
    : { json: { value: [], '@odata.count': 0 } }));

  const result = await aiSearch.searchChunks({ filter: null, keywords: 'mine' });

  assert.deepStrictEqual([calls[1].body.searchFields, calls[1].body.highlight], ['content', 'content']);
  assert.deepStrictEqual(result.meta.degraded.missing, ['contentTokens']);
});
