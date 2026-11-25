'use strict';

process.env.NODE_ENV = 'test';
process.env.SEARCH_ENDPOINT = 'https://demi-search-test.search.windows.net';

const test = require('node:test');
const assert = require('node:assert');

const aiSearch = require('../../src/search/ai-search');
const { captureFetch, stubToken } = require('../helpers/capture-fetch');

stubToken();

const PRE = aiSearch.HL_PRE;
const POST = aiSearch.HL_POST;
const answer = (hit) => () => ({ json: { value: [hit], '@odata.count': 1 } });

// en.microsoft drops `mine` as a stop word, so only the `<field>Tokens` copies match and mark it.
test('marks from the token copies', async (t) => {
  await t.test('a project matched only through nameTokens has the word marked in its name', async (tt) => {
    captureFetch(tt, answer({
      id: 'p1',
      name: 'Copper <Mine> & Mill',
      '@search.highlights': { nameTokens: [`Copper <${PRE}Mine${POST}> & Mill`] }
    }));

    const { items } = await aiSearch.searchProjects({ filter: null, keywords: 'mine' });

    assert.strictEqual(items[0].highlighted.name, 'Copper &lt;<mark>Mine</mark>&gt; &amp; Mill');
  });

  await t.test("a name's own fragments win over its nameTokens copy", async (tt) => {
    captureFetch(tt, answer({
      id: 'p1',
      name: 'Mine Water',
      '@search.highlights': {
        name: [`Mine ${PRE}Water${POST}`],
        nameTokens: [`${PRE}Mine${POST} ${PRE}Water${POST}`]
      }
    }));

    const { items } = await aiSearch.searchProjects({ filter: null, keywords: 'mine water' });

    assert.strictEqual(items[0].highlighted.name, 'Mine <mark>Water</mark>');
  });

  // The copy's fragment is a window; the row shows the whole field, marked on whole words only.
  await t.test('a document description is marked in full from a descriptionTokens fragment', async (tt) => {
    captureFetch(tt, answer({
      id: 'd1',
      displayName: 'Tailings Report',
      description: 'Tailings from the mine. Mineral water returns to the creek.',
      '@search.highlights': { descriptionTokens: [`Tailings from the ${PRE}mine${POST}.`] }
    }));

    const { items } = await aiSearch.searchDocuments({ filter: null, keywords: 'mine' });

    assert.strictEqual(items[0].highlighted.description,
      'Tailings from the <mark>mine</mark>. Mineral water returns to the creek.');
  });

  // An index the copies have not reached yet must still serve the page, not 400 on the highlight.
  await t.test('a documents index without the copies retries with neither in the highlight', async (tt) => {
    tt.mock.method(require('../../src/utils/logger').logger, 'error', () => {});
    const calls = captureFetch(tt, (i) => (i === 0
      ? { ok: false, status: 400, json: { error: { message:
        "Unknown field 'displayNameTokens' in search field list.\r\nParameter name: searchFields" } } }
      : answer({ id: 'd1' })()));

    await aiSearch.searchDocuments({ filter: null, keywords: 'mine' });

    assert.strictEqual(calls[1].body.highlight, 'displayName,description');
  });
});
