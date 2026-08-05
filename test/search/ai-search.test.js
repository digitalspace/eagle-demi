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
    // `throws` models a transport-level failure — the shape a request timeout arrives in, which is
    // an exception from the abort signal rather than any HTTP status.
    if (result.throws) throw result.throws;
    return {
      ok: result.ok !== false,
      status: result.status || 200,
      // Retry-After is read off the real Headers API, so the stub has to answer `get()` rather
      // than expose a plain object.
      headers: { get: (name) => (result.headers || {})[String(name).toLowerCase()] ?? null },
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
  await t.test('fuzzy emits (term OR term~1^0.5) per term, ANDed', () => {
    assert.strictEqual(aiSearch.buildQuery(['peace', 'river'], true),
      '(peace OR peace~1^0.5) AND (river OR river~1^0.5)');
  });

  await t.test('the fuzzy variant is down-weighted, and the plain term is NOT', () => {
    // Measured 2026-08-04: pooled recall@10 0.592 -> 0.620, recall@1 and MRR both up, 0 hit->miss.
    // The boost belongs on the fuzzy arm alone — the exact arm is what it exists to protect, so a
    // `^` next to the plain term would defeat the whole change.
    assert.ok(!aiSearch.buildQuery(['river'], true).includes('river^'));
  });

  await t.test('the down-weight never revives ~1 on an analyzer-removed term', () => {
    // The earlier fix: on a term en.microsoft removes, the unanalyzed ~1 side is the only matchable
    // half of the clause and acts as a near-random MANDATORY filter. Scoring it lower does not make
    // it satisfiable, so the term must still get no ~1 at all.
    assert.strictEqual(aiSearch.buildQuery(['that', 'river'], true),
      'that AND (river OR river~1^0.5)');
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
    assert.strictEqual(aiSearch.buildQuery(['the', 'river'], true), 'the AND (river OR river~1^0.5)');
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
      '(river OR river~1^0.5) AND and AND (creek OR creek~1^0.5)');
  });

  // The outer ` AND ` was the suspect behind recall@10 ≈ 0.5 and an ` OR ` arm cleared it
  // (wiki: Search-and-Retrieval). This pins that the join stayed AND — a later reader should not re-derive
  // the experiment from the absence of a knob.
  await t.test('terms are joined with AND', () => {
    assert.strictEqual(aiSearch.buildQuery(['peace', 'river'], false), 'peace AND river');
    // The per-term (t OR t~1) group is a DIFFERENT OR and must survive intact — flattening it
    // would change what fuzzy means, not just how terms combine.
    assert.strictEqual(aiSearch.buildQuery(['peace', 'river'], true),
      '(peace OR peace~1^0.5) AND (river OR river~1^0.5)');
  });

  // Measured 2026-08-04: the label "Sediments from the proposed Lodgepole mine will move
  // downstream and accumulate" returned 0 hits with fuzzy on and 1 with fuzzy off, against a chunk
  // holding the sentence verbatim. `mine` and `from` are removed by en.microsoft, so `mine~1`
  // demanded a literal the index does not hold and the AND join zeroed the whole query.
  await t.test('analyzer stopwords get no unanalyzed variant', () => {
    assert.strictEqual(aiSearch.buildQuery(['sediments', 'from', 'mine'], true),
      '(sediments OR sediments~1^0.5) AND from AND mine');
    // The plain term must SURVIVE — it analyzes away and is dropped harmlessly. Removing the term
    // outright would be a different change, and one that alters what the user asked for.
    assert.ok(aiSearch.buildQuery(['from'], true).includes('from'));
    // Case-insensitive: labels are full of sentence-cased and ALL-CAPS text.
    assert.strictEqual(aiSearch.buildQuery(['With', 'THOSE'], true), 'With AND THOSE');
    // A non-stopword of the same length still fuzzes, or the fix would be a blanket disable.
    assert.strictEqual(aiSearch.buildQuery(['mine', 'lake'], true), 'mine AND (lake OR lake~1^0.5)');
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
    assert.strictEqual(body.search, '(river OR river~1^0.5)');
    assert.strictEqual(body.highlight, 'content');
    assert.strictEqual(body.top, 50);
    // content is not retrievable, so the API can never ship whole chunks even by accident.
    assert.ok(!body.select.includes('content'), 'chunk text must not be requested');
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

  // The reason this loops at all. `top: 1000` is a page cap, not a document size — before this,
  // a document over 1000 chunks had the first page deleted and the rest left permanently
  // searchable, because the indexer's high-water mark never revisits a deleted row.
  await t.test('a document larger than one page is deleted across rounds', async (tt) => {
    const page = (n) => Array.from({ length: n }, (_, i) => ({ id: `KEY-${i}` }));
    const calls = captureFetch(tt, (i) => {
      switch (i) {
        case 0: return { json: { value: page(1000), '@odata.count': 2500 } };
        case 2: return { json: { value: page(1000), '@odata.count': 1500 } };
        case 4: return { json: { value: page(500), '@odata.count': 500 } };
        default: return { json: {} };   // the three delete calls
      }
    });

    assert.strictEqual(await aiSearch.deleteChunksForDocument('big'), 2500);
    assert.strictEqual(calls.length, 6, 'three search rounds, each followed by its delete');
    assert.ok(calls[5].url.includes('/docs/index'));
    assert.strictEqual(calls[5].body.value.length, 500);
  });

  // Deletes are not read-your-write here, so re-seeing keys is normal. A total that never falls is
  // not: it means nothing is landing, and 24 more identical rounds will not change that.
  await t.test('a round that makes no progress stops rather than looping', async (tt) => {
    const page = Array.from({ length: 1000 }, (_, i) => ({ id: `KEY-${i}` }));
    const calls = captureFetch(tt, () => ({ json: { value: page, '@odata.count': 2000 } }));

    assert.strictEqual(await aiSearch.deleteChunksForDocument('stuck'), 1000);
    assert.strictEqual(calls.length, 3, 'search, delete, then one probe that showed no progress');
  });

  await t.test('the round cap bounds a document that never drains', async (tt) => {
    // Always reports one page left and one more than it returns, so the count keeps falling and
    // the no-progress guard never fires. Only the cap can stop this.
    let remaining = 100000;
    const page = Array.from({ length: 1000 }, (_, i) => ({ id: `KEY-${i}` }));
    const calls = captureFetch(tt, (i) => {
      if (i % 2 === 1) return { json: {} };
      remaining -= 1000;
      return { json: { value: page, '@odata.count': remaining } };
    });

    assert.strictEqual(await aiSearch.deleteChunksForDocument('endless', { maxRounds: 4 }), 4000);
    assert.strictEqual(calls.length, 8, 'four rounds, then stop');
  });
});

test('ai-search request resilience', async (t) => {
  // Basic tier at one replica throttles under a burst of keystroke-driven searches. The Cosmos
  // client next door already retries 429; this path had nothing.
  await t.test('a 429 is retried and then succeeds', async (tt) => {
    const calls = captureFetch(tt, (i) => i === 0
      ? { ok: false, status: 429, headers: { 'retry-after': '0.01' }, json: {} }
      : { json: { value: [], '@odata.count': 0 } });

    const result = await aiSearch.searchChunks({ keywords: 'peace river', filter: null });

    assert.strictEqual(result.count, 0);
    assert.strictEqual(calls.length, 2, 'the throttled attempt was retried');
  });

  await t.test('Retry-After is honoured over the default backoff', async (tt) => {
    captureFetch(tt, (i) => i === 0
      ? { ok: false, status: 503, headers: { 'retry-after': '0.01' }, json: {} }
      : { json: { value: [] } });

    const started = Date.now();
    await aiSearch.searchChunks({ keywords: 'peace', filter: null });
    // The default for attempt 1 is a full second; honouring the header must beat it clearly.
    assert.ok(Date.now() - started < 500, 'waited the header value, not the default backoff');
  });

  // A 400 from a field name that is not in the index returns the same 400 every time. Retrying it
  // triples the latency of a guaranteed failure — and this is the exact status that broke project
  // search once already.
  await t.test('a 400 is not retried', async (tt) => {
    const calls = captureFetch(tt, () => ({ ok: false, status: 400, json: { error: 'bad field' } }));

    await assert.rejects(
      () => aiSearch.searchChunks({ keywords: 'peace', filter: null }),
      /HTTP 400/
    );
    assert.strictEqual(calls.length, 1, 'no retry on a deterministic failure');
  });

  await t.test('a timeout rejects rather than hanging, and is not retried', async (tt) => {
    const timeout = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    const calls = captureFetch(tt, () => ({ throws: timeout }));

    await assert.rejects(
      () => aiSearch.searchChunks({ keywords: 'peace', filter: null }),
      /TimeoutError/
    );
    assert.strictEqual(calls.length, 1, 'the budget was already spent; retrying makes it worse');
  });

  await t.test('every attempt of one call carries the same correlation id', async (tt) => {
    const calls = captureFetch(tt, (i) => i === 0
      ? { ok: false, status: 429, headers: { 'retry-after': '0.01' }, json: {} }
      : { json: { value: [] } });

    await aiSearch.searchChunks({ keywords: 'peace', filter: null });

    const ids = calls.map(c => c.init.headers['x-ms-client-request-id']);
    assert.ok(ids[0], 'the header is sent');
    assert.strictEqual(ids[0], ids[1], 'retries share the id so the logs relate them');
  });
});

// Project and document highlighting used to be reconstructed in the browser by a regex plus a
// hand-rolled Levenshtein. That marks words the index never hit and misses stemmed ones it did —
// `en.microsoft` matches `flooding` for `flood`, and the client marked neither. Asking the service
// for the highlight is asking the analyzer what it actually matched.
test('project and document search return the analyzer\'s highlights', async (t) => {
  const PRE = aiSearch.HL_PRE;
  const POST = aiSearch.HL_POST;

  await t.test('searchProjects asks for highlights on the fields the card renders', async (tt) => {
    const calls = captureFetch(tt, () => ({ json: { value: [] } }));

    await aiSearch.searchProjects({ filter: null, keywords: 'flood' });

    assert.strictEqual(calls[0].body.highlight, 'name,displayName,description');
    assert.strictEqual(calls[0].body.highlightPreTag, PRE);
    assert.strictEqual(calls[0].body.highlightPostTag, POST);
  });

  await t.test('a highlighted field comes back as balanced, escaped markup', async (tt) => {
    captureFetch(tt, () => ({
      json: {
        value: [{
          id: 'p1',
          name: 'Peace River <Project>',
          description: 'A dam & a reservoir.',
          '@search.highlights': { name: [`Peace ${PRE}River${POST} <Project>`] }
        }]
      }
    }));

    const { items } = await aiSearch.searchProjects({ filter: null, keywords: 'river' });

    assert.strictEqual(items[0].highlighted.name, 'Peace <mark>River</mark> &lt;Project&gt;');
  });

  await t.test('a field the query did NOT match is escaped plain text, not empty', async (tt) => {
    // The frontend binds one string per field into [innerHTML]. Returning '' for an unmatched
    // field would blank the card; returning the raw value would put unescaped user text there.
    captureFetch(tt, () => ({
      json: {
        value: [{
          id: 'p1',
          name: 'Peace River',
          description: 'Tunnels & <b>bridges</b>',
          '@search.highlights': { name: [`${PRE}Peace${POST} River`] }
        }]
      }
    }));

    const { items } = await aiSearch.searchProjects({ filter: null, keywords: 'peace' });

    assert.strictEqual(items[0].highlighted.description, 'Tunnels &amp; &lt;b&gt;bridges&lt;/b&gt;');
  });

  await t.test('a missing field yields an empty string rather than "undefined"', async (tt) => {
    captureFetch(tt, () => ({ json: { value: [{ id: 'p1', name: 'Peace River' }] } }));

    const { items } = await aiSearch.searchProjects({ filter: null, keywords: 'peace' });

    assert.strictEqual(items[0].highlighted.description, '');
  });

  await t.test('the underlying hit fields are still returned alongside the markup', async (tt) => {
    // The controller reshapes from the raw values; only the display layer wants the markup.
    captureFetch(tt, () => ({
      json: { value: [{ id: 'p1', name: 'Peace River', sector: 'Energy', region: 'Peace' }] }
    }));

    const { items } = await aiSearch.searchProjects({ filter: null, keywords: 'peace' });

    assert.strictEqual(items[0].sector, 'Energy');
    assert.strictEqual(items[0].name, 'Peace River');
  });

  await t.test('searchDocuments highlights its own metadata fields', async (tt) => {
    const calls = captureFetch(tt, () => ({
      json: {
        value: [{
          id: 'd1',
          displayName: 'Flood Assessment',
          '@search.highlights': { displayName: [`${PRE}Flood${POST} Assessment`] }
        }]
      }
    }));

    const { items } = await aiSearch.searchDocuments({ filter: null, keywords: 'flood' });

    assert.strictEqual(calls[0].body.highlight, 'displayName,description');
    assert.strictEqual(items[0].highlighted.displayName, '<mark>Flood</mark> Assessment');
  });

  await t.test('documents pulled in by PROJECT name carry no marks', async (tt) => {
    // Leg two matches the project, not the document, so nothing in the document's own fields was
    // hit. Marking it anyway would claim a match that did not happen.
    const calls = captureFetch(tt, (i) => {
      if (i === 0) return { json: { value: [] } };                       // direct leg: no hits
      if (i === 1) return { json: { value: [{ id: 'p1' }] } };           // project fan-out
      return { json: { value: [{ id: 'd9', displayName: 'Appendix C' }] } };
    });

    const { items } = await aiSearch.searchDocuments({
      filter: null, projectFilter: null, keywords: 'peace'
    });

    assert.strictEqual(calls.length, 3);
    assert.strictEqual(items[0].highlighted.displayName, 'Appendix C',
      'escaped plain text, with no <mark>');
  });
});

test('semantic reranking', async (t) => {
  // The 402 latch is module state that survives a test. Without this, the first test to exhaust
  // the allowance turns semantic OFF for every test declared after it, and the assertions that
  // semantic IS requested would pass for the wrong reason — or fail depending on file order.
  t.beforeEach(() => aiSearch.resetSemanticExhausted());

  await t.test('on by default for chunks — it is the shipped ranking', async (tt) => {
    const calls = captureFetch(tt, () => ({ json: { value: [] } }));

    await aiSearch.searchChunks({ filter: null, keywords: 'peace river' });

    assert.strictEqual(calls[0].body.semanticConfiguration, 'demi-chunks-semantic');
  });

  await t.test('semantic: false opts out — the scorecard needs a BM25 arm', async (tt) => {
    const calls = captureFetch(tt, () => ({ json: { value: [] } }));

    await aiSearch.searchChunks({ filter: null, keywords: 'peace river', semantic: false });

    assert.strictEqual(calls[0].body.semanticQuery, undefined);
    assert.strictEqual(calls[0].body.semanticConfiguration, undefined);
    assert.strictEqual(calls[0].body.semanticErrorHandling, undefined);
  });

  await t.test('NEVER on projects or documents — those indexes have no semantic configuration, ' +
    'and naming one that does not exist is a 400', async (tt) => {
    const calls = captureFetch(tt, () => ({ json: { value: [] } }));

    await aiSearch.searchProjects({ filter: null, keywords: 'peace river' });
    await aiSearch.searchDocuments({ filter: null, keywords: 'peace river' });

    for (const call of calls) {
      assert.strictEqual(call.body.semanticConfiguration, undefined);
    }
  });

  await t.test('on, it adds L2 WITHOUT disturbing the Lucene query that drives L1', async (tt) => {
    // The whole reason for `semanticQuery` over `queryType: 'semantic'`. If this assertion ever
    // fails, retrieval has been silently downgraded to plain text and every measured fix in
    // buildQuery — fuzzy arm, boost, stopword guard — is gone.
    const calls = captureFetch(tt, () => ({ json: { value: [] } }));

    await aiSearch.searchChunks({ filter: null, keywords: 'peace river', fuzzy: true, semantic: true });

    assert.strictEqual(calls[0].body.queryType, 'full');
    assert.strictEqual(calls[0].body.search,
      '(peace OR peace~1^0.5) AND (river OR river~1^0.5)');
    assert.strictEqual(calls[0].body.semanticQuery, 'peace river');
    assert.strictEqual(calls[0].body.semanticConfiguration, 'demi-chunks-semantic');
    assert.strictEqual(calls[0].body.semanticErrorHandling, 'partial');
  });

  await t.test('the L1 query is byte-identical with semantic on and off', async (tt) => {
    const calls = captureFetch(tt, () => ({ json: { value: [] } }));

    const opts = { filter: null, keywords: 'Site C AND clean-energy', fuzzy: true, prefix: true };
    await aiSearch.searchChunks({ ...opts });
    await aiSearch.searchChunks({ ...opts, semantic: true });

    assert.strictEqual(calls[1].body.search, calls[0].body.search);
    assert.strictEqual(calls[1].body.queryType, calls[0].body.queryType);
  });

  await t.test('semanticQuery carries no Lucene operators', async (tt) => {
    // `tokenize` is the thing that strips them. Operator syntax inside the semantic string is
    // unsupported, and `~`/`^`/`(` reaching it would be sent as literal text to the ranker.
    //
    // The `2` of `^2` survives on purpose: tokenize keeps digits, and it is right that it does —
    // drawing numbers and section numbers are content in this corpus, not syntax. What must not
    // survive is the operator CHARACTER.
    const calls = captureFetch(tt, () => ({ json: { value: [] } }));

    await aiSearch.searchChunks({
      filter: null, keywords: 'waste~ dumps^2 (north)', fuzzy: true, semantic: true
    });

    assert.strictEqual(calls[0].body.semanticQuery, 'waste dumps 2 north');
    assert.ok(!/[~^()]/.test(calls[0].body.semanticQuery));
  });

  await t.test('matchAll never asks for reranking — there is no relevance to rescore', async (tt) => {
    const calls = captureFetch(tt, () => ({ json: { value: [] } }));

    await aiSearch.searchChunks({ filter: null, matchAll: true, semantic: true });

    assert.strictEqual(calls[0].body.search, '*');
    assert.strictEqual(calls[0].body.semanticQuery, undefined);
  });

  await t.test('402 retries once WITHOUT the semantic parameters and still returns results',
    async (tt) => {
      // The free allowance is spent for the rest of the MONTH. Rethrowing would 500 every Deep
      // Search until the calendar rolls over; serving the BM25 order is what the product ran on
      // until now.
      const calls = captureFetch(tt, (i) => (
        i === 0
          ? { ok: false, status: 402, json: { error: 'Free Query Semantic Usage exceeded' } }
          : { json: { value: [{ chunkId: 'c1', documentId: 'd1' }], '@odata.count': 1 } }
      ));

      const { items, count } = await aiSearch.searchChunks({
        filter: null, keywords: 'peace river', semantic: true
      });

      assert.strictEqual(calls.length, 2, 'exactly one retry, not the 3-attempt retry loop');
      assert.strictEqual(calls[1].body.semanticQuery, undefined);
      assert.strictEqual(calls[1].body.semanticConfiguration, undefined);
      assert.strictEqual(calls[1].body.search, calls[0].body.search, 'same L1 query');
      assert.strictEqual(items[0].documentId, 'd1');
      assert.strictEqual(count, 1);
    });

  await t.test('after a 402 it stops ASKING — later searches cost one round trip, not two',
    async (tt) => {
      // The point of the latch. The allowance is spent for the rest of the month, so a later
      // search asking again cannot succeed — it just pays a 402 before the stripped retry. Without
      // the gate that is every Deep Search, twice, until the calendar rolls over.
      const calls = captureFetch(tt, (i) => (
        i === 0
          ? { ok: false, status: 402, json: { error: 'Free Query Semantic Usage exceeded' } }
          : { json: { value: [], '@odata.count': 0 } }
      ));

      await aiSearch.searchChunks({ filter: null, keywords: 'peace river' });
      assert.strictEqual(calls.length, 2, 'first search: 402 then the stripped retry');

      await aiSearch.searchChunks({ filter: null, keywords: 'site c' });

      assert.strictEqual(calls.length, 3, 'second search is ONE request, not another 402 + retry');
      assert.strictEqual(calls[2].body.semanticQuery, undefined, 'no longer asks for reranking');
      assert.strictEqual(calls[2].body.semanticConfiguration, undefined);
      assert.strictEqual(calls[2].body.semanticErrorHandling, undefined);
      // L1 is untouched by the latch — degraded ranking, not degraded retrieval.
      assert.strictEqual(calls[2].body.queryType, 'full');
      assert.ok(calls[2].body.search.includes('site'), 'still the full Lucene query');
    });

  await t.test('a 402 on the NON-semantic query throws — the fallback is not a blanket catch',
    async (tt) => {
      const calls = captureFetch(tt, () => ({ ok: false, status: 402, json: { error: 'nope' } }));

      await assert.rejects(
        () => aiSearch.searchChunks({ filter: null, keywords: 'peace river', semantic: false }),
        /HTTP 402/
      );
      assert.strictEqual(calls.length, 1, 'nothing to strip, so nothing to retry');
    });

  await t.test('a 402 that persists after stripping semantic is surfaced, not looped',
    async (tt) => {
      // The fallback retries ONCE. If the second attempt fails too, that is a real failure and
      // must reach the caller rather than becoming a third attempt or a silent empty result.
      const calls = captureFetch(tt, () => ({ ok: false, status: 402, json: { error: 'nope' } }));

      await assert.rejects(
        () => aiSearch.searchChunks({ filter: null, keywords: 'peace river' }),
        /HTTP 402/
      );
      assert.strictEqual(calls.length, 2, 'one semantic attempt, one stripped retry, then stop');
    });

  await t.test('403 is not swallowed by the 402 fallback', async (tt) => {
    // A missing data-plane role must stay loud. Degrading it to a BM25 retry would hide a
    // deployment fault behind working-looking results.
    const calls = captureFetch(tt, () => ({ ok: false, status: 403, json: { error: 'forbidden' } }));

    await assert.rejects(
      () => aiSearch.searchChunks({ filter: null, keywords: 'peace river', semantic: true }),
      /HTTP 403/
    );
    assert.strictEqual(calls.length, 1, 'no retry');
  });

  await t.test('a partial response is reported, not passed off as reranked', async (tt) => {
    // Throttling returns the BM25 order with a reason and HTTP 200. Unlogged, a service silently
    // serving unranked results looks identical to one where reranking works.
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (msg) => warnings.push(String(msg));
    tt.after(() => { console.warn = originalWarn; });

    captureFetch(tt, () => ({
      json: {
        value: [{ chunkId: 'c1', documentId: 'd1' }],
        '@search.semanticPartialResponseReason': 'capacityOverloaded'
      }
    }));

    const { items } = await aiSearch.searchChunks({
      filter: null, keywords: 'peace river', semantic: true
    });

    assert.strictEqual(items.length, 1, 'results still served');
    assert.ok(warnings.some(w => w.includes('capacityOverloaded')), 'the reason is logged');
  });
});
