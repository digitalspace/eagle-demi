'use strict';

/**
 * Azure AI Search — the Deep Search backend over extracted document text.
 *
 * Retrieval is lexical BM25. No vectors and no embedding pipeline: AI is a summariser over the
 * final top-N, not a retriever. Chunk search additionally asks Azure's semantic ranker to REORDER
 * what BM25 already found — see semanticConfigurationFor. That is a reranker over the top 50, not a
 * second retrieval path; it cannot surface anything the keyword query missed.
 *
 * Deliberately plain `fetch` against the REST API rather than `@azure/search-documents`. Two
 * calls are needed — search and delete — and the SDK would be a new dependency for what a request
 * body already expresses. `@azure/identity` is NOT new: it is already how Cosmos authenticates.
 *
 * The service has `disableLocalAuth`, so there is no admin key to configure or leak, and its
 * `publicNetworkAccess` is Disabled (landing-zone policy), so this only works from inside the
 * VNet — which the App Service is. See the wiki's BC-Gov-Azure-Landing-Zone page.
 */

const { randomUUID } = require('crypto');
const { logger } = require('../utils/logger');

const API_VERSION = '2024-07-01';

/**
 * Highlight markers.
 *
 * AI Search wraps matched terms in whatever tags it is given, INSIDE text extracted from arbitrary
 * uploaded PDFs, and the frontend renders the result with `[innerHTML]`. Asking for `<mark>`
 * directly would mean either shipping unescaped document text to the DOM or trying to escape
 * around tags we ourselves asked for.
 *
 * So ask for control characters no document can contain, escape the ENTIRE fragment, and only then
 * swap the sentinels for real tags. U+0001/U+0002 cannot survive `chunkMarkdown`, cannot be typed,
 * and have no meaning in HTML.
 */
const HL_PRE = '\u0001';
const HL_POST = '\u0002';

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

/** Beyond this the query grows without adding recall; BM25 is already dominated by the rest. */
const MAX_TERMS = 16;

/** Azure AI Search rejects `$skip` above this; `skip + top` must stay inside it. */
const MAX_SKIP = 100000;

/**
 * Fields the document search asks for.
 *
 * EVERY NAME MUST EXIST IN THE INDEX — a stray one is a 400 on every query, not a missing field in
 * the response, and a 400 is not retried. Exported so a test can hold that invariant against the
 * committed `azure/search/indexes/documents.json` rather than leaving it as a comment; a typo here
 * broke no test until one did.
 *
 * The last five arrived with the widened index: `datePosted` is eagle-public's Date column and its
 * default sort, and the four ids are what `idToList()` resolves for Type and Milestone.
 */
// `isFeatured` backs eagle-public's ★ column; `documentSource` its PROJECT-NOTIFICATION split.
const DOCUMENT_SELECT = 'id,displayName,documentFileName,description,type,projectId,read,' +
  'isPublished,typeId,milestoneId,projectPhaseId,documentAuthorTypeId,datePosted,isFeatured,' +
  'documentSource,fileSize';

/**
 * The fields a PROJECT hit carries back. Same invariant, same reason, and the same exported-so-a-
 * test-can-hold-it treatment as DOCUMENT_SELECT above.
 *
 * IT WAS AN INLINE LITERAL, AND THAT IS HOW THE LAST SIX WENT MISSING. Widening the index, the data
 * source and the mapper is not enough on its own: a field absent from `select` comes back
 * undefined, so the mapper emits `type: ''` and `currentPhaseName: null` on every hit and the
 * columns read '-' exactly as before — a quieter version of the bug being fixed, under a 200. The
 * document side already had the constant and the guard test; projects had neither.
 *
 * The last six arrived with the widened index: `type` is eagle-public's Type column, and the two
 * label/id pairs are what the response rebuilds into the `{_id, name}` shape Phase and Decision
 * bind. `decisionDate` backs the decision-date range filter.
 */
const PROJECT_SELECT = 'id,name,displayName,description,proponent,sector,status,region,centroid,' +
  'legacyEagleId,read,isPublished,type,currentPhaseName,currentPhaseNameId,eacDecision,' +
  'eacDecisionId,decisionDate,vis';

/** Rows one search request can return. A larger page costs more requests, not fewer rows. */
const SERVICE_MAX_TOP = 250;

/**
 * The largest page this layer will assemble, whatever `pageSize` says.
 *
 * 500 is eagle-public's own ceiling — `MAX_SHOW_ALL_ITEMS` in `table-template.component.ts:122-126`
 * is the biggest page any live caller asks for — so every real request fits in two service calls.
 * The controller REFUSES a larger page rather than letting this clamp it: a short page under a
 * large total is a page the caller never learns they did not receive, which is the whole defect
 * this constant exists to close.
 */


const MAX_PAGE_ROWS = 500;

/**
 * How many document ids a chunk query may be scoped to before the filter is treated as
 * inexpressible.
 *
 * DERIVED FROM `MAX_PAGE_ROWS`, NOT CHOSEN, because it cannot exceed what one request yields and a
 * second number here can silently stop agreeing with the first. It did: this was set to 20,000 on
 * the reasoning that `search.in` handles large lists and a POST body has room. True, and irrelevant
 * — `runSearch` clamps `top` to `MAX_PAGE_ROWS`, so the resolver could never return more than 500
 * ids no matter what this said. A filter matching 501 to 20,000 documents was then truncated to an
 * arbitrary 500-id prefix and reported to the caller as APPLIED: measured on the branch's own
 * figure, a `type` filter matching 2,911 documents scoped the chunk query to 500 of them, 17.2%
 * coverage, with `meta.dropped` absent. Exactly what the docblock below forbids.
 *
 * `SERVICE_MAX_TOP - 1`, not `MAX_PAGE_ROWS - 1`, so the whole thing is ONE service request.
 * `runSearch` fills anything over `SERVICE_MAX_TOP` with a second request, so a cap of 499 meant
 * asking for 500 rows across two calls and — on every filter measured on prod, since all of them
 * are over the cap — throwing all 500 away to conclude "too many". Two calls to learn a number the
 * first one already carried in `@odata.count`. At 249 the answer arrives in one call either way,
 * and nothing real is lost: no corpus-wide filter fits under 499 either, and the project-scoped
 * sets this actually serves are a handful of documents.
 *
 * WHAT THIS COSTS, stated plainly because it is the honest limit of the two-query design: measured
 * against prod, the narrowest document-type filter in the corpus matches 2,911 documents,
 * `projectPhase` 1,425, `milestone` 36,471. Every one of them is over this cap, so today the
 * resolver reports the filter as inexpressible rather than applying it. That is a real improvement
 * — a silently unfiltered answer becomes an explicitly unfiltered one the caller can see — but it
 * is NOT parity with prod. Reaching parity needs either paging this query (about six sequential
 * service calls for `type`, on a Basic 1-SU service, on every debounced keystroke) or denormalising
 * document metadata onto 1,128,733 chunk rows. Both are decisions, not follow-ups.
 */
const DOCUMENT_SCOPE_CAP = SERVICE_MAX_TOP - 1;

let tokenCache = null;
let credential = null;
let unconfiguredWarned = false;

/**
 * One service, three indexes, one app setting each.
 *
 * `SEARCH_INDEX` keeps its unqualified name for backward compatibility — it named the chunk index
 * before there were three. The defaults are the LIVE names,
 * matching the committed definitions under `azure/search/` and the live indexes, all three of which
 * agree since the cutover on 2026-08-22. The retired `demi-*` indexes still exist and their indexers
 * still run, so rolling back is a settings change with no refill. All three are settable precisely so no code release is involved either way.
 */
function config() {
  const endpoint = (process.env.SEARCH_ENDPOINT || '').replace(/\/$/, '');
  const index = process.env.SEARCH_INDEX || 'chunks';
  return {
    endpoint,
    index,
    projectsIndex: process.env.SEARCH_INDEX_PROJECTS || 'projects',
    documentsIndex: process.env.SEARCH_INDEX_DOCUMENTS || 'documents',
    configured: Boolean(endpoint)
  };
}

/**
 * Not configured is a DEGRADED state, not an error.
 *
 * A missing app setting must not 500 the search endpoint — the Project and Document datasets are
 * served by a different backend and stay up. Warn once per process: per-request this would be
 * pure noise, because the frontend searches on every keystroke.
 */
function warnUnconfigured() {
  if (unconfiguredWarned) return;
  unconfiguredWarned = true;
  logger.warn(
    '[ai-search] SEARCH_ENDPOINT is not set; chunk search is unavailable and returns empty ' +
    'results. This is NOT "no matches" — it is a missing configuration.'
  );
}

/**
 * A bearer token for the search data plane, cached until shortly before it expires.
 *
 * `@azure/identity` is required lazily so that importing this module does not pull it into test
 * runs that never authenticate — the same reason `db/cosmos-nosql.js` does it.
 */
async function getToken() {
  if (tokenCache && tokenCache.expiresOn - Date.now() > 5 * 60 * 1000) {
    return tokenCache.token;
  }

  if (!credential) {
    const { DefaultAzureCredential } = require('@azure/identity');
    // AZURE_CLIENT_ID selects the user-assigned identity, exactly as the Cosmos client does.
    credential = new DefaultAzureCredential(
      process.env.AZURE_CLIENT_ID
        ? { managedIdentityClientId: process.env.AZURE_CLIENT_ID }
        : undefined
    );
  }

  const result = await credential.getToken('https://search.azure.com/.default');
  if (!result || !result.token) throw new Error('no token returned for the search data plane');
  tokenCache = { token: result.token, expiresOn: result.expiresOnTimestamp || Date.now() };
  return tokenCache.token;
}

/**
 * Statuses worth a second attempt.
 *
 * 429 is throttling — the service is Basic at one replica, so a burst of keystroke-driven searches
 * can genuinely exceed it. 503 is a transient service-side failure. Nothing else belongs here: a
 * 400 from a field name that is not in the index returns the same 400 every time, and a 403 from a
 * missing data-plane role is a deployment fact, not a blip. Retrying either triples the latency of
 * a guaranteed failure.
 */
const RETRY_STATUSES = new Set([429, 503]);
const MAX_ATTEMPTS = 3;

/**
 * Fail long before the platform does.
 *
 * App Service aborts the request at 240s. A search that hangs until then holds a worker slot on a
 * 224 MB instance for four minutes, and the caller — the frontend, searching on a 300ms debounce —
 * gave up long before. 30s is well past any healthy query against this corpus.
 */
const REQUEST_TIMEOUT_MS = 30000;

/**
 * How long to wait before retrying.
 *
 * `Retry-After` is in seconds and is what the service actually wants; honour it when present.
 * Otherwise linear backoff, matching `bulkVerified` in `db/cosmos-nosql.js` rather than inventing a
 * second backoff style in the same codebase.
 */
function retryDelayMs(res, attempt) {
  const header = res.headers && typeof res.headers.get === 'function'
    ? res.headers.get('retry-after')
    : null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 10000);
  return 1000 * attempt;
}

async function request(path, body, opts = {}) {
  const { endpoint } = config();
  const maxAttempts = opts.maxAttempts || MAX_ATTEMPTS;
  const timeoutMs = opts.timeoutMs || REQUEST_TIMEOUT_MS;
  // One id for the whole call, retries included. The point is to find every attempt at ONE logical
  // request in the service-side logs; separate ids per attempt would hide that they are related.
  const clientRequestId = randomUUID();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res;
    try {
      res = await fetch(`${endpoint}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await getToken()}`,
          'Content-Type': 'application/json',
          'x-ms-client-request-id': clientRequestId
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      // A timeout surfaces as a TimeoutError from the signal, never as a status. NOT retried: the
      // call has already spent the full budget waiting, and if the service is that slow another
      // two attempts make the queue worse rather than better.
      throw new Error(
        `${path.split('?')[0]} failed after ${timeoutMs}ms (${err.name}) [${clientRequestId}]`,
        { cause: err }
      );
    }

    if (res.ok) return res.json();

    // The status matters: 403 (missing data-plane role) and 404 (wrong index name) both return
    // JSON that reads like an empty result if only the body is inspected.
    const detail = await res.text().catch(() => '');

    if (RETRY_STATUSES.has(res.status) && attempt < maxAttempts) {
      const delay = retryDelayMs(res, attempt);
      logger.warn(
        `[ai-search] HTTP ${res.status} on ${path.split('?')[0]}, retrying in ${delay}ms ` +
        `(attempt ${attempt}/${maxAttempts}) [${clientRequestId}]`
      );
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    // `status` is carried on the error, not just formatted into its message. `runSearch` has to
    // distinguish 402 (semantic ranker's free allowance is spent) from every other failure, and
    // string-matching an error message to make a control-flow decision is how that breaks silently.
    const err = new Error(`HTTP ${res.status} ${detail.slice(0, 300)} [${clientRequestId}]`);
    err.status = res.status;
    throw err;
  }

  // Unreachable: the loop either returns, retries, or throws. Here only if maxAttempts < 1.
  throw new Error(`[ai-search] no attempt made for ${path} [${clientRequestId}]`);
}

/**
 * Split user input into query terms.
 *
 * Splits on anything that is not a letter or digit, so no Lucene syntax character can reach the
 * query — `queryType: 'full'` means `+`, `-`, `*`, `"`, `~`, `(`, `)` and `:` are all operators,
 * and an unbalanced one is a 400 rather than a search for that character. Accented and non-Latin
 * letters survive (\p{L}); dropping them would make French place names unsearchable.
 */
function tokenize(keywords) {
  return String(keywords || '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, MAX_TERMS);
}

/**
 * Below this length an edit-distance-1 expansion has more neighbours than signal.
 *
 * Measured on the live corpus: `fuzzy=true` on the stopword-only query "the and of" returned a
 * full page of OCR noise — `the~1` matched a scanned fragment reading "th" — while the same query
 * with fuzzy off returned 0. Stopwords are removed by the analyzer, but a FUZZY term bypasses the
 * analyzer entirely, so the removal never happens and the expansion matches debris instead.
 * The frontend sends fuzzy=true on every Deep Search, so this is the default path, not an edge.
 *
 * Four is the usual Lucene threshold, and a typo in a three-letter word is not recoverable by
 * edit distance anyway — every other three-letter word is one edit away.
 */
const MIN_FUZZY_LENGTH = 4;

/**
 * Score multiplier on the fuzzy variant. MEASURED, not chosen.
 *
 * `(term OR term~1)` lets the fuzzy arm compete with the exact arm on BM25 score, so a document
 * matching only by edit distance can outrank one holding the term verbatim. That was the residual
 * gap after the stopword fix: blanket `--no-fuzzy` still scored 2 labels higher (44 vs 42), and the
 * vocabulary sweep came back clean, so it was a RANKING effect rather than a zeroing one.
 *
 * Paired run, both arms in one session, 71 labels plus the textless control (2026-08-04):
 *
 *   pooled recall@10  0.592 -> 0.620   (42 -> 44 of 71)
 *   pooled recall@1   0.282 -> 0.310
 *   pooled MRR        0.382 -> 0.403
 *   2 miss->hit, 0 hit->miss, no stratum regressed, control 0 in both arms
 *
 * All three metrics move together, which is what makes this shippable — `anyTerms` improved
 * recall@10 while making recall@1 and MRR worse, and was rejected for exactly that. It lands on the
 * same 44 labels blanket `--no-fuzzy` reaches, so it recovers the residue WITHOUT giving up typo
 * tolerance, which was the point.
 *
 * Honest limit: 2 discordant pairs is not statistically significant (one SE ~ 0.059 on this label
 * set; the move is half of that). The case rests on the direction being consistent across all three
 * metrics with zero regressions, not on the aggregate. Full account on the wiki's Search-Measurements page.
 */
const FUZZY_BOOST = 0.5;

/**
 * Lucene's boolean operators, which are CASE-SENSITIVE under `queryType: 'full'`.
 *
 * `tokenize` strips operator punctuation but cannot strip a word, so these reach `buildQuery` as
 * ordinary terms and join into `... AND AND AND ...` — a parse error, HTTP 400, not a search.
 * Measured against the live index on a real corpus phrase, "EAST TOBA AND MONTROSE HYDROELECTRIC
 * PROJECT": `Failed to parse query string at line 1, column 42`, which is exactly where the bare
 * `AND` lands. Any public query containing a standalone AND/OR/NOT was failing this way.
 *
 * Lowercasing demotes them back to terms and loses nothing: the index side is lowercased by
 * `en.microsoft`, so the word still matches whatever it would have matched.
 */
const LUCENE_OPERATORS = new Set(['AND', 'OR', 'NOT']);

/**
 * Terms `en.microsoft` REMOVES at query time, and which must therefore never get a `~1` variant.
 *
 * The plain term is analyzed, so a stopword is dropped from the query and costs nothing. The fuzzy
 * variant is NOT analyzed, so `mine~1` resurrects the stopword as a literal — and the index side
 * dropped it too, so the clause matches nothing. `(mine OR mine~1)` therefore collapses to an
 * unsatisfiable clause, and under the ` AND ` join ONE of those zeroes the entire query.
 *
 * Measured on the live index 2026-08-04, not guessed: the label
 * "Sediments from the proposed Lodgepole mine will move downstream and accumulate" returned 0 hits
 * with fuzzy on and 1 with fuzzy off, against a chunk that holds the sentence verbatim. `from`,
 * `mine`, `that` and `with` are the ones an EA corpus hits constantly.
 *
 * Only terms of >= MIN_FUZZY_LENGTH are listed: shorter stopwords never get a variant, so they are
 * already harmless — verified, adding `the` or `of` to a query leaves its hit count unchanged.
 *
 * To regenerate: for each candidate, `searchChunks({keywords: word, fuzzy: false})`. A count of 0
 * means the analyzer removed it. There is no cheaper route — the Analyze API needs a data-plane
 * role the app identity does not hold (403).
 */
const ANALYZER_STOPWORDS = new Set([
  'from', 'hers', 'herself', 'himself', 'itself', 'mine', 'myself', 'ours', 'ourselves', 'that',
  'their', 'theirs', 'them', 'themselves', 'these', 'they', 'this', 'those', 'with', 'yourself'
]);

/**
 * `(term OR term~1)` per term, ANDed together.
 *
 * The OR is not redundant. A fuzzy term bypasses the query analyzer, so it matches only against
 * what is already in the index; the plain term goes through `en.microsoft` and picks up stemming.
 * Measured on the live index, the bare fuzzy form happened to match too — because the INDEX side
 * is lemmatised — but that is a property of the current analyzer, and the OR does not depend on it.
 *
 * The outer ` AND ` was tested as the recall suspect and CLEARED: an ` OR ` arm moved pooled
 * recall@10 0.549 → 0.577 at n=71, half a standard error, with recall@1 and MRR worse and the
 * discriminating `text` stratum flat. See the wiki's Search-Measurements page — the knob is not carried in the code
 * because the question it answered is closed.
 */
function buildQuery(terms, fuzzy, prefix = false) {
  const last = terms.length - 1;
  return terms
    .map((raw, i) => {
      const t = LUCENE_OPERATORS.has(raw) ? raw.toLowerCase() : raw;
      const parts = [t];
      // A stopword gets NO unanalyzed variant. Both `~1` and `*` bypass the query analyzer, so on a
      // term the analyzer removes they demand a literal the index does not hold, and the clause
      // becomes unsatisfiable — fatal under a conjunction. The plain term stays: it analyzes away
      // and is dropped harmlessly, which is the behaviour that was already correct.
      const analyzed = !ANALYZER_STOPWORDS.has(t.toLowerCase());
      // `^0.5` on the fuzzy variant only — see FUZZY_BOOST. Never on the plain term (the arm this
      // protects) and never on the `*` prefix variant, which is a different mechanism.
      if (fuzzy && analyzed && t.length >= MIN_FUZZY_LENGTH) parts.push(`${t}~1^${FUZZY_BOOST}`);
      // Prefix on the LAST term only — the one still being typed. Applying it to every term would
      // match `pipe` inside `pipeline` in the middle of a phrase and blur the query; applying it
      // to none loses search-as-you-type, which Typesense provided via `prefix=true` and the
      // frontend relies on because it searches on debounced keystrokes.
      if (prefix && analyzed && i === last && t.length >= MIN_FUZZY_LENGTH) parts.push(`${t}*`);
      return parts.length > 1 ? `(${parts.join(' OR ')})` : t;
    })
    .join(' AND ');
}

/**
 * Semantic reranking (L2), applied ON TOP of the Lucene query rather than instead of it.
 *
 * `semanticQuery` is the load-bearing choice. The other route — `queryType: 'semantic'` — accepts
 * ONLY plain text: both simple and full Lucene syntax are rejected. Taking it would silently throw
 * away every measured thing `buildQuery` does: the `(term OR term~1^0.5)` fuzzy arm, FUZZY_BOOST,
 * the ANALYZER_STOPWORDS guard that stops a conjunction collapsing to zero hits, the operator
 * lowercasing that prevents a hard 400, and the trailing `*` that makes search-as-you-type work.
 *
 * With `semanticQuery`, `search` keeps the Lucene expression and drives retrieval (L1) exactly as
 * before; the plain-text copy is used only to rescore what L1 already found. Available in the
 * API_VERSION this module already pins.
 *
 * Azure rescores at most the top 50 of L1, so this can only reorder — it can never surface a
 * document the Lucene query failed to match.
 *
 * DERIVED FROM THE INDEX NAME, not a constant. A semantic configuration is scoped to the index that
 * declares it, so a hard-coded name is the one thing a staged index rename cannot survive: point
 * `SEARCH_INDEX` at a `chunks` index while this still says `demi-chunks-semantic` and every chunk
 * search 400s — naming a configuration the index does not declare is a hard error, not a degrade to
 * BM25. The convention `<index>-semantic` is what `azure/search/indexes/chunks.json` carries, and
 * keeping the two in step is why the definition file is the source of the name.
 */
function semanticConfigurationFor(index) {
  return `${index}-semantic`;
}

/**
 * The MONTH a 402 said the allowance was spent, `YYYY-MM` in UTC. Gates the request, not just the
 * log.
 *
 * Without the gate, every later search still asks for reranking, still gets 402, and still pays a
 * second round trip to retry stripped — on every debounced keystroke.
 *
 * A MONTH, NOT A BOOLEAN, and the earlier reasoning for the boolean has expired. It read: "the
 * allowance resets monthly and App Service restarts long before that, so a process-lifetime latch
 * is the whole lifetime that matters". `demi-api-test` now runs with `alwaysOn: true` (measured
 * 2026-08-24), so the worker outlives the allowance it is waiting on — a 402 on the 30th kept
 * Deep Search in BM25 order through every month after it, silently, because
 * `semanticErrorHandling: 'partial'` answers 200 with the same shape either way.
 *
 * No timer and no restart hook: the comparison runs on the request that would have been degraded,
 * so the first search of a new month re-enables ranking by itself.
 *
 * UTC, because Azure meters and resets on the UTC month. If the reset were keyed to a later
 * timezone, this would re-ask up to 7 hours early (Vancouver is UTC-7), take one 402 and re-latch
 * — one wasted round trip, self-correcting. Do not "fix" it to local time: that direction stays
 * latched into a month whose allowance has already reset, which is the failure this replaced.
 */
let semanticExhaustedMonth = null;

const utcMonth = () => new Date().toISOString().slice(0, 7);
const semanticIsExhausted = () => semanticExhaustedMonth === utcMonth();

/**
 * How often reranking was asked for, and how often it did not happen.
 *
 * Degradation here is invisible from the outside: `semanticErrorHandling: 'partial'` answers 200
 * with the same response shape in BM25 order, so a service reranking nothing looks exactly like one
 * reranking everything.
 *
 * These counters are the reading that works without a telemetry pipeline. They are per-process and start
 * again at zero on every recycle, which answers "since this process started, was ranking running?"
 * and nothing longer. That is the right resolution for a single-worker B1, and it is not a time
 * series — the durable version is an alert on the log line.
 */
const semanticCounters = {
  requested: 0,
  partial: 0,
  lastPartialReason: null,
  lastPartialAt: null,
  exhaustedAt: null
};

/**
 * What the counters say right now, plus the one number a reader actually wants.
 *
 * `ranked` is derived rather than counted: a search is ranked exactly when it asked and did not
 * degrade, and two counters that can drift apart would eventually disagree about the same search.
 * `exhausted` repeats the latch so a caller reading this does not have to infer it from a
 * timestamp being non-null.
 */
function semanticStats() {
  return {
    ...semanticCounters,
    ranked: semanticCounters.requested - semanticCounters.partial,
    exhausted: semanticIsExhausted()
  };
}

/**
 * One search that asked for reranking and got the BM25 order anyway.
 *
 * Whether L2 ran is invisible in the results — the same shape comes back either way, in a different
 * order. Both the log line and the counter live here so the two can never disagree about what
 * counted as degraded.
 */
function notePartialRerank(reason) {
  semanticCounters.partial++;
  semanticCounters.lastPartialReason = String(reason);
  semanticCounters.lastPartialAt = new Date().toISOString();
  logger.warn(
    `[ai-search] semantic reranking did not run: ${reason} — results are in BM25 order`
  );
}

/**
 * 402 means the semantic ranker's monthly free allowance is spent, for the rest of the month.
 *
 * Not a blip and not retryable — it is not in RETRY_STATUSES for that reason. Left unhandled it
 * would turn every Deep Search into a 500 until the calendar rolls over, which is a far worse
 * outcome than serving the BM25 order the product ran on until now. So it degrades instead, stops
 * asking, and says so once per process rather than on every keystroke.
 */
function noteSemanticExhausted() {
  if (semanticIsExhausted()) return;
  semanticExhaustedMonth = utcMonth();
  semanticCounters.exhaustedAt = new Date().toISOString();
  logger.warn(
    '[ai-search] HTTP 402: the semantic ranker free allowance is exhausted for this month. ' +
    'Falling back to BM25 ordering for the rest of the month. This is DEGRADED RANKING, not a ' +
    'failure — switch the service to the standard semantic plan to restore it.'
  );
}

/**
 * One search request. Every dataset goes through here so the ACL filter, the query shape and the
 * "null filter means unrestricted, empty filter is a bug" rule are written once.
 *
 * `opts.top` is the PAGE the caller asked for, which is not the same thing as one request: the
 * service returns at most SERVICE_MAX_TOP rows however many are asked for. A page larger than that
 * is filled by consecutive requests rather than truncated — see MAX_PAGE_ROWS. Truncating is what
 * this used to do, and it is invisible from outside: eagle-public's "Show All" asks for 500
 * (`table-template.component.ts:122-126`, MAX_SHOW_ALL_ITEMS), got 250 rows and a total in the
 * thousands, and nothing anywhere said the other 250 had been dropped.
 */
async function runSearch(index, opts = {}) {
  const terms = tokenize(opts.keywords);
  if (terms.length === 0 && !opts.matchAll) return { value: [], count: 0 };

  const wanted = Math.min(Math.max(Number(opts.top) || 20, 1), MAX_PAGE_ROWS);
  const body = {
    search: opts.matchAll ? '*' : buildQuery(terms, opts.fuzzy === true, opts.prefix === true),
    queryType: opts.matchAll ? 'simple' : 'full',
    top: Math.min(wanted, SERVICE_MAX_TOP),
    count: true
  };
  if (opts.select) body.select = opts.select;
  if (opts.searchFields) body.searchFields = opts.searchFields;
  // `top` is a page SIZE, `skip` is the offset before it — until this was here, `top` was the only
  // knob and result 251 was unreachable by any caller. Azure caps `$skip` at 100,000 and rejects
  // more, and a deep skip is re-scored work the service throws away, so this is a real ceiling
  // rather than a formality: page ~1,000 of a 10-row page is the end of the road, whatever the
  // count says. Floored at 0 because eagle-public can send `pageNum=-1` outright
  // (project.service.ts:33 defaults the page to 0 and api.ts:173 sends `pageNum - 1`).
  const skip = Math.max(0, Math.floor(Number(opts.skip) || 0));
  if (skip > 0) body.skip = Math.min(skip, MAX_SKIP - body.top);
  // Omitted when absent, never sent empty: an empty `$orderby` is a 400, and eagle-query returns
  // undefined precisely where the index can express no order.
  if (opts.orderby) body.orderby = opts.orderby;
  // Never under `matchAll`: `search: '*'` matches without matching any TERM, so there is nothing
  // for the analyzer to mark. Asking anyway spends a response body on empty highlight objects for
  // every row of a filtered list page, and it is one more thing the service can refuse on a query
  // shape it was never asked to highlight.
  if (opts.highlight && !opts.matchAll) {
    body.highlight = opts.highlight;
    body.highlightPreTag = HL_PRE;
    body.highlightPostTag = HL_POST;
  }
  // Omitted entirely when null. An empty-string filter is UNRESTRICTED, not "no matches".
  if (opts.filter) body.filter = opts.filter;

  // `matchAll` is excluded deliberately: `search: '*'` has no relevance signal to rescore, so
  // semantic ranking does nothing on it — and Azure bills per non-empty semantic query.
  // The 402 latch is the same idea: asking again cannot succeed THIS MONTH, and asking anyway
  // costs every search a wasted round trip before the stripped retry. Next month it can, so this
  // is a month comparison rather than a flag.
  const semantic = opts.semantic === true && !opts.matchAll && !semanticIsExhausted();
  if (semantic) {
    // The TOKENIZED terms rejoined, not opts.keywords verbatim. `tokenize` is what strips Lucene
    // operator characters, and operator syntax inside the semantic string is explicitly unsupported.
    body.semanticQuery = terms.join(' ');
    body.semanticConfiguration = semanticConfigurationFor(index);
    // Degrade rather than fail. A 1-SU Basic service allows 2 concurrent semantic requests, and the
    // frontend searches on a debounced keystroke — being over that is the expected path, not an
    // edge. `partial` returns the BM25 order instead of erroring.
    body.semanticErrorHandling = 'partial';
  }

  const path = `/indexes/${index}/docs/search?api-version=${API_VERSION}`;

  const once = async () => {
    // Counted per REQUEST, not per call: a page larger than SERVICE_MAX_TOP costs one semantic
    // query per request and the scorecard divides by this number. `semanticQuery` is deleted after
    // a 402, so the stripped retry below is correctly not counted as a semantic one.
    if (semantic && body.semanticQuery) semanticCounters.requested++;
    let data;
    try {
      data = await request(path, body);
    } catch (err) {
      if (!semantic || err.status !== 402) throw err;
      noteSemanticExhausted();
      // Counted as a degraded search, not just a latch event: this request was asked to rerank and
      // the order it served is BM25. Leave it out and `ranked` claims a ranked result for the one
      // search that provoked the 402.
      notePartialRerank('the monthly allowance is exhausted (HTTP 402)');
      delete body.semanticQuery;
      delete body.semanticConfiguration;
      delete body.semanticErrorHandling;
      data = await request(path, body);
    }

    // Whether L2 actually ran is invisible in the results — the same shape comes back either way,
    // in a different order. Unlogged, a service that is silently serving BM25 all day looks exactly
    // like one where reranking is working, and the scorecard would be measuring something no user
    // gets.
    if (semantic && data['@search.semanticPartialResponseReason']) {
      notePartialRerank(data['@search.semanticPartialResponseReason']);
    }
    return data;
  };

  const first = await once();
  const value = [...(first.value || [])];
  const count = first['@odata.count'] ?? value.length;

  // Fill the rest of the page, one service-sized request at a time. The loop ends on a SHORT
  // answer, never on the count: `@odata.count` is the index-wide total and a page can run out long
  // before it. Bounded at MAX_PAGE_ROWS / SERVICE_MAX_TOP requests — two today — so `pageSize`
  // cannot be turned into a request multiplier against a 1-SU service.
  let requested = body.top;
  let received = value.length;
  while (received === requested && value.length < wanted) {
    body.top = Math.min(wanted - value.length, SERVICE_MAX_TOP);
    const nextSkip = Math.min(skip + value.length, MAX_SKIP - body.top);
    // AT THE CEILING THE OFFSET STOPS MOVING, AND A REPEATED OFFSET IS A DUPLICATED PAGE. Both
    // iterations clamp to the same `MAX_SKIP - top`, so without this the second request re-fetches
    // the first one's rows and appends them: measured at `{top:500, skip:100000}` — reachable from
    // the controller as pageSize=500&pageNum=200 — the page came back 500 rows long with 250
    // distinct, row 251 identical to row 1, for the price of a second service call.
    //
    // Stopping short is the honest answer. `$skip` caps at 100000 and Azure has nothing past it to
    // give; a short page under a large total is what running out of index looks like, and it is
    // what the caller already handles on the last page of any result set.
    if (nextSkip <= body.skip) break;
    body.skip = nextSkip;
    requested = body.top;
    const rows = (await once()).value || [];
    received = rows.length;
    value.push(...rows);
  }

  return { value, count };
}

/**
 * Turn one hit's highlight into safe display markup.
 *
 * Escape first, mark second — never the other way round. Falls back to an empty string rather
 * than to chunk text: `content` is not retrievable, so there is no text here to fall back to.
 */
function snippetFrom(hit) {
  const highlights = (hit['@search.highlights'] && hit['@search.highlights'].content) || [];
  if (highlights.length === 0) return '';
  // Balanced PER FRAGMENT, then joined. A fragment is a window cut out of the chunk, and the cut
  // can land INSIDE a highlight — measured on the live index, one came back carrying a closing
  // sentinel whose opener had been trimmed away, which rendered as a stray `</mark>`.
  return highlights.map(balanceFragment).join(' … ');
}

/**
 * Display markup for one RETRIEVABLE field of a hit — the analyzer's own idea of what matched.
 *
 * Differs from `snippetFrom` in its fallback: chunk `content` is not retrievable, so there is
 * nothing to fall back to, whereas these fields are selected and always present. A field the query
 * did not match therefore comes back as escaped plain text rather than '', so the caller can bind
 * one string unconditionally and escaping happens exactly once, here.
 *
 * Azure returns the whole value for a short field like `name` and windowed fragments for a long one
 * like `description`, which is why the join matches `snippetFrom`'s.
 */
function markedField(hit, field) {
  const fragments = (hit['@search.highlights'] || {})[field] || [];
  if (fragments.length > 0) return fragments.map(balanceFragment).join(' … ');

  const raw = hit[field];
  return raw === undefined || raw === null ? '' : escapeHtml(String(raw));
}

/**
 * Escape one highlight fragment and convert its sentinels into balanced `<mark>` tags.
 *
 * Emits a tag only where a sentinel has a partner: an orphaned closer is dropped rather than
 * turned into markup, and an unclosed opener is closed at the end of the fragment. Browsers
 * tolerate a stray `</mark>`, but emitting unbalanced tags into an [innerHTML] binding is how a
 * snippet quietly starts eating the layout around it.
 */
function balanceFragment(fragment) {
  let depth = 0;
  let out = '';
  for (const ch of escapeHtml(fragment)) {
    if (ch === HL_PRE) { depth++; out += '<mark>'; }
    else if (ch === HL_POST) { if (depth > 0) { depth--; out += '</mark>'; } }
    else out += ch;
  }
  return out + '</mark>'.repeat(depth);
}

/**
 * Ranked chunk search, with the caller's visibility filter applied BY THE SERVICE.
 *
 * @param {object} opts
 * @param {string|null} opts.filter  OData filter from access-odata.filterFor(); null = unrestricted
 * @param {string} opts.keywords     raw user input
 * @param {boolean} [opts.fuzzy]
 * @param {number} [opts.top]
 * @returns {Promise<{items: Array, count: number}>}
 */
async function searchChunks(opts = {}) {
  const { configured, index } = config();
  if (!configured) {
    warnUnconfigured();
    return { items: [], count: 0 };
  }

  const { value, count } = await runSearch(index, {
    ...opts,
    // ON by default, and only here — the chunk index is the only one with a semantic
    // configuration, and asking for one that does not exist is a 400. Measured on 78 labels,
    // 2026-08-05, paired run in one session against the same corpus:
    //
    //   recall@1   0.308 -> 0.372     recall@10  0.590 -> 0.628     MRR  0.398 -> 0.472
    //   5 miss->hit and 2 hit->miss at k=10; 23 labels moved up, 7 down, 25 unchanged
    //   found@50 unchanged at 55 in BOTH arms, which is the check that L1 was untouched
    //
    // All three metrics move together with nothing regressing — the same bar FUZZY_BOOST cleared
    // and `anyTerms` failed. 5 vs 2 discordant pairs is not significant on its own (one SE ~0.056);
    // the case is the consistent direction, not the aggregate. Pass `semantic: false` to opt out,
    // which is how the scorecard measures the BM25 arm.
    semantic: opts.semantic !== false,
    // This `select` is what stops the API shipping whole chunks — it did not used to be. `content`
    // was `retrievable: false`, so the index enforced it; semantic ranking requires its configured
    // fields to be retrievable, so that flipped and the guarantee now lives HERE. Adding `content`
    // to this list is not a display tweak: it starts returning full chunk text to every caller.
    select: 'chunkId,documentId,projectId,pageNumber,read',
    highlight: 'content'
  });

  return {
    count,
    items: value.map(hit => ({
      chunkId: hit.chunkId,
      documentId: hit.documentId,
      projectId: hit.projectId,
      pageNumber: hit.pageNumber,
      read: hit.read,
      snippet: snippetFrom(hit),
      // Present only when L2 actually ran, so it doubles as the answer to "was this reranked?" —
      // undefined both when semantic was not asked for and when it was asked for but degraded to
      // a partial response. Nothing in the API forwards it; it is for instruments and diagnosis.
      rerankerScore: hit['@search.rerankerScore']
    }))
  };
}

/**
 * Project search. Mirrors the Typesense `query_by=name,displayName,description,proponent`.
 */
async function searchProjects(opts = {}) {
  const { configured, projectsIndex } = config();
  // THROWS rather than answering empty, and the caller turns that into a 502. An unconfigured
  // service has not searched anything, so `count: 0` would be a claim about the index that nobody
  // measured — the rule this controller was rebuilt around. It matters more now than it did:
  // every SORTED or FILTERED browse routes here, not only keyword search, so a degraded deploy
  // would render an empty documents tab and an empty project list under a 200.
  if (!configured) {
    warnUnconfigured();
    throw new Error('[ai-search] SEARCH_ENDPOINT is not set — the search did not run');
  }

  const { value, count } = await runSearch(projectsIndex, {
    ...opts,
    prefix: true,
    // `nameTokens` is `name` under the `filename` analyzer — `keywords=mine` matches "Mine Project",
    // which `en.microsoft` strips as a stopword from every other field here.
    searchFields: 'name,displayName,description,proponent,nameTokens',
    // Every name here must exist in the index — a stray one is a 400 on EVERY query, not a
    // missing field in the response. `trackProjectId` was in this list and is not in the index
    // (it is an int in Cosmos), which turned all project search into a silent fallback.
    select: PROJECT_SELECT,
    // Only the fields the result card renders. Highlighting a field nobody displays costs a
    // response body for nothing.
    highlight: 'name,displayName,description'
  });

  return {
    count,
    items: value.map(hit => ({
      ...hit,
      // The analyzer's own account of what it matched. The browser used to reconstruct this with a
      // regex and a Levenshtein, which marks words the index never hit and misses the stemmed ones
      // it did — `en.microsoft` matched `flooding` for `flood`, and the client marked neither.
      highlighted: {
        name: markedField(hit, 'name'),
        displayName: markedField(hit, 'displayName'),
        description: markedField(hit, 'description')
      }
    }))
  };
}

/**
 * Document search, in TWO legs — and the second one is not optional.
 *
 * Typesense indexed `projectName` on every document and searched it, so "Ajax" returned that
 * project's documents whether or not their own metadata said "Ajax". A Cosmos document row has
 * no `projectName` (it is resolved through a lookup at sync time), and an AI Search indexer reads
 * ONE container, so the field cannot come along.
 *
 * Measured against the live Typesense index before this was written — hits with `projectName` in
 * `query_by` versus without:
 *
 *   Ajax             850 -> 199   (77% lost)
 *   pipeline       2,267 -> 771   (66% lost)
 *   Coastal GasLink  823 -> 319   (61% lost)
 *   Site C         2,158 -> 1,570 (27% lost)
 *
 * Dropping it would have been a silent, severe recall regression. So the project-name match is
 * recovered by searching projects first and pulling their documents in by `projectId`. Direct
 * metadata matches rank ahead of project-name matches, which is the same intent Typesense's
 * ranking had.
 */
async function searchDocuments(opts = {}) {
  const { configured, documentsIndex } = config();
  // Same as searchProjects: not configured is not "no matches". See the comment there.
  if (!configured) {
    warnUnconfigured();
    throw new Error('[ai-search] SEARCH_ENDPOINT is not set — the search did not run');
  }

  const top = Math.min(Math.max(Number(opts.top) || 20, 1), MAX_PAGE_ROWS);
  // Every name here must exist in the index — a stray one is a 400 on EVERY query. The five added
  // 2026-08-23 are the ones eagle-public's document table renders and DEMI could not answer before
  // the index carried them: `datePosted` is its Date column, and the four `*Id` values are what
  // `idToList()` resolves against eagle-api's List collection.
  const select = DOCUMENT_SELECT;
  // Named once because leg two's exclusion clause below has to complement EXACTLY these fields.
  // A second copy is how the two would drift apart, and a drifted complement is the paging bug
  // this function carried for its whole life.
  // `fileNameTokens` is documentFileName under the `filename` analyzer — `keywords=mine` matches
  // `2019-mine-plan.pdf`, which `en.microsoft` on documentFileName does not.
  const searchFields = 'displayName,documentFileName,description,fileNameTokens';

  const direct = await runSearch(documentsIndex, {
    ...opts,
    top,
    prefix: true,
    searchFields,
    select,
    highlight: 'displayName,description'
  });

  const items = [...direct.value];
  // The total, assembled below from every leg that contributes rows. `direct.count` alone is what
  // it starts as, and what it stays when there is no project leg to run.
  let total = direct.count;

  // Leg two runs on EVERY page, not only when there is room for its rows. It owns part of the
  // total — `byProject.count` is index-wide — and eagle-public divides that total by `pageSize` to
  // decide how many pages exist. Skipping the leg on a full page made the total jump from 771 to
  // ~3,000 the moment the caller reached the last page of direct hits; reporting the PAGE LENGTH,
  // which this used to do (`Math.max(direct.count, items.length)`), was worse still: a probe with
  // 3 direct matches, one matching project and 500 documents under it reported 10 against a true
  // ~503, so the pager said one page and every later page was unreachable. Where the leg cannot
  // contribute rows its request is trimmed to one row — the count is what it is for.
  // `!opts.matchAll` IS THE DELIBERATE ANSWER TO "what does leg two mean with no keywords". Leg two
  // recovers documents whose PROJECT's NAME matches the query, and a keywordless search has no name
  // to match — running it under `matchAll` would search the projects index for `*`, pull in every
  // project the caller can read, and widen the document filter by `projectId` to the whole corpus.
  // That is the unfiltered-list answer this route exists to stop.
  //
  // Skipped rather than left to come back empty. Keywordless leg two happens to short-circuit
  // inside `runSearch` today — `tokenize('')` yields no terms — but that is an accident of the
  // tokenizer, not a decision, and it stops being true the moment `matchAll` is threaded through
  // `opts`, which is exactly what the keywordless filter path now does.
  if (opts.projectFilter !== undefined && !opts.matchAll) {
    const projects = await runSearch(config().projectsIndex, {
      keywords: opts.keywords,
      fuzzy: opts.fuzzy,
      prefix: true,
      filter: opts.projectFilter,
      searchFields: 'name,displayName,proponent,nameTokens',
      select: 'id',
      top: MAX_PROJECT_FANOUT
    });

    const projectIds = projects.value.map(p => String(p.id)).filter(Boolean);
    if (projectIds.length > 0) {
      // The caller's document ACL still applies — visibility of a project never widens access to
      // its documents, it only decides which ids are worth asking about.
      //
      // `not search.ismatch(...)` IS THE PAGING FIX, not a tidy-up. It hands leg two exactly the
      // documents the direct leg did NOT match, so the legs are disjoint sets and the sequence
      // eagle-public pages through is plainly leg one followed by leg two. While they overlapped
      // no stateless skip arithmetic could exist, because a row's position in `A ++ (B \ A)`
      // depends on how many of B's EARLIER rows were already in A, and only a scan from 0 knows
      // that. Measured on the live app before this clause, `keywords=pattullo` at pageSize=10 over
      // pages 0-25: 260 slots but 197 distinct ids, 63 repeats spread over 13 non-adjacent pages,
      // and 53 of the 250 matching documents unreachable from any page. Prod eagle-search walks
      // the same 26 pages with 260 distinct and 0 repeats. The comment that used to sit on `skip`
      // called the cost "one row on the boundary page"; that was wrong by two orders of magnitude,
      // because it accounted for the boundary and not for the offset drift on every page after it.
      //
      // The excluded query has to be the direct leg's OWN, byte for byte — same terms, same fuzzy
      // arm, same trailing `*`, same fields, `queryType: 'full'` — or the two stop being
      // complements and the gap comes straight back. Single quotes are doubled for the OData
      // literal: `tokenize` cannot emit one, but this is user text being spliced into a query
      // string. The empty query that would 400 here cannot be reached — the projects leg
      // short-circuits on an empty tokenisation, so `projectIds` is empty and this never runs.
      const directQuery = buildQuery(tokenize(opts.keywords), opts.fuzzy === true, true);
      const scope = `search.in(projectId, ${quoteList(projectIds)}, ',') and ` +
        `not search.ismatch('${directQuery.replace(/'/g, "''")}', '${searchFields}', 'full', 'any')`;
      const byProject = await runSearch(documentsIndex, {
        matchAll: true,
        // Sized to the DEFICIT, which is now exactly what the page can take: no row this leg
        // returns is dropped any more, so asking for the whole `top` would fetch rows the page
        // cannot use — and the next page re-fetches from the right offset regardless. One row
        // where the page is ALREADY full: no row of this leg can be used there (the fill loop
        // breaks immediately), and the count is the only reason the request is issued.
        top: Math.max(1, top - items.length),
        select,
        orderby: opts.orderby,
        // Leg two continues where the DIRECT hits ran out, and with disjoint legs that arithmetic
        // is exact rather than approximate. The direct leg owns union positions 0..direct.count,
        // so a page starting at `skip` starts `skip - direct.count` rows into this leg, and
        // consecutive pages cover consecutive ranges with no gap and no overlap. It is computed
        // from `skip` alone, so page 17 fetched on its own returns what walking pages 0-16 first
        // would have returned — there is no cross-request state here, and there cannot be.
        skip: Math.max(0, (Number(opts.skip) || 0) - (direct.count || 0)),
        filter: opts.filter ? `(${opts.filter}) and ${scope}` : scope
      });

      for (const doc of byProject.value) {
        if (items.length >= top) break;
        items.push(doc);
      }

      // No intersection left to subtract: the exclusion clause already removed the direct matches
      // from this leg, so `byProject.count` counts precisely what leg one does not return and the
      // two simply add up. This replaced a fourth, count-only request that measured the overlap so
      // it could be subtracted — the fix costs one service call per document page LESS than the
      // bug did, three where there were four.
      total = direct.count + byProject.count;
    }
  }

  // Leg two's documents matched on their PROJECT's name, not their own metadata, so they carry no
  // `@search.highlights` — `markedField` returns their escaped text and the card renders unmarked,
  // which is the honest result: nothing in that document's own fields matched the query.
  return {
    count: total,
    items: items.map(hit => ({
      ...hit,
      highlighted: {
        displayName: markedField(hit, 'displayName'),
        description: markedField(hit, 'description')
      }
    }))
  };
}

/** Project ids beyond this add nothing: the document page is capped long before they matter. */
const MAX_PROJECT_FANOUT = 25;

/**
 * Remove one row from an index by key.
 *
 * REQUIRED, not tidiness: the `_ts` high-water mark cannot see deletes, so a deleted project or
 * document stays searchable forever otherwise. Measured on this index — deleting a probe project
 * and its document through the API left both rows returning from search.
 *
 * Typesense removed deleted documents from its index, so shipping without this would have been a
 * regression rather than a missing nicety.
 *
 * Best-effort by design: the row is already gone from Cosmos and the caller has already succeeded.
 * Loud on failure, because the consequence is a deleted record that is still findable.
 */
async function deleteFromIndex(index, id) {
  const { configured } = config();
  if (!configured) {
    warnUnconfigured();
    return 0;
  }

  try {
    await request(`/indexes/${index}/docs/index?api-version=${API_VERSION}`, {
      value: [{ '@search.action': 'delete', id: String(id) }]
    });
    return 1;
  } catch (err) {
    logger.error(
      `[ai-search] could not remove ${index}/${id} (${err.message}). ` +
      'It remains searchable until this is retried.'
    );
    return 0;
  }
}

/** One index write carries at most this many actions — the service's own cap. */
const INDEX_BATCH_ROWS = 1000;

/**
 * Write rows' ACLs straight into an index.
 *
 * REQUIRED since every document list became an index read: the indexer is a `_ts` high-water mark
 * on a PT5M schedule, so an unpublish hid the bytes at once and left the ROW listed and searchable
 * for up to five minutes. The Cosmos write stays authoritative; this only stops search lagging it.
 *
 * `merge`, never `mergeOrUpload`: a row the indexer has not created yet is not findable, so a
 * merge that misses withholds nothing, while an upload would insert a title-less half-row that
 * renders in results until the next pass.
 *
 * Best-effort, like `deleteFromIndex` — the visibility change has already landed in Cosmos and the
 * caller has already succeeded. Loud on failure: the row stays over-permissive until the indexer
 * catches up.
 *
 * @param {Array<{id: string, read: string[], isPublished: boolean}>} rows
 * @returns {Promise<number>} rows the service accepted
 */
async function writeAcls(index, rows) {
  const { configured } = config();
  if (!configured) {
    warnUnconfigured();
    return 0;
  }
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  let merged = 0;

  for (let start = 0; start < rows.length; start += INDEX_BATCH_ROWS) {
    const batch = rows.slice(start, start + INDEX_BATCH_ROWS);
    try {
      const result = await request(`/indexes/${index}/docs/index?api-version=${API_VERSION}`, {
        value: batch.map(row => ({
          '@search.action': 'merge',
          id: String(row.id),
          read: row.read,
          isPublished: Boolean(row.isPublished)
        }))
      });

      // A 207 is an `ok` response carrying per-row verdicts, so the status of the request says
      // nothing about the rows. 404 is expected and benign — the indexer has not created that row
      // yet, and a row that is not in the index is not findable.
      const failed = (result.value || []).filter(r => r.status === false);
      merged += batch.length - failed.length;

      const real = failed.filter(r => r.statusCode !== 404);
      if (real.length > 0) {
        logger.error(
          `[ai-search] could not write ${real.length} of ${batch.length} ACLs to ${index} ` +
          `(${real[0].errorMessage || 'no message'}). Those rows stay as indexed until the ` +
          'indexer\'s next pass.'
        );
      }
    } catch (err) {
      logger.error(
        `[ai-search] ACL write to ${index} failed for ${batch.length} rows (${err.message}). ` +
        'They stay as indexed until the indexer\'s next pass.'
      );
    }
  }

  return merged;
}

/** The index names, so callers name them once and never hardcode a string. */
function indexes() {
  const { index, projectsIndex, documentsIndex } = config();
  return { chunks: index, projects: projectsIndex, documents: documentsIndex };
}

/** OData list literal, with quotes doubled — the same escaping access-odata.js applies. */
function quoteList(values) {
  return `'${values.map(v => String(v).replace(/'/g, "''")).join(',')}'`;
}

/**
 * Remove every indexed chunk of a document.
 *
 * REQUIRED for correctness, not tidiness: the indexer's `_ts` high-water mark cannot see deletes
 * at all (measured — a run right after a hard delete processed 0 items), so without this the full
 * text of a deleted document stays searchable indefinitely.
 *
 * Keys are READ BACK, never re-derived. The indexer mints them with `base64Encode`, which is .NET
 * `HttpServerUtility.UrlTokenEncode` — standard base64, `+`/`/` swapped for `-`/`_`, and the `=`
 * padding replaced by a DIGIT COUNT of the stripped padding (`…YzA=` indexes as `…YzA1`).
 * Re-implementing that here would delete nothing while reporting success the day it drifts.
 */
async function deleteChunksForDocument(documentId, opts = {}) {
  const { configured, index } = config();
  if (!configured) {
    warnUnconfigured();
    return 0;
  }

  const id = String(documentId);
  // 25 rounds x 1000 keys = 25,000 chunks, comfortably past the largest document in the corpus.
  // A cap rather than an open loop: if a delete ever silently fails, this must be loud and bounded
  // rather than spinning against the index forever.
  const maxRounds = opts.maxRounds || 25;
  let deleted = 0;
  let previousRemaining = Infinity;

  try {
    for (let round = 1; round <= maxRounds; round++) {
      const found = await request(`/indexes/${index}/docs/search?api-version=${API_VERSION}`, {
        search: '*',
        filter: `documentId eq '${id.replace(/'/g, "''")}'`,
        select: 'id',
        // The page cap, not the document's size. `count` reports how many are really left, which
        // is what decides whether another round is needed.
        top: 1000,
        count: true
      });

      const keys = (found.value || []).map(d => d.id).filter(Boolean);
      if (keys.length === 0) return deleted;

      const remaining = found['@odata.count'] ?? keys.length;
      // Deletes are not read-your-write on this service, so a round CAN legitimately re-see keys it
      // just removed. What is not legitimate is the total never falling: that means the delete is
      // not landing, and another 24 rounds of the same call will not change it.
      if (round > 1 && remaining >= previousRemaining) {
        logger.warn(
          `[ai-search] document ${id} still reports ${remaining} indexed chunks after ` +
          `${deleted} deletions; stopping without progress. Its remaining text stays searchable.`
        );
        return deleted;
      }
      previousRemaining = remaining;

      await request(`/indexes/${index}/docs/index?api-version=${API_VERSION}`, {
        value: keys.map(key => ({ '@search.action': 'delete', id: key }))
      });
      deleted += keys.length;

      if (remaining <= keys.length) return deleted;
    }

    logger.warn(
      `[ai-search] document ${id} exceeded ${maxRounds} delete rounds after ${deleted} deletions. ` +
      'Re-run the delete to clear the remainder.'
    );
    return deleted;
  } catch (err) {
    // Best-effort by design: the Cosmos rows are already gone and the caller has already
    // succeeded. Loud, because the consequence is searchable text for a deleted document.
    //
    // Returns what was actually removed before the failure, not 0 — a later round throwing does not
    // un-delete the earlier ones, and reporting 0 would understate `indexEntriesRemoved` in the
    // purge summary.
    logger.error(
      `[ai-search] could not remove indexed chunks for document ${id} (${err.message}) ` +
      `after deleting ${deleted}. Its remaining text stays searchable until this is retried.`
    );
    return deleted;
  }
}


/**
 * The ids of the documents matching a filter, for scoping a CHUNK query to them.
 *
 * The `chunks` index carries seven fields and none of them is document metadata, so a filter on
 * `type`, `milestone`, `datePosted` or the rest cannot be evaluated against a chunk at all. The
 * alternative to this function is denormalising that metadata onto 1,128,733 chunk rows and
 * re-stamping it on every document edit — the eagle-search machinery DEMI deliberately did not
 * port. Two queries instead: resolve the documents, then scope the chunks to them.
 *
 * BOUNDED, AND THE BOUND IS REPORTED. `search.in` takes a large list but not an unlimited one, and
 * a filter like `and[type]=Letter` matches over twelve thousand documents. So this returns the
 * total as well as the ids, and a caller whose match set exceeds `cap` must treat the filter as
 * INEXPRESSIBLE — answer with the key still named in `meta.dropped` — rather than scope to an
 * arbitrary prefix of it. A truncated scope would silently answer "these are the chunks matching
 * your filter" about a subset nobody chose, which is worse than saying the filter did not apply.
 *
 * `matchAll` with no keywords: the caller's terms belong to the CHUNK query, not this one. A
 * document whose text mentions the term is found by the chunk search; this query exists only to
 * answer "which documents carry this metadata".
 *
 * ONE SERVICE CALL, because `cap + 1` is exactly `SERVICE_MAX_TOP`. So a filtered chunk page costs
 * two round trips, not three. Raising the cap past this point buys nothing today and costs another
 * call per 250 ids — see the constant.
 */
async function documentIdsMatching(filter, cap = DOCUMENT_SCOPE_CAP) {
  const { configured, documentsIndex } = config();
  if (!configured) {
    warnUnconfigured();
    throw new Error('[ai-search] SEARCH_ENDPOINT is not set — the search did not run');
  }

  // `cap + 1` is not an off-by-one: it is how the caller learns it was over the cap without a
  // second round trip. `@odata.count` is authoritative, but asking for one more than we can use
  // means a service that ever stopped returning a count still cannot look like a full match set.
  const { value, count } = await runSearch(documentsIndex, {
    matchAll: true,
    filter,
    select: 'id',
    top: Math.min(cap + 1, MAX_PAGE_ROWS)
  });

  const ids = (value || []).map(row => String(row.id)).filter(Boolean);
  // `cap` is `MAX_PAGE_ROWS - 1`, so asking for `cap + 1` is a request one page CAN answer — which
  // is what makes the row count a sufficient signal on its own when `@odata.count` is missing. The
  // earlier version set the cap above what one page returns, so a filter matching 501 to 20,000
  // documents came back as an arbitrary 500-id prefix and was reported to the caller as applied.
  //
  // One comparison, not two: an `ids.length <= cap` clause beside this looks like it covers the
  // no-count path, and does not — the fallback below already makes `total` the page length there,
  // so the extra clause can never change the answer. A guard nothing can trip reads as protection
  // that is not there.
  const total = Number.isFinite(count) ? count : ids.length;
  const withinCap = total <= cap;
  // NO PREFIX. A partial scope answers "the chunks matching your filter" about a subset nobody
  // chose, and the caller cannot tell it from a complete answer; the empty list forces the caller
  // to report the filter as inexpressible instead.
  return { ids: withinCap ? ids : [], total, withinCap };
}

module.exports = {
  DOCUMENT_SELECT,
  PROJECT_SELECT,
  searchChunks,
  searchProjects,
  searchDocuments,
  documentIdsMatching,
  DOCUMENT_SCOPE_CAP,
  quoteList,
  deleteChunksForDocument,
  deleteFromIndex,
  writeAcls,
  indexes,
  // The controller refuses a larger page rather than letting this layer clamp one, so the limit
  // has to be readable from there — two copies of it would drift into exactly the silent
  // truncation it exists to prevent.
  MAX_PAGE_ROWS,
  // Exported for the chunk window, which must stay inside ONE service request: a chunk page is
  // fetched on every debounced keystroke against a Basic 1-SU service, and a window larger than
  // this turns each of those into two requests.
  SERVICE_MAX_TOP,
  // Exported so a caller can tell "search is not configured" from "search found nothing". The API
  // is right to treat the first as a degraded state and return []; an instrument is not, and must
  // refuse to publish a zero it cannot distinguish from an unset app setting.
  config,
  semanticStats,
  // Exported for tests. The 402 latch clears on its own at the month rollover and no sooner, so
  // without this seam one 402 test would disable semantic for every test after it inside the same
  // calendar month. The counters reset with it for the same reason: a partial response asserted in
  // one test would otherwise still be in the totals the next test reads.
  resetSemanticExhausted: () => {
    semanticExhaustedMonth = null;
    Object.assign(semanticCounters, {
      requested: 0, partial: 0, lastPartialReason: null, lastPartialAt: null, exhaustedAt: null
    });
  },
  // Exported for `src/scripts/apply-search-definitions.js`, which PUTs index and indexer
  // definitions and needs the same data-plane token this module already knows how to mint:
  // the `https://search.azure.com/.default` scope, the AZURE_CLIENT_ID identity selection, and
  // the 5-minute-margin cache. A second credential in the script would be a second place for
  // that scope string to be wrong.
  getToken,
  tokenize,
  buildQuery,
  snippetFrom,
  escapeHtml,
  HL_PRE,
  HL_POST
};
