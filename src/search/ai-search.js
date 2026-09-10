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
// The same renderer the ACL clause uses, so a scope and the ACL it rides beside cannot disagree
// about how an id list is written.
const { inClause, quote } = require('../helpers/access-odata');

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

/**
 * The fields a CHUNK hit carries back. Same invariant as the two above: every name must exist in
 * the index or every chunk query is a 400.
 *
 * `content` IS DELIBERATELY ABSENT, and that is the whole reason this list is narrow. `content` was
 * `retrievable: false`, so the index enforced it; semantic ranking requires its configured fields
 * to be retrievable, so that flipped and the guarantee now lives here. Adding `content` is not a
 * display tweak — it starts returning full chunk text to every caller.
 *
 * Named and exported like the other two so `/health/search-schema` probes the live index with what
 * the app actually sends, and so a test can hold it against the committed `chunks.json`. It was an
 * inline literal with no test at all while both of its neighbours had one.
 */
const CHUNK_SELECT = 'chunkId,documentId,projectId,pageNumber,read';

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
 * Only the document-only keys a chunk carries no copy of are resolved this way — dates,
 * `isFeatured`, `legislation`, `documentSource`. DERIVED, not chosen: `SERVICE_MAX_TOP - 1` keeps
 * the whole resolution inside one service request, and a hand-picked number silently stops agreeing
 * with what one request can return. Over the cap the key stays dropped rather than being applied to
 * an arbitrary prefix. See wiki Search-Query-Construction#chunk-filters-answer-on-the-chunks-own-copy.
 */
const DOCUMENT_SCOPE_CAP = SERVICE_MAX_TOP - 1;

/**
 * How long an answer about the LIVE index is trusted before it is asked again. Bounded rather than
 * read at startup: the index is widened by an operator PUT no app release is involved in, so a
 * process that cached "the field is not there" would drop the filter until somebody restarted it.
 */
const LIVE_SCHEMA_TTL_MS = 10 * 60 * 1000;

/**
 * How long "the question could not be answered" is held instead — a 403 or a timeout is not a fact
 * about the index and clears in seconds. Cached at all so a failing service gets one probe per
 * burst of keystrokes rather than one per keystroke.
 */
const UNKNOWN_STATUS_TTL_MS = 30 * 1000;

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

  // What the live index could not answer, for this request as a whole. The fill loop below issues
  // more than one call, so the one-retry budget and the mark it leaves both span all of them.
  let degraded = null;

  /**
   * One service call, with the schema-drift degrade around it.
   *
   * A 400 naming a field the live index does not carry is the failure that took prod's Document
   * tab down for 65 minutes on 2026-09-08: the deploy pipeline applies no index definition, so a
   * release that widens a select against an index nobody widened 400s EVERY query. Dropping the
   * field costs that one column; rethrowing costs the whole tab.
   *
   * ONE retry, and only for a field this layer may drop:
   * - a second 400 rethrows, because narrowing until the query passes is how a deploy against a
   *   wholly stale index would answer 200 with none of what the caller asked for;
   * - a visibility field rethrows, and the controller answers 502 SEARCH_SCHEMA_DRIFT;
   * - a field named nowhere this can edit rethrows unretried, since the retry would be identical.
   */
  const send = async () => {
    try {
      return await request(path, body);
    } catch (err) {
      const field = err.status === 400 ? missingPropertyFrom(err) : null;
      if (!field || degraded || VISIBILITY_FIELDS.has(field) || !dropField(body, field)) throw err;
      degraded = { missing: [field] };
      // ERROR, not warn: nothing else says the index is behind the code, and the page being served
      // is missing a column the app asked for. `{index, field}` are log fields so the alert and
      // the operator can filter on the field rather than parse the sentence.
      logger.error(
        `[ai-search] the ${index} index cannot answer '${field}' — retried without it, so this ` +
        'page is narrower than the app asked for. Widen the index and reindex.',
        { index, field }
      );
      return request(path, body);
    }
  };

  const once = async () => {
    // Counted per REQUEST, not per call: a page larger than SERVICE_MAX_TOP costs one semantic
    // query per request and the scorecard divides by this number. `semanticQuery` is deleted after
    // a 402, so the stripped retry below is correctly not counted as a semantic one.
    if (semantic && body.semanticQuery) semanticCounters.requested++;
    let data;
    try {
      data = await send();
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
      data = await send();
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

  return { value, count, degraded };
}

/**
 * The index field named in an AI Search 400, or null when the failure is something else.
 *
 * ONE COPY OF THE PATTERN, because two readers depend on it: the schema probe below turns a match
 * into `{ok: false}`, and `controllers/search.js` turns it into the `SEARCH_SCHEMA_DRIFT` code on
 * its 502. A second spelling of the regex is a second thing to be quietly wrong.
 *
 * The message is the service's own: `Invalid expression: Could not find a property named
 * 'fileSize' on type 'search.document'.` — the exact 400 that took prod's Document tab down on
 * 2026-09-08, when the deployed app selected a field the live index did not carry.
 */
function missingPropertyFrom(err) {
  const match = /Could not find a property named '([^']+)'/.exec((err && err.message) || '');
  return match ? match[1] : null;
}

/**
 * The fields the degrade above must never drop.
 *
 * Dropping one of these does not narrow the answer, it WIDENS it. `read` is the caller's ACL,
 * `isPublished` is the mirror the redactor derives from it, and `vis` is the per-record dial map —
 * a hit that comes back without `vis` has every field at its `defaultVis`, which is the fail-open
 * direction the redactor tests hold. An index that cannot answer them is a 502
 * (`SEARCH_SCHEMA_DRIFT`) so an operator widens the index, rather than a page served wider than
 * the caller may see.
 */
const VISIBILITY_FIELDS = new Set(['read', 'isPublished', 'vis']);

/**
 * Take one field name out of every list in a search body that can name it.
 *
 * `filter` is deliberately not one of them: it carries the ACL clause, and a filter that lost a
 * term admits MORE rows. A field named only there changes nothing here, so `false` comes back and
 * the caller rethrows rather than paying for a retry that fails identically.
 *
 * An emptied `select` or `searchFields` refuses the whole drop instead of being deleted: a request
 * with no `select` returns every RETRIEVABLE field, which on the chunks index is the entire passage
 * text — the one thing CHUNK_SELECT exists to withhold. `orderby` and `highlight` may go: the
 * service's own relevance order and no highlights are both narrower answers, not wider ones.
 *
 * @returns {boolean} whether the body changed, so the caller knows a retry can differ
 */
function dropField(body, field) {
  const changes = [];
  for (const key of ['select', 'searchFields', 'highlight', 'orderby']) {
    if (typeof body[key] !== 'string') continue;
    const parts = body[key].split(',');
    // `select`, `searchFields` and `highlight` are field names; an `orderby` clause is
    // `<field> asc|desc` and a `highlight` entry may carry a `-<count>` suffix.
    const kept = parts.filter(part => part.trim().split(/[\s-]/)[0] !== field);
    if (kept.length === parts.length) continue;
    if (kept.length === 0 && (key === 'select' || key === 'searchFields')) return false;
    changes.push([key, kept]);
  }
  for (const [key, kept] of changes) {
    // Rejoined the way each list is written elsewhere in this module, so a body that degraded reads
    // like one that never had the field.
    if (kept.length === 0) delete body[key];
    else body[key] = kept.map(part => part.trim()).join(key === 'orderby' ? ', ' : ',');
  }
  return changes.length > 0;
}

/**
 * One `degraded` mark for a search that ran in several legs — document search runs up to three.
 * Null when every leg answered in full, so the controller can spread it into `meta` unconditionally.
 */
function mergeDegraded(results) {
  const missing = [...new Set(
    results.flatMap(result => (result && result.degraded ? result.degraded.missing : []))
  )];
  return missing.length > 0 ? { missing } : null;
}

/**
 * Ask the LIVE index whether it can answer a `select` and an `$orderby` — the committed-vs-live
 * gate the deploy pipeline had no way to run.
 *
 * `top: 0, count: false` so the service validates the projection and the order and returns no rows
 * and no count: the answer is a status, not data, and it costs one empty page. Needs no role beyond
 * the Search Index Data Reader the app already holds, which is the point — applying index
 * definitions needs Search Service Contributor and the Function identity does not have it.
 *
 * ONLY the missing-property 400 resolves; every other failure throws. A probe that answered
 * `{ok: false}` for a timeout or a 403 would report schema drift for a network blip and send an
 * operator to widen an index that is already correct.
 *
 * @param {object} opts
 * @param {string} opts.indexName   the LIVE index name, not the schema name
 * @param {string|string[]} [opts.select]
 * @param {string|string[]} [opts.orderby]
 * @returns {Promise<{ok: boolean, index: string, missing?: string[]}>}
 */
async function probeIndexSchema({ indexName, select, orderby } = {}) {
  const list = value => (Array.isArray(value) ? value.join(',') : value);
  const body = { search: '*', top: 0, count: false };
  if (select) body.select = list(select);
  // Joined with ', ' — `$orderby` clauses are comma-separated and each carries its own direction.
  if (orderby) body.orderby = Array.isArray(orderby) ? orderby.join(', ') : orderby;

  try {
    await request(`/indexes/${indexName}/docs/search?api-version=${API_VERSION}`, body);
    return { ok: true, index: indexName };
  } catch (err) {
    const missing = err.status === 400 ? missingPropertyFrom(err) : null;
    if (!missing) throw err;
    return { ok: false, index: indexName, missing: [missing] };
  }
}

/**
 * Whether the LIVE index can evaluate this `$filter` over `property`, asked by sending it.
 *
 * Only a 400 naming `property` is the answer "no" — every other failure throws, so the caller
 * answers "unknown" rather than dropping a working filter over a blip. Asked with a `top: 0` search
 * because reading the index definition needs Search Service Contributor, which this identity lacks.
 */
async function filterAnswerable(indexName, property, filter) {
  try {
    await request(`/indexes/${indexName}/docs/search?api-version=${API_VERSION}`,
      { search: '*', top: 0, count: false, filter });
    return true;
  } catch (err) {
    if (err.status === 400 && blamedPropertyFrom(err) === property) return false;
    throw err;
  }
}

/**
 * The property a 400 blames, in the two spellings the service uses for one fact: `Could not find a
 * property named 'typeId'` for a field the index lacks, `The field 'typeId' in the filter clause is
 * not filterable` for one it carries unfilterable. Both mean "this filter cannot be sent".
 */
function blamedPropertyFrom(err) {
  const named = missingPropertyFrom(err);
  if (named) return named;
  const match = /The field '([^']+)' in the filter clause is not filterable/
    .exec((err && err.message) || '');
  return match ? match[1] : null;
}

/** How many rows of an index match a filter, in one `$count`-only request. */
async function countMatching(indexName, filter) {
  const data = await request(`/indexes/${indexName}/docs/search?api-version=${API_VERSION}`,
    { search: '*', top: 0, count: true, filter });
  const count = data['@odata.count'];
  return Number.isFinite(count) ? count : null;
}

/** Shared by the schema answer and the coverage probe, so one TTL governs both. */
let chunkParentFieldCache = null;

/**
 * What the LIVE `chunks` index can do with the parent-field filters, cached for
 * `LIVE_SCHEMA_TTL_MS`. Asked of the service, never of the packaged `chunks.json`: the index is
 * applied by a separate operator step, so between an app release and the index PUT the two
 * disagree and the clause is a 400. See wiki Search-Query-Construction#chunk-filters-answer-on-the-chunks-own-copy.
 *
 * `fields` and `version` are passed in so this module keeps knowing nothing about the repositories;
 * `opts` is the `{now, ttlMs}` test seam.
 *
 * @returns {Promise<{known: boolean, available: string[], missing: string[], unknown: string[],
 *   unstamped: ?number}>} per field, not all-or-nothing: filter only on `available`. `known: false`
 *   marks a partial answer. `unstamped` is `null` for "cannot say", never 0.
 */
function chunkParentFieldStatus(fields, version, opts = {}) {
  const now = opts.now || Date.now();
  const ttlMs = opts.ttlMs === undefined ? LIVE_SCHEMA_TTL_MS : opts.ttlMs;
  // The PROMISE is cached, not its value: Deep Search fires on a debounced keystroke, so a cold
  // cache is hit by a burst and a cached value would send one probe per request in flight.
  if (chunkParentFieldCache && now - chunkParentFieldCache.at < chunkParentFieldCache.ttl) {
    return chunkParentFieldCache.promise;
  }
  const entry = { at: now, ttl: ttlMs, promise: null };
  // An "unknown" is a hiccup, not a schema fact, and clears in seconds — held for the schema TTL
  // it would make ten minutes of requests guess from one blip.
  entry.promise = readChunkParentFieldStatus(fields, version)
    .then((status) => {
      if (!status.known) entry.ttl = Math.min(ttlMs, UNKNOWN_STATUS_TTL_MS);
      return status;
    })
    // A REJECTION IS THE SAME UNKNOWN, and without this it is the worst one there is: a cached
    // rejected promise rethrows to every caller that touches it for the full schema TTL, so one
    // failed probe 502s the Deep Search tab for ten minutes. Resolved instead, on the short TTL,
    // which is what makes it a withheld filter rather than a dead tab.
    .catch((err) => {
      logger.warn(`[ai-search] the live chunk parent-field probe could not run: ${err.message}`);
      entry.ttl = Math.min(ttlMs, UNKNOWN_STATUS_TTL_MS);
      // `fields` deliberately not spread: it is a plausible source of the throw being handled, and
      // a recovery that rethrows is no recovery.
      return {
        known: false,
        available: [],
        missing: [],
        unknown: Array.isArray(fields) ? [...fields] : [],
        unstamped: null
      };
    });
  chunkParentFieldCache = entry;
  return entry.promise;
}

async function readChunkParentFieldStatus(fields, version) {
  const { configured, index } = config();
  if (!configured) {
    warnUnconfigured();
    return { known: false, available: [], missing: [], unknown: [...fields], unstamped: null };
  }

  // One probe per field, not one over all four: the service names ONE offending field per 400, so
  // a combined probe reports the first and drops three filters the index answers perfectly well.
  // Issued together — they are independent reads, and in series they sat in front of every
  // filtered Deep Search.
  const probes = await Promise.allSettled(
    fields.map(field => filterAnswerable(index, field, `${field} eq 'probe'`)));

  const available = [];
  const missing = [];
  const unknown = [];
  probes.forEach((probe, i) => {
    if (probe.status !== 'rejected') {
      (probe.value ? available : missing).push(fields[i]);
      return;
    }
    // Undecided, not absent: the reader filters on `available` only, so one field's hiccup costs
    // one filter rather than all four.
    logger.warn(`[ai-search] could not read the live ${fields[i]} filter schema: ` +
      `${probe.reason.message}`);
    unknown.push(fields[i]);
  });

  if (missing.length) {
    logger.error(
      `[ai-search] the ${index} index cannot filter on ${missing.join(', ')} — those filter ` +
      'keys are being dropped and reported to the caller. Apply the index definition and run ' +
      'the chunk parent-field backfill.',
      { index, missing }
    );
  }

  // A partial schema answer is not worth a count request: the mark it feeds is advisory, the
  // dropped filters are not.
  if (unknown.length) return { known: false, available, missing, unknown, unstamped: null };

  try {
    // Not asked when the index carries none of the fields: no facet filter can be emitted then, so
    // the count could not change any answer.
    const unstamped = available.length ? await staleChunkCount({ version }) : null;
    return { known: true, available, missing, unknown: [], unstamped };
  } catch (err) {
    // Only the backfill mark went unanswered — expressibility is settled, so all four fields stay
    // usable and `known: false` says the answer is partial.
    logger.warn(`[ai-search] could not count unstamped chunks: ${err.message}`);
    return { known: false, available, missing, unknown: [], unstamped: null };
  }
}

/** The "never stamped, or stamped under an older list" predicate. One spelling, two readers. */
function staleStampClause(version) {
  return `parentFieldsVersion lt ${version} or parentFieldsVersion eq null`;
}

/**
 * Clauses joined with `and`, each bracketed once there is more than one: `or` binds looser than
 * `and`, so an unbracketed stamp clause beside an ACL would match rows the caller cannot see.
 */
function allOf(clauses) {
  return clauses.length === 1 ? clauses[0] : clauses.map(clause => `(${clause})`).join(' and ');
}

/**
 * How many chunks still carry an older parent-field stamp than the code writes — over the whole
 * index, or under one caller's own predicate (`aclFilter`, `projectIds`) when it is passed.
 *
 * Read off the STAMP, never off the four values: a document with no List refs legitimately stamps
 * four nulls, so a count of those never reaches zero and the mark it gates never clears. `null` is
 * "cannot say", never 0 — an index carrying no stamp column cannot tell, and neither can a version
 * that is not a number. See wiki Search-Query-Construction#deep-search-can-be-degraded-three-ways.
 *
 * @returns {Promise<?number>}
 */
async function staleChunkCount({ version, aclFilter = null, projectIds = [] } = {}) {
  const { configured, index } = config();
  if (!configured) {
    warnUnconfigured();
    return null;
  }
  if (!Number.isFinite(version)) {
    logger.warn('[ai-search] no chunk parent-field version was supplied — the backfill probe ' +
      'cannot say whether the stamp is current', { index });
    return null;
  }

  const clauses = [staleStampClause(version)];
  if (aclFilter) clauses.push(aclFilter);
  if (projectIds.length) clauses.push(inClause('projectId', projectIds));
  const filter = allOf(clauses);

  try {
    return await countMatching(index, filter);
  } catch (err) {
    if (err.status === 400 && blamedPropertyFrom(err) === 'parentFieldsVersion') {
      logger.warn(`[ai-search] the ${index} index carries no parentFieldsVersion — whether ` +
        'the chunk parent-field backfill has finished is unknown, not done.', { index });
      return null;
    }
    throw err;
  }
}

/**
 * The index rows a stamp has never reached, `{id, chunkId, documentId}` each.
 *
 * `id` is the index KEY, read back rather than re-derived — the indexer mints it with a .NET
 * base64 variant (`deleteDocuments`) — and `chunkId` is the Cosmos row's own id. Both are needed
 * because the caller has to tell a chunk that is merely unstamped from one whose Cosmos row is
 * GONE: the indexer has no deletion detection, so a deleted chunk keeps its index row forever, no
 * stamp can ever reach it, and the unstamped count it is part of never reaches zero.
 *
 * `projectId` matches on PRESENCE: `null` asks for the rows whose projectId is null, absent asks
 * across every project.
 *
 * BOUNDED. `maxRows` caps the paging and `complete` says whether the answer is the whole set, so a
 * caller acts on a truncated page knowing it is one.
 *
 * @returns {Promise<?{rows: Array, total: number, complete: boolean}>} `null` for "cannot say" —
 *          search unconfigured, no version to compare, or an index with no stamp column.
 */
async function listStaleChunkIds({ version, projectId, maxRows = 2000 } = {}) {
  const { configured, index } = config();
  if (!configured) {
    warnUnconfigured();
    return null;
  }
  if (!Number.isFinite(version)) {
    logger.warn('[ai-search] no chunk parent-field version was supplied — the unstamped rows ' +
      'cannot be listed', { index });
    return null;
  }

  const clauses = [staleStampClause(version)];
  if (projectId !== undefined) {
    clauses.push(projectId === null ? 'projectId eq null' : `projectId eq ${quote(projectId)}`);
  }
  const filter = allOf(clauses);

  const rows = [];
  let total = 0;
  try {
    while (rows.length < maxRows) {
      const want = Math.min(MAX_PAGE_ROWS, maxRows - rows.length);
      const { value, count } = await runSearch(index, {
        matchAll: true,
        filter,
        select: 'id,chunkId,documentId',
        top: want,
        skip: rows.length
      });
      const page = value || [];
      total = Number.isFinite(count) ? count : rows.length + page.length;
      rows.push(...page);
      // A SHORT page ends it, never the count: `@odata.count` is the index-wide total, and the
      // rows run out first whenever `$skip` reaches its own ceiling.
      if (page.length < want) break;
    }
  } catch (err) {
    if (err.status === 400 && blamedPropertyFrom(err) === 'parentFieldsVersion') {
      logger.warn(`[ai-search] the ${index} index carries no parentFieldsVersion — which of its ` +
        'rows are unstamped is unknown, not none.', { index });
      return null;
    }
    throw err;
  }

  return { rows, total, complete: rows.length >= total };
}

/**
 * The ids of the documents matching a filter, for scoping a CHUNK query to them.
 *
 * ONLY the document-only keys reach this now — `datePostedStart`/`datePostedEnd`, `isFeatured`,
 * `legislation`, `documentSource`. The four facets that used to dominate it (`type`, `milestone`,
 * `projectPhase`, `documentAuthorType`) are copied onto every chunk and filter directly, which is
 * what removed the cap from the cases that mattered. Everything below is the residue: a chunk row
 * carries no date and no legislation, so a filter on one can only be answered by resolving the
 * documents first and scoping the chunks to them.
 *
 * BOUNDED, AND THE BOUND IS REPORTED. `search.in` takes a large list but not an unlimited one. So
 * this returns the total as well as the ids, and a caller whose match set exceeds `cap` must treat
 * the filter as INEXPRESSIBLE — answer with the key still named in `meta.dropped` — rather than
 * scope to an arbitrary prefix of it. A truncated scope would silently answer "these are the chunks
 * matching your filter" about a subset nobody chose, which is worse than saying it did not apply.
 *
 * `matchAll` with no keywords: the caller's terms belong to the CHUNK query, not this one. A
 * document whose text mentions the term is found by the chunk search; this query exists only to
 * answer "which documents carry this metadata".
 *
 * ONE SERVICE CALL, because `cap + 1` is exactly `SERVICE_MAX_TOP`. So a filtered chunk page costs
 * two round trips, not three.
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

  const rows = value || [];
  // One comparison, not two: an `ids.length <= cap` clause beside this looks like it covers the
  // no-count path, and does not — the fallback here already makes `total` the page length there,
  // so the extra clause can never change the answer. A guard nothing can trip reads as protection
  // that is not there.
  const total = Number.isFinite(count) ? count : rows.length;
  const withinCap = total <= cap;
  // NO PREFIX. A partial scope answers "the chunks matching your filter" about a subset nobody
  // chose, and the caller cannot tell it from a complete answer; the empty list forces the caller
  // to report the filter as inexpressible instead. Read off the rows only once the cap is settled:
  // over the cap the list is discarded, and every filter measured on prod is over the cap.
  const ids = withinCap ? rows.map(row => String(row.id)).filter(Boolean) : [];
  return { ids, total, withinCap };
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

  const { value, count, degraded } = await runSearch(index, {
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
    // This `select` is what stops the API shipping whole chunks — see CHUNK_SELECT.
    select: CHUNK_SELECT,
    highlight: 'content'
  });

  return {
    count,
    // Present only when the live index could not answer a field — see `send` in runSearch. The
    // controller spreads it into the response `meta`, so a degraded page says so instead of
    // looking like a column the app forgot to ask for.
    ...(degraded ? { meta: { degraded } } : {}),
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

  const { value, count, degraded } = await runSearch(projectsIndex, {
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
    // See searchChunks: only present when a field was dropped to keep the page answerable.
    ...(degraded ? { meta: { degraded } } : {}),
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
  // Every leg that ran, for the `degraded` mark alone: a narrow index shows up in whichever leg
  // happens to ask first, and one page is one answer however many requests built it.
  const legs = [direct];

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
    legs.push(projects);

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
      const scope = `${inClause('projectId', projectIds)} and ` +
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
      legs.push(byProject);

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

  const degraded = mergeDegraded(legs);

  // Leg two's documents matched on their PROJECT's name, not their own metadata, so they carry no
  // `@search.highlights` — `markedField` returns their escaped text and the card renders unmarked,
  // which is the honest result: nothing in that document's own fields matched the query.
  return {
    count: total,
    // See searchChunks: only present when a field was dropped to keep the page answerable.
    ...(degraded ? { meta: { degraded } } : {}),
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

/**
 * Remove chunk rows from the chunks index by key.
 *
 * The bulk twin of `deleteFromIndex`, for the rows no document owns any more: the indexer's `_ts`
 * high-water mark cannot see a delete, so an orphaned chunk stays searchable until something says
 * so explicitly. `deleteChunksForDocument` covers the case where the parent is known; this one
 * takes keys a caller has already worked out.
 *
 * Keys are the index's own `id`, READ BACK from a search rather than re-derived — the indexer mints
 * them with a .NET base64 variant, and re-implementing that here would delete nothing while
 * reporting success.
 *
 * Batched at the service's own cap, like `writeAcls`, and best-effort the same way: a batch the
 * service refused is reported back rather than thrown, so a purge can name what is still findable
 * instead of failing whole. A 404 is not a failure here — the row is already gone, which is the
 * result the caller asked for.
 *
 * @param {string[]} ids  index keys
 * @returns {Promise<string[]>} the ids that are still indexed as far as this call can tell
 */
async function deleteDocuments(ids) {
  const { configured, index } = config();
  const keys = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
  if (keys.length === 0) return [];
  if (!configured) {
    warnUnconfigured();
    // Nothing was removed, so nothing may be reported as removed.
    return keys;
  }

  const failed = [];

  for (let start = 0; start < keys.length; start += INDEX_BATCH_ROWS) {
    const batch = keys.slice(start, start + INDEX_BATCH_ROWS);
    try {
      const result = await request(`/indexes/${index}/docs/index?api-version=${API_VERSION}`, {
        value: batch.map(key => ({ '@search.action': 'delete', id: key }))
      });

      // A 207 is an `ok` response carrying per-row verdicts, so the status of the request says
      // nothing about the rows.
      const rejected = (result.value || [])
        .filter(row => row && row.status === false && row.statusCode !== 404)
        .map(row => String(row.key));
      failed.push(...rejected);

      if (rejected.length > 0) {
        logger.error(
          `[ai-search] could not delete ${rejected.length} of ${batch.length} rows from ${index}. ` +
          'They stay searchable until this is retried.'
        );
      }
    } catch (err) {
      logger.error(
        `[ai-search] delete of ${batch.length} rows from ${index} failed (${err.message}). ` +
        'They stay searchable until this is retried.'
      );
      failed.push(...batch);
    }
  }

  return failed;
}

/** The index names, so callers name them once and never hardcode a string. */
function indexes() {
  const { index, projectsIndex, documentsIndex } = config();
  return { chunks: index, projects: projectsIndex, documents: documentsIndex };
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


module.exports = {
  DOCUMENT_SELECT,
  PROJECT_SELECT,
  CHUNK_SELECT,
  // The live-schema gate and the error classification behind `SEARCH_SCHEMA_DRIFT`.
  probeIndexSchema,
  missingPropertyFrom,
  // Exported for tests. Its refusals are the safety argument for the whole degrade — an emptied
  // `select` returns every RETRIEVABLE field, chunk text included — and the one-retry latch above
  // puts them out of reach of any `searchDocuments`/`searchChunks` call that could assert them.
  dropField,
  searchChunks,
  searchProjects,
  searchDocuments,
  documentIdsMatching,
  DOCUMENT_SCOPE_CAP,
  chunkParentFieldStatus,
  // The scoped twin of the count inside `chunkParentFieldStatus`: one place builds the stamp
  // clause, so a controller cannot count a different population than the probe it gates on.
  staleChunkCount,
  // The row-level twin of that count, for the orphan purge in `backfill-chunk-parent-fields.js`:
  // a row the stamp cannot reach is one whose Cosmos chunk is gone, and only the index keys read
  // back here can delete it.
  listStaleChunkIds,
  LIVE_SCHEMA_TTL_MS,
  UNKNOWN_STATUS_TTL_MS,
  deleteChunksForDocument,
  deleteFromIndex,
  deleteDocuments,
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
