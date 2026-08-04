'use strict';

/**
 * Score retrieval against human-labelled phrases. READ-ONLY — this script writes nothing.
 *
 * Why it exists: `audit-chunk-quality.js` grades the extracted TEXT with heuristics and says so
 * itself — it "picks WHICH documents to labour over by hand; the retrieval run decides whether the
 * text is good." This is that retrieval run. It is the verdict metric, and the decision about an
 * intake cleaner waits on it.
 *
 * WHY HEURISTICS CANNOT ANSWER THIS. The audit's own measured blind spot is character-spacing
 * damage: real corpus text reading `Tum ble r Ridge` scores CLEAN, because every fragment is
 * pronounceable. No cheap metric sees it. But a human who reads `Tumbler Ridge` on the page and
 * types it as a label WILL see it — the query tokenizes to `tumbler AND ridge`, the index holds
 * `tum`, `ble`, `r`, and the document does not come back. That miss is the finding. This is the
 * only instrument here that can produce it.
 *
 * WHAT A LABEL IS. One line of JSONL: `{"documentId": "...", "phrase": "..."}`, optionally with
 * `"note"`. The phrase must be something a HUMAN read with their own eyes in the source document
 * and would plausibly search for. It must not be copied out of the extracted markdown — a phrase
 * lifted from the extraction is guaranteed to retrieve itself and measures nothing. That is the
 * whole discipline of the method; there is no way to automate it, which is why the labels file is
 * an input rather than something this script generates.
 *
 * Produce labels from `audit-chunk-quality.js` output: take its `worstStratum` and `randomStratum`
 * document ids, open those documents at source, and write one phrase each. Two strata scored
 * separately answer two different questions, so keep them in separate label files rather than
 * merging them into one number.
 *
 * WHAT THE SCORE IS. `recall@k` — the share of labels whose OWN document appears in the first k
 * hits. `rank` is 1-based; `0` means not found within `--top`. MRR is included because recall@1
 * alone cannot tell "ranked second" from "absent", and those are very different failures.
 *
 * Queries go through `searchChunks()`, the same path the API serves, with the same tokenizer and
 * the same query builder. Scoring a hand-rolled query would measure a search nobody uses.
 * `--fuzzy` defaults ON because the frontend sends `fuzzy=true` on every Deep Search, so that is
 * the path users actually get; `--no-fuzzy` scores the other one for comparison.
 *
 * DO NOT RUN THIS WHILE AN EXTRACTION RUN IS IN FLIGHT. A corpus growing underneath the queries
 * makes two runs incomparable, which defeats the point of committing a scorecard. Wait for the run
 * to land.
 *
 * Cosmos and AI Search are both private-endpoint-only and keyless, so this must run INSIDE the app
 * container over the App Service SSH tunnel — not Kudu's /api/command, whose SCM container has no
 * managed-identity endpoint. See MIGRATION.md for the recipe.
 *
 * Usage:
 *   node src/scripts/score-retrieval.js --labels labels.jsonl [--top 10] [--no-fuzzy]
 *                                       [--out report.json]
 */

const aiSearch = require('../search/ai-search');
const { systemAccess } = require('../helpers/access-sql');
const { filterFor } = require('../helpers/access-odata');

const DEFAULTS = { labels: '', top: 10, fuzzy: true, out: '', anyTerms: false };

// Reported at, not below. `tokenize` caps a query at 16 terms, so a longer phrase silently loses
// its tail — and a label that lost words is not the label the human wrote.
const TERM_CAP = 16;

const RECALL_KS = [1, 5, 10];

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--labels') args.labels = String(argv[++i]);
    else if (a === '--top') args.top = parseInt(argv[++i], 10);
    else if (a === '--fuzzy') args.fuzzy = true;
    else if (a === '--no-fuzzy') args.fuzzy = false;
    else if (a === '--out') args.out = String(argv[++i]);
    // The OR arm. Unknown args throw below, so a typo'd `--any-term` aborts instead of quietly
    // scoring the baseline and writing it to the OR filename.
    else if (a === '--any-terms') args.anyTerms = true;
    else throw new Error(`[score-retrieval] unknown argument: ${a}`);
  }
  if (!args.labels) throw new Error('[score-retrieval] --labels <file.jsonl> is required');
  if (!Number.isInteger(args.top) || args.top < 1) {
    throw new Error('[score-retrieval] --top must be a positive integer');
  }
  return args;
}

/**
 * Parse JSONL labels, keeping the source line number on each.
 *
 * A malformed or incomplete line THROWS rather than being skipped. Silently dropping labels would
 * shrink the denominator and quietly raise recall — the one failure mode a scorecard must not have.
 * Blank lines are ignored; a `#` line is allowed so a labels file can carry its own provenance,
 * since JSON has no comment form.
 */
function parseLabels(text) {
  const labels = [];
  const lines = String(text).split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    let row;
    try {
      row = JSON.parse(line);
    } catch (err) {
      throw new Error(`[score-retrieval] line ${i + 1}: not valid JSON — ${err.message}`, { cause: err });
    }
    if (!row || typeof row.documentId !== 'string' || !row.documentId) {
      throw new Error(`[score-retrieval] line ${i + 1}: missing documentId`);
    }
    if (typeof row.phrase !== 'string' || !row.phrase.trim()) {
      throw new Error(`[score-retrieval] line ${i + 1}: missing phrase`);
    }
    labels.push({
      documentId: row.documentId,
      phrase: row.phrase,
      note: row.note || null,
      line: i + 1
    });
  }

  if (labels.length === 0) throw new Error('[score-retrieval] labels file has no labels');
  return labels;
}

/**
 * 1-based rank of the first hit belonging to `documentId`, or 0 when absent.
 *
 * Ranks the DOCUMENT, not the chunk: several chunks of one document can hit, and only the best
 * placement matters to someone looking for that document. Hit order is the service's ranking.
 */
function rankOf(items, documentId) {
  const at = (items || []).findIndex(hit => String(hit.documentId) === String(documentId));
  return at === -1 ? 0 : at + 1;
}

/**
 * Aggregate scored labels.
 *
 * Errored labels are excluded from the denominator AND reported separately — folding them in
 * either direction lies. Counting them as misses blames the corpus for a transport failure;
 * dropping them without saying so inflates recall against a denominator nobody can see.
 */
function summarize(results, top) {
  const errored = results.filter(r => r.error);
  const scored = results.filter(r => !r.error);
  const denominator = scored.length;

  // recall@k is meaningless past the number of hits requested — k > top can only ever look like
  // a miss. Report the ks that were actually measurable and say which were dropped.
  const ks = RECALL_KS.filter(k => k <= top);

  const recallAt = {};
  for (const k of ks) {
    const hits = scored.filter(r => r.rank > 0 && r.rank <= k).length;
    recallAt[k] = denominator ? round(hits / denominator) : null;
  }

  const reciprocalSum = scored.reduce((sum, r) => sum + (r.rank > 0 ? 1 / r.rank : 0), 0);

  return {
    labels: results.length,
    scored: denominator,
    errored: errored.length,
    found: scored.filter(r => r.rank > 0).length,
    recallAt,
    recallKsNotMeasured: RECALL_KS.filter(k => k > top),
    mrr: denominator ? round(reciprocalSum / denominator) : null,
    misses: scored.filter(r => r.rank === 0).map(pick),
    // Found, but not first. The chunk carries the words; something else outranked it.
    rankedBelowFirst: scored.filter(r => r.rank > 1).map(pick),
    errors: errored.map(r => ({ ...pick(r), error: r.error }))
  };
}

function pick(r) {
  return { documentId: r.documentId, phrase: r.phrase, rank: r.rank, line: r.line };
}

function round(n) {
  return Math.round(n * 10000) / 10000;
}

async function scoreLabel(label, args, filter) {
  const terms = aiSearch.tokenize(label.phrase);

  const { items, count } = await aiSearch.searchChunks({
    keywords: label.phrase,
    fuzzy: args.fuzzy,
    // Explicit keys, not a spread — the arm has to be named here or the flag reaches nothing.
    anyTerms: args.anyTerms,
    top: args.top,
    filter
  });

  return {
    ...label,
    rank: rankOf(items, label.documentId),
    // The corpus-wide hit count, not the page. A label that matches thousands of chunks and still
    // ranks its own document first is a different result from one that matches only that document.
    matchingChunks: count,
    termsQueried: terms.length,
    atTermCap: terms.length >= TERM_CAP,
    topHitDocumentId: items.length ? items[0].documentId : null
  };
}

/**
 * @param {string[]} argv  CLI-style arguments, so the SSH wrapper and the CLI share one entry
 *                         point — same reason as `audit-chunk-quality.js`.
 */
async function score(argv = []) {
  const args = parseArgs(argv);
  const started = new Date().toISOString();

  const labels = parseLabels(require('fs').readFileSync(args.labels, 'utf8'));

  // Resolved THROUGH filterFor, never hand-built. systemAccess() is privileged, so this comes back
  // null — and a null filter is UNRESTRICTED, which is what a corpus-wide scorecard needs. Going
  // via the helper is what keeps that an access-control decision rather than an omission.
  const { filter, empty } = filterFor(systemAccess());
  if (empty) throw new Error('[score-retrieval] access resolved to match nothing — refusing to run');

  // Refuse rather than publish an unfalsifiable zero. `searchChunks` returns [] when
  // SEARCH_ENDPOINT is unset — correct for the API, where degraded beats a 500 — but here it
  // renders as `recall@1: 0`, which reads as "the corpus is unfindable" when it actually means
  // "nobody asked the search service anything". Caught by running this script locally, where it
  // cheerfully reported 0% against a service it had never contacted.
  if (!aiSearch.config().configured) {
    throw new Error(
      '[score-retrieval] SEARCH_ENDPOINT is not set. Refusing to run: every label would score as ' +
      'a miss and the report would be indistinguishable from a genuinely unfindable corpus.'
    );
  }

  const results = [];
  // Serial on purpose. This is an instrument, not a job: concurrent queries against one Basic-tier
  // search service produce throttled timings and a scorecard that cannot be compared to the next.
  for (const label of labels) {
    try {
      results.push(await scoreLabel(label, args, filter));
    } catch (err) {
      console.error(`[score-retrieval] line ${label.line}: ${err.message}`);
      results.push({ ...label, rank: 0, error: err.message });
    }
  }

  const report = {
    started,
    // Stated in the output, because a scorecard without its query settings is not evidence — the
    // same run at fuzzy=false is a different measurement wearing the same name.
    query: {
      labelsFile: args.labels,
      out: args.out || null,
      top: args.top,
      fuzzy: args.fuzzy,
      // Which arm. Two reports off the same labels file are otherwise indistinguishable, and the
      // whole experiment is a paired before/after — a mislabelled `--out` would invert the finding.
      anyTerms: args.anyTerms,
      note: 'queries go through searchChunks(), the path the API serves'
    },
    ...summarize(results, args.top),
    results
  };

  if (args.out) {
    require('fs').writeFileSync(args.out, JSON.stringify(report, null, 2));
    console.log(`[score-retrieval] wrote ${args.out}`);
  }
  return report;
}

if (require.main === module) {
  score(process.argv.slice(2))
    .then(report => { if (!report.query.out) console.log(JSON.stringify(report, null, 2)); })
    .catch(err => {
      console.error('[score-retrieval] failed:', err.message);
      process.exit(1);
    });
}

module.exports = { score, parseArgs, parseLabels, rankOf, summarize };
