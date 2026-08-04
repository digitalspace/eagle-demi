'use strict';

process.env.NODE_ENV = 'test';
// Set before the module reads it. Without an endpoint every call short-circuits to empty, which
// would make these tests pass while asserting nothing.
process.env.SEARCH_ENDPOINT = 'https://demi-search-test.search.windows.net';
process.env.SEARCH_INDEX = 'demi-chunks';

const test = require('node:test');
const assert = require('node:assert');

const aiSearch = require('../../src/search/ai-search');

/**
 * Replace global.fetch and the token call.
 *
 * The token is stubbed by pre-seeding the module's credential path — the tests never touch Entra,
 * and a real credential lookup in CI would hang rather than fail.
 */
function captureFetch(t, responder) {
  const calls = [];
  const originalFetch = global.fetch;

  global.fetch = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    const result = responder(calls.length - 1);
    return {
      ok: result.ok !== false,
      status: result.status || 200,
      json: async () => result.json || {},
      text: async () => JSON.stringify(result.json || {})
    };
  };

  t.after(() => { global.fetch = originalFetch; });
  return calls;
}

// The credential is only constructed on a cache miss, so seeding a live token keeps every test
// off the network. Mirrors what DefaultAzureCredential would have returned.
function stubToken() {
  const { DefaultAzureCredential } = require('@azure/identity');
  DefaultAzureCredential.prototype.getToken = async () => ({
    token: 'test-token',
    expiresOnTimestamp: Date.now() + 60 * 60 * 1000
  });
}
stubToken();

test('ai-search query construction', async (t) => {
  await t.test('fuzzy emits (term OR term~1) per term, ANDed', () => {
    assert.strictEqual(aiSearch.buildQuery(['peace', 'river'], true),
      '(peace OR peace~1) AND (river OR river~1)');
  });

  // The OR is not redundant: a fuzzy term bypasses the query analyzer, so the plain term is what
  // carries stemming through en.microsoft.
  await t.test('non-fuzzy emits bare terms', () => {
    assert.strictEqual(aiSearch.buildQuery(['peace', 'river'], false), 'peace AND river');
  });

  // Measured on the live corpus: "the and of" with fuzzy on returned a full page of OCR noise
  // (`the~1` matched a scanned "th"), because a fuzzy term skips the analyzer and so skips
  // stopword removal too. The same query with fuzzy off returned 0.
  await t.test('short terms are never fuzzed, even when fuzzy is requested', () => {
    assert.strictEqual(aiSearch.buildQuery(['the', 'and', 'of'], true), 'the AND and AND of');
    assert.strictEqual(aiSearch.buildQuery(['the', 'river'], true), 'the AND (river OR river~1)');
  });

  // queryType 'full' makes +, -, *, ", ~, ( ) and : operators. An unbalanced one is a 400, not a
  // search for that character, so nothing but letters and digits may reach the query.
  await t.test('tokenize strips every Lucene operator', () => {
    // OR/AND survive tokenize as WORDS — it splits on punctuation and cannot strip a word. They
    // are demoted to terms by buildQuery instead; see the reserved-word test below.
    assert.deepStrictEqual(aiSearch.tokenize('river) OR *:* AND "x"'), ['river', 'OR', 'AND', 'x']);
    assert.deepStrictEqual(aiSearch.tokenize('  !!! '), []);
    assert.deepStrictEqual(aiSearch.tokenize('rivière québec'), ['rivière', 'québec'],
      'accented letters must survive or French place names become unsearchable');
  });

  // Found by the first real run of score-retrieval.js against the live index, on a corpus phrase:
  // "EAST TOBA AND MONTROSE HYDROELECTRIC PROJECT" came back
  // `Failed to parse query string at line 1, column 42` — column 42 is exactly where the bare AND
  // lands. Any public query containing a standalone AND/OR/NOT was answering HTTP 400.
  await t.test('reserved boolean words are demoted to terms, not left as operators', () => {
    assert.strictEqual(aiSearch.buildQuery(['EAST', 'TOBA', 'AND', 'MONTROSE'], false),
      'EAST AND TOBA AND and AND MONTROSE');
    assert.strictEqual(aiSearch.buildQuery(['OR', 'NOT'], false), 'or AND not');
    // Lowercase forms were never operators and must be left alone.
    assert.strictEqual(aiSearch.buildQuery(['and', 'or'], false), 'and AND or');
    // Demotion must survive fuzzing too — these are all under MIN_FUZZY_LENGTH, so the point is
    // that the operator never reappears once fuzzy expansion is on.
    assert.strictEqual(aiSearch.buildQuery(['river', 'AND', 'creek'], true),
      '(river OR river~1) AND and AND (creek OR creek~1)');
  });

  // The outer join is the suspect behind recall@10 ≈ 0.5: every term mandatory caps recall before
  // BM25 ranks anything. `anyTerms` is the paired arm of that experiment; the DEFAULT staying AND
  // is what the two assertions above pin.
  await t.test('anyTerms swaps only the OUTER join', () => {
    assert.strictEqual(aiSearch.buildQuery(['peace', 'river'], false, false, true),
      'peace OR river');
    // The per-term (t OR t~1) group is a different OR and must survive intact — flattening it
    // would change what fuzzy means, not just how terms combine.
    assert.strictEqual(aiSearch.buildQuery(['peace', 'river'], true, false, true),
      '(peace OR peace~1) OR (river OR river~1)');
    // Operator demotion has to hold in this arm too. A naive replace() on the joined string is the
    // obvious wrong implementation and would turn the demoted `and` back into an operator.
    assert.strictEqual(aiSearch.buildQuery(['river', 'AND', 'creek'], false, false, true),
      'river OR and OR creek');
  });

  // Measured 2026-08-04: the label "Sediments from the proposed Lodgepole mine will move
  // downstream and accumulate" returned 0 hits with fuzzy on and 1 with fuzzy off, against a chunk
  // holding the sentence verbatim. `mine` and `from` are removed by en.microsoft, so `mine~1`
  // demanded a literal the index does not hold and the AND join zeroed the whole query.
  await t.test('analyzer stopwords get no unanalyzed variant', () => {
    assert.strictEqual(aiSearch.buildQuery(['sediments', 'from', 'mine'], true),
      '(sediments OR sediments~1) AND from AND mine');
    // The plain term must SURVIVE — it analyzes away and is dropped harmlessly. Removing the term
    // outright would be a different change, and one that alters what the user asked for.
    assert.ok(aiSearch.buildQuery(['from'], true).includes('from'));
    // Case-insensitive: labels are full of sentence-cased and ALL-CAPS text.
    assert.strictEqual(aiSearch.buildQuery(['With', 'THOSE'], true), 'With AND THOSE');
    // A non-stopword of the same length still fuzzes, or the fix would be a blanket disable.
    assert.strictEqual(aiSearch.buildQuery(['mine', 'lake'], true), 'mine AND (lake OR lake~1)');
  });

  await t.test('term count is capped', () => {
    const many = Array.from({ length: 40 }, (_, i) => `t${i}`).join(' ');
    assert.strictEqual(aiSearch.tokenize(many).length, 16);
  });
});

test('ai-search snippets are escaped before they are marked', async (t) => {
  // THE security test for this module. Chunk text comes from arbitrary uploaded PDFs and the
  // frontend renders the snippet with [innerHTML], so the only tag allowed to survive is the
  // <mark> this layer adds itself.
  await t.test('document markup cannot reach the DOM as markup', () => {
    const snippet = aiSearch.snippetFrom({
      '@search.highlights': {
        content: [`The <script>alert(1)</script> ${aiSearch.HL_PRE}river${aiSearch.HL_POST} & "peace"`]
      }
    });

    assert.ok(!snippet.includes('<script>'), 'document text must not reach the DOM as markup');
    assert.ok(snippet.includes('&lt;script&gt;'));
    assert.ok(snippet.includes('&amp;'), 'entities survive intact');
    assert.ok(snippet.includes('<mark>river</mark>'), 'only our own marks are real tags');
  });

  await t.test('no highlight yields an empty snippet, never chunk text', () => {
    assert.strictEqual(aiSearch.snippetFrom({}), '');
    assert.strictEqual(aiSearch.snippetFrom({ '@search.highlights': { content: [] } }), '');
  });

  // Measured on the live index: a fragment is a window cut out of the chunk, and the cut can land
  // INSIDE a highlight. One came back carrying a closing sentinel whose opener had been trimmed,
  // which rendered as a stray `</mark>` in an [innerHTML] binding.
  await t.test('a fragment cut inside a highlight still yields balanced tags', () => {
    const orphanClose = aiSearch.snippetFrom({
      '@search.highlights': { content: [`Injected${aiSearch.HL_POST}: rest of the text`] }
    });
    assert.ok(!orphanClose.includes('</mark>'), 'an orphaned closer is dropped, not emitted');
    assert.ok(orphanClose.startsWith('Injected'));

    const orphanOpen = aiSearch.snippetFrom({
      '@search.highlights': { content: [`text ${aiSearch.HL_PRE}river`] }
    });
    assert.ok(orphanOpen.endsWith('</mark>'), 'an unclosed opener is closed at the fragment end');
    assert.strictEqual((orphanOpen.match(/<mark>/g) || []).length, 1);
    assert.strictEqual((orphanOpen.match(/<\/mark>/g) || []).length, 1);
  });

  await t.test('every fragment is balanced independently before they are joined', () => {
    const snippet = aiSearch.snippetFrom({
      '@search.highlights': {
        content: [
          `a ${aiSearch.HL_PRE}one${aiSearch.HL_POST} b`,
          `c${aiSearch.HL_POST} d`,
          `e ${aiSearch.HL_PRE}two`
        ]
      }
    });
    assert.strictEqual((snippet.match(/<mark>/g) || []).length,
      (snippet.match(/<\/mark>/g) || []).length, 'open and close counts must match');
    assert.ok(snippet.includes(' … '), 'fragments are still joined');
  });
});

test('ai-search request shape', async (t) => {
  await t.test('the ACL filter reaches the request body', async (tt) => {
    const calls = captureFetch(tt, () => ({ json: { value: [], '@odata.count': 0 } }));

    await aiSearch.searchChunks({
      filter: "read/any(r: search.in(r, 'public', ','))",
      keywords: 'river',
      fuzzy: true,
      top: 50
    });

    const { url, body } = calls[0];
    assert.ok(url.includes('/indexes/demi-chunks/docs/search'));
    assert.strictEqual(body.filter, "read/any(r: search.in(r, 'public', ','))");
    assert.strictEqual(body.queryType, 'full');
    assert.strictEqual(body.search, '(river OR river~1)');
    assert.strictEqual(body.highlight, 'content');
    assert.strictEqual(body.top, 50);
    // content is not retrievable, so the API can never ship whole chunks even by accident.
    assert.ok(!body.select.includes('content'), 'chunk text must not be requested');
  });

  // buildQuery is exported, but runSearch calls it INTERNALLY — monkey-patching the export proves
  // nothing about what leaves the process. Only the wire body proves the opt is threaded, and a
  // scorecard run against an unthreaded flag would report the baseline twice under two names.
  await t.test('anyTerms reaches the wire as an OR join', async (tt) => {
    const calls = captureFetch(tt, () => ({ json: { value: [] } }));
    await aiSearch.searchChunks({ filter: null, keywords: 'peace river', anyTerms: true });
    assert.strictEqual(calls[0].body.search, 'peace OR river');
    assert.strictEqual(calls[0].body.queryType, 'full');
  });

  // A null filter means "privileged"; an EMPTY filter would mean unrestricted too, so the field
  // must be absent rather than empty — this pins that it is never sent as ''.
  await t.test('a null filter omits the field entirely', async (tt) => {
    const calls = captureFetch(tt, () => ({ json: { value: [] } }));
    await aiSearch.searchChunks({ filter: null, keywords: 'river' });
    assert.ok(!('filter' in calls[0].body));
  });

  await t.test('no usable terms means no request at all', async (tt) => {
    const calls = captureFetch(tt, () => ({ json: { value: [] } }));
    const res = await aiSearch.searchChunks({ filter: null, keywords: '  !!!  ' });
    assert.deepStrictEqual(res, { items: [], count: 0 });
    assert.strictEqual(calls.length, 0, 'must not reach the service');
  });

  // A 403 (missing data-plane role) returns a JSON body that looks like any other response.
  // Reading only the body is how a permissions failure gets reported as an empty corpus.
  await t.test('a non-2xx response throws rather than reading as empty', async (tt) => {
    captureFetch(tt, () => ({ ok: false, status: 403, json: { error: { message: 'forbidden' } } }));
    await assert.rejects(
      () => aiSearch.searchChunks({ filter: null, keywords: 'river' }),
      /HTTP 403/
    );
  });
});

test('ai-search delete propagation', async (t) => {
  // The indexer's _ts high-water mark cannot see deletes, so this call is the ONLY thing that
  // removes a deleted document's text from search.
  await t.test('keys are read back from the index, never re-derived', async (tt) => {
    const calls = captureFetch(tt, (i) => i === 0
      ? { json: { value: [{ id: 'KEY-A' }, { id: 'KEY-B' }], '@odata.count': 2 } }
      : { json: { value: [{ key: 'KEY-A', status: true }, { key: 'KEY-B', status: true }] } });

    const removed = await aiSearch.deleteChunksForDocument('d1');

    assert.strictEqual(removed, 2);
    assert.strictEqual(calls[0].body.filter, "documentId eq 'd1'");
    assert.strictEqual(calls[0].body.select, 'id');
    assert.ok(calls[1].url.includes('/docs/index'));
    assert.deepStrictEqual(calls[1].body.value, [
      { '@search.action': 'delete', id: 'KEY-A' },
      { '@search.action': 'delete', id: 'KEY-B' }
    ]);
  });

  await t.test('nothing indexed means no delete call', async (tt) => {
    const calls = captureFetch(tt, () => ({ json: { value: [], '@odata.count': 0 } }));
    assert.strictEqual(await aiSearch.deleteChunksForDocument('d1'), 0);
    assert.strictEqual(calls.length, 1, 'the search happened; the delete did not');
  });

  // Best-effort by design: the Cosmos rows are already gone and the caller already succeeded,
  // so a failure here must not turn a successful delete into a 500.
  await t.test('a failure is reported, not thrown', async (tt) => {
    captureFetch(tt, () => ({ ok: false, status: 500, json: {} }));
    assert.strictEqual(await aiSearch.deleteChunksForDocument('d1'), 0);
  });

  await t.test('a hostile document id cannot escape the filter literal', async (tt) => {
    const calls = captureFetch(tt, () => ({ json: { value: [] } }));
    await aiSearch.deleteChunksForDocument("d1' or id ne '");
    assert.strictEqual(calls[0].body.filter, "documentId eq 'd1'' or id ne '''");
  });
});
