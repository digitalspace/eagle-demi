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
