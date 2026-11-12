'use strict';

/**
 * Azure AI Search client: lexical BM25 retrieval, semantic ranker only reorders chunk hits.
 * Plain `fetch` over REST on purpose: search and delete do not justify the SDK dependency.
 */

const { randomUUID } = require('crypto');
const { logger } = require('../utils/logger');
// The same renderer the ACL clause uses, so a scope and the ACL it rides beside cannot disagree
// about how an id list is written.
const { inClause, quote } = require('../helpers/access-odata');
const { mapLimit } = require('../utils/worker-pool');

const API_VERSION = '2024-07-01';

// Highlights land inside untrusted PDF text the frontend renders as HTML. Control chars no
// document can hold mark them; the whole fragment is escaped, then they become <mark>.
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
 * Every name must exist in the index: a stray one is a 400 on every query, never retried.
 * Exported so a test holds it against `azure/search/indexes/documents.json`.
 */
const DOCUMENT_SELECT = 'id,displayName,documentFileName,description,type,projectId,read,' +
  'isPublished,typeId,milestoneId,projectPhaseId,documentAuthorTypeId,datePosted,isFeatured,' +
  'documentSource,fileSize';

/**
 * Same rule as DOCUMENT_SELECT. A field added to the index and mapper but not here comes back
 * undefined, so its column reads '-' on every row under a 200.
 */
const PROJECT_SELECT = 'id,name,displayName,description,proponent,sector,projectSubType,' +
  'legislationYear,status,region,centroid,legacyEagleId,read,isPublished,type,currentPhaseName,' +
  'currentPhaseNameId,eacDecision,eacDecisionId,decisionDate,dateUpdated,vis,phaseIds,activeWorkId,' +
  'activeWorkAct,activeWorkType,activeWorkPhase';

/**
 * `content` is left out on purpose: semantic ranking forces it retrievable in the index, so this
 * list is all that stops full chunk text reaching every caller.
 */
const CHUNK_SELECT = 'chunkId,documentId,projectId,pageNumber,pageNumbered,read';

/**
 * Shared by search and count so badge and total agree. The `*Tokens` fields use the `filename`
 * analyzer, which keeps words like "mine" that `en.microsoft` drops as stopwords.
 */
const PROJECT_SEARCH_FIELDS =
  'name,displayName,description,proponent,nameTokens,searchLabels,tags,tagsTokens';

/** What leg two of a document keyword search matches a project on: the names it goes by, never its description. */
const LEG_TWO_SEARCH_FIELDS = 'name,displayName,proponent,nameTokens,tags,tagsTokens';

/** One copy for compat and native: compat's leg-two exclusion clause must complement exactly these. */
const DOCUMENT_SEARCH_FIELDS = 'displayName,documentFileName,description,fileNameTokens';

/**
 * These indexes only say which rows match; the rows are read back from Cosmos, so their
 * searchable fields are not retrievable (see azure/search/indexes/activities.json).
 */
const KEYWORD_INDEXES = Object.freeze({
  activities: {
    setting: 'SEARCH_INDEX_ACTIVITIES',
    searchFields: 'headline,shortHeadline,summary,content,notificationName',
    select: 'id,eagleId,projectId'
  },
  notifications: {
    setting: 'SEARCH_INDEX_PROJECT_NOTIFICATIONS',
    searchFields: 'name,description,proponent,region,type,subType,trigger,decision,location,' +
      'nature,nameTokens',
    select: 'id,eagleId'
  }
});

/** Rows one search request can return. A larger page costs more requests, not fewer rows. */
const SERVICE_MAX_TOP = 250;

/**
 * eagle-public's largest page (`MAX_SHOW_ALL_ITEMS`). The controller refuses larger pages, since a
 * clamp would return a short page the caller cannot tell from a full one.
 */
const MAX_PAGE_ROWS = 500;

/**
 * Most document ids a chunk query scopes to for keys chunks do not copy (dates, isFeatured, ...).
 * Derived so the lookup fits one request; over it the key is dropped, never applied to a prefix.
 */
const DOCUMENT_SCOPE_CAP = SERVICE_MAX_TOP - 1;

/** Operators widen the live index without a release, so a cached "field missing" must expire. */
const LIVE_SCHEMA_TTL_MS = 10 * 60 * 1000;

/**
 * A 403 or timeout says nothing about the index, so it is held briefly: one probe per burst of
 * keystrokes rather than one per keystroke.
 */
const UNKNOWN_STATUS_TTL_MS = 30 * 1000;

let tokenCache = null;
let credential = null;
let unconfiguredWarned = false;

/**
 * `SEARCH_INDEX` is the chunk index. Every name is an app setting so pointing back at the retired
 * `demi-*` indexes, which are still filled, needs no release.
 */
function config() {
  const endpoint = (process.env.SEARCH_ENDPOINT || '').replace(/\/$/, '');
  const index = process.env.SEARCH_INDEX || 'chunks';
  return {
    endpoint,
    index,
    projectsIndex: process.env.SEARCH_INDEX_PROJECTS || 'projects',
    documentsIndex: process.env.SEARCH_INDEX_DOCUMENTS || 'documents',
    // No default name: absent or empty means these keyword searches are answered from Cosmos.
    // A default would query an index the service may not hold, and every search would 502.
    activitiesIndex: process.env[KEYWORD_INDEXES.activities.setting] || '',
    notificationsIndex: process.env[KEYWORD_INDEXES.notifications.setting] || '',
    configured: Boolean(endpoint)
  };
}

/**
 * Not configured is degraded, not an error: the search endpoint must not 500 over it. Warns once
 * per process, because the frontend searches on every keystroke.
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
 * Data-plane token, cached until near expiry. The identity module loads lazily so test runs that
 * never authenticate do not pull it in.
 */
async function getToken() {
  if (tokenCache && tokenCache.expiresOn - Date.now() > 5 * 60 * 1000) {
    return tokenCache.token;
  }

  if (!credential) {
    // AZURE_CLIENT_ID selects the user-assigned identity, exactly as the Cosmos client does.
    credential = require('../utils/azure-credential').createCredential();
  }

  const result = await credential.getToken('https://search.azure.com/.default');
  if (!result || !result.token) throw new Error('no token returned for the search data plane');
  tokenCache = { token: result.token, expiresOn: result.expiresOnTimestamp || Date.now() };
  return tokenCache.token;
}

/**
 * Throttling (Basic tier, one replica) and transient 503 only. A 400 or 403 repeats every time,
 * so retrying it only triples the latency of a sure failure.
 */
const RETRY_STATUSES = new Set([429, 503]);
const MAX_ATTEMPTS = 3;

/**
 * Fail long before the platform aborts, so a hung search does not hold a worker for minutes after
 * the caller gave up. Well past any healthy query on this corpus.
 */
const REQUEST_TIMEOUT_MS = 30000;

/** Honours `Retry-After` (seconds); else linear backoff, as `bulkVerified` in db/cosmos-nosql.js. */
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
      // A timeout is not retried: the full budget is spent, and more attempts against a service
      // that slow only lengthen its queue.
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

    // `runSearch` branches on 402 (semantic allowance spent), so the status rides on the error
    // rather than being parsed out of the message.
    const err = new Error(`HTTP ${res.status} ${detail.slice(0, 300)} [${clientRequestId}]`);
    err.status = res.status;
    // The service body can quote the `$filter`, ACL clause included: handlers map it via `searchServiceReply`.
    err.searchService = true;
    throw err;
  }

  // Unreachable: the loop either returns, retries, or throws. Here only if maxAttempts < 1.
  throw new Error(`[ai-search] no attempt made for ${path} [${clientRequestId}]`);
}

/**
 * Splits on anything not a letter or digit, so no Lucene operator reaches a `full` query (an
 * unbalanced one is a 400). \p{L} keeps accented letters, so French place names stay searchable.
 */
function tokenize(keywords) {
  return String(keywords || '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, MAX_TERMS);
}

/**
 * Shorter terms get no `~1`: a fuzzy term skips the analyzer, so short words match OCR debris, and
 * every three-letter word is one edit from many others.
 */
const MIN_FUZZY_LENGTH = 4;

/**
 * Lower than MIN_FUZZY_LENGTH on purpose: a prefix is typed text, not a guess. Not 1, because `k*`
 * overruns the service's expansion cap, which silently answers from a subset of the vocabulary.
 */
const MIN_PREFIX_LENGTH = 2;

/**
 * Measured, not chosen: keeps an edit-distance match from outranking the verbatim term.
 * Numbers and limits are on the wiki's Search-Measurements page.
 */
const FUZZY_BOOST = 0.5;

/**
 * Case-sensitive operators under `full`: a typed bare AND would make `x AND AND y`, a 400.
 * Lowercased to plain terms, which the lowercasing analyzer still matches.
 */
const LUCENE_OPERATORS = new Set(['AND', 'OR', 'NOT']);

/**
 * Words the analyzer drops: a `~1` or `*` variant of one asks for a literal the index lacks, and
 * one such clause zeroes the AND. Errs wide: a wrong entry only costs one prefix expansion.
 */
const ANALYZER_STOPWORDS = new Set([
  // Measured on the live index: `searchChunks({ keywords: word, fuzzy: false })` counts 0.
  'from', 'hers', 'herself', 'himself', 'itself', 'mine', 'myself', 'ours', 'ourselves', 'that',
  'their', 'theirs', 'them', 'themselves', 'these', 'they', 'this', 'those', 'with', 'yourself',
  // Standard English stop set, inferred from en.microsoft; the Analyze API is 403 to the app.
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in', 'into', 'is', 'it',
  'no', 'not', 'of', 'on', 'or', 'such', 'the', 'then', 'there', 'to', 'was', 'will'
]);

/** The one check every `~1` or `*` append goes through. */
function isAnalyzerStopword(term) {
  return ANALYZER_STOPWORDS.has(term.toLowerCase());
}

/**
 * `(term OR term~1)` per term, ANDed. The plain arm keeps stemming, which the fuzzy arm skips.
 * An outer OR was measured and rejected (wiki Search-Measurements).
 */
function buildQuery(terms, fuzzy, prefix = false) {
  const last = terms.length - 1;
  return terms
    .map((raw, i) => {
      const t = LUCENE_OPERATORS.has(raw) ? raw.toLowerCase() : raw;
      const parts = [t];
      const analyzed = !isAnalyzerStopword(t);
      if (fuzzy && analyzed && t.length >= MIN_FUZZY_LENGTH) parts.push(`${t}~1^${FUZZY_BOOST}`);
      // Prefix on the last term only, the one still being typed; on every term `pipe` would
      // match `pipeline` mid-phrase.
      if (prefix && analyzed && i === last && t.length >= MIN_PREFIX_LENGTH) parts.push(`${t}*`);
      return parts.length > 1 ? `(${parts.join(' OR ')})` : t;
    })
    .join(' AND ');
}

/**
 * Guard only: CONTAINS_SEPARATORS already strips syntax, but loosen it and an unbalanced bracket
 * is a 400. One pass suffices; a replacement is never rescanned.
 */
function escapeLucene(term) {
  return term.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&');
}

/**
 * Split where the analyzer splits (hyphen included): `LNG,*` is a token the index never holds.
 * The apostrophe stays inside, as the analyzer keeps `dam's` whole.
 */
const CONTAINS_SEPARATORS = /[^\p{L}\p{N}'\u2019]+/u;

/** A run of apostrophes is not a word: `, ()` has to mean no filter, as `''` does. */
const HAS_WORD_CHARACTER = /[\p{L}\p{N}]/u;

/**
 * "Name contains" filter: every word required, each as a prefix. A stopword stays without its `*`:
 * 'Notice of Commencement' gives `Notice* AND of AND Commencement*`.
 */
function buildContainsQuery(text) {
  return String(text || '')
    .split(CONTAINS_SEPARATORS)
    .filter((word) => HAS_WORD_CHARACTER.test(word))
    .slice(0, MAX_TERMS)
    .map((raw) => {
      const t = LUCENE_OPERATORS.has(raw) ? raw.toLowerCase() : raw;
      const prefixable = t.length >= MIN_PREFIX_LENGTH && !isAnalyzerStopword(t);
      // The `*` goes on AFTER escaping: it is ours, and must stay syntax.
      return prefixable ? `${escapeLucene(t)}*` : escapeLucene(t);
    })
    .join(' AND ');
}

/**
 * Derived from the index name, as `azure/search/indexes/chunks.json` declares it: naming a
 * configuration the index lacks is a 400 on every chunk search, not a fallback to BM25.
 */
function semanticConfigurationFor(index) {
  return `${index}-semantic`;
}

/**
 * UTC month (`YYYY-MM`) a 402 said the semantic allowance was spent. A month, not a flag, as the
 * worker outlives the reset. Keep UTC: Azure resets on it, and local time would stay latched.
 */
let semanticExhaustedMonth = null;

const utcMonth = () => new Date().toISOString().slice(0, 7);
const semanticIsExhausted = () => semanticExhaustedMonth === utcMonth();

/**
 * A `partial` rerank answers 200 in BM25 order, so these per-process counters are the only sign
 * ranking is off. They reset on recycle; the durable signal is an alert on the log line.
 */
const semanticCounters = {
  requested: 0,
  partial: 0,
  lastPartialReason: null,
  lastPartialAt: null,
  exhaustedAt: null
};

/** `ranked` is derived, not counted, so it cannot drift from `requested` and `partial`. */
function semanticStats() {
  return {
    ...semanticCounters,
    ranked: semanticCounters.requested - semanticCounters.partial,
    exhausted: semanticIsExhausted()
  };
}

/** Log line and counter in one place, so they agree on what counted as degraded. */
function notePartialRerank(reason) {
  semanticCounters.partial++;
  semanticCounters.lastPartialReason = String(reason);
  semanticCounters.lastPartialAt = new Date().toISOString();
  logger.warn(
    `[ai-search] semantic reranking did not run: ${reason} — results are in BM25 order`
  );
}

/**
 * 402: the free semantic allowance is spent until the month ends. Degrade to BM25 and stop asking,
 * rather than 500 every Deep Search; logged once per month, not per keystroke.
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
 * Every dataset searches through here, so the ACL filter and query shape are written once.
 * `opts.top` is the page size; pages over SERVICE_MAX_TOP are filled by further requests.
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
  // Floored at 0: eagle-public can send `pageNum=-1`. Capped so `skip + top` stays inside MAX_SKIP.
  const skip = Math.max(0, Math.floor(Number(opts.skip) || 0));
  if (skip > 0) body.skip = Math.min(skip, MAX_SKIP - body.top);
  // Never sent empty: an empty `$orderby` is a 400.
  if (opts.orderby) body.orderby = opts.orderby;
  // `search: '*'` matches no term, so there is nothing to highlight.
  if (opts.highlight && !opts.matchAll) {
    body.highlight = opts.highlight;
    body.highlightPreTag = HL_PRE;
    body.highlightPostTag = HL_POST;
  }
  // Omitted entirely when null. An empty-string filter is UNRESTRICTED, not "no matches".
  if (opts.filter) body.filter = opts.filter;

  // `search: '*'` has nothing to rescore, yet Azure bills each semantic query.
  const semantic = opts.semantic === true && !opts.matchAll && !semanticIsExhausted();
  if (semantic) {
    // Plain text only: `search` keeps the Lucene query for retrieval, this copy only rescores it.
    body.semanticQuery = terms.join(' ');
    body.semanticConfiguration = semanticConfigurationFor(index);
    // Basic allows 2 concurrent semantic requests, so going over is expected: serve BM25 order.
    body.semanticErrorHandling = 'partial';
  }

  const path = `/indexes/${index}/docs/search?api-version=${API_VERSION}`;

  // Spans every call of the fill loop: one drop-and-retry per request, not per call.
  let degraded = null;

  /**
   * A 400 naming a field the live index lacks drops that field and retries once. A second 400 or a
   * visibility field rethrows: narrowing until it passes would answer 200 with nothing asked for.
   */
  const send = async () => {
    try {
      return await request(path, body);
    } catch (err) {
      const absent = err.status === 400 ? missingPropertyFrom(err) : null;
      const refusal = err.status === 400 && !absent ? searchFieldRefusalFrom(err) : null;
      const field = absent || (refusal && refusal.field);
      // A field the index holds but cannot search is still valid in select, orderby and highlight,
      // and its twin is still searchable, so only its searchFields entry goes.
      const lists = absent || (refusal && refusal.absent) ? DROPPABLE_LISTS : ['searchFields'];
      if (!field || degraded || VISIBILITY_FIELDS.has(field) || !dropField(body, field, lists)) throw err;
      const twin = lists === DROPPABLE_LISTS && DROPPED_TOGETHER.get(field);
      degraded = { missing: twin && dropField(body, twin) ? [field, twin] : [field] };
      // Error, not warn: nothing else says the index is behind the code.
      logger.error(
        `[ai-search] the ${index} index cannot answer '${degraded.missing.join("', '")}' — retried ` +
        'without it, so this page is narrower than the app asked for. Widen the index and reindex.',
        { index, fields: degraded.missing }
      );
      return request(path, body);
    }
  };

  const once = async () => {
    // Per request, not per call: Azure bills each request and a page over SERVICE_MAX_TOP sends
    // several. The retry after a 402 has no `semanticQuery`, so it is not counted.
    if (semantic && body.semanticQuery) semanticCounters.requested++;
    let data;
    try {
      data = await send();
    } catch (err) {
      if (!semantic || err.status !== 402) throw err;
      noteSemanticExhausted();
      // This search was served in BM25 order too, so it counts against `ranked`.
      notePartialRerank('the monthly allowance is exhausted (HTTP 402)');
      delete body.semanticQuery;
      delete body.semanticConfiguration;
      delete body.semanticErrorHandling;
      data = await send();
    }

    if (semantic && data['@search.semanticPartialResponseReason']) {
      notePartialRerank(data['@search.semanticPartialResponseReason']);
    }
    return data;
  };

  const first = await once();
  const value = [...(first.value || [])];
  const count = first['@odata.count'] ?? value.length;

  // Ends on a short answer, never on `@odata.count` (the index-wide total). MAX_PAGE_ROWS bounds
  // the calls, so `pageSize` cannot multiply requests against a 1-SU service.
  let requested = body.top;
  let received = value.length;
  while (received === requested && value.length < wanted) {
    body.top = Math.min(wanted - value.length, SERVICE_MAX_TOP);
    const nextSkip = Math.min(skip + value.length, MAX_SKIP - body.top);
    // At the MAX_SKIP ceiling the offset stops moving and would fetch the same rows twice;
    // a short page is the honest answer there.
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
 * The field named in an AI Search 400, or null. One copy: the schema probe and
 * `controllers/search.js` (SEARCH_SCHEMA_DRIFT) both read it.
 */
function missingPropertyFrom(err) {
  const match = /Could not find a property named '([^']+)'/.exec((err && err.message) || '');
  return match ? match[1] : null;
}

/**
 * Never dropped: losing one widens the answer (a hit without `vis` falls back to `defaultVis`).
 * An index lacking one is a 502 SEARCH_SCHEMA_DRIFT instead.
 */
const VISIBILITY_FIELDS = new Set(['read', 'isPublished', 'vis']);

/**
 * One column under two analyzers that a stale index lacks together, so the single retry drops
 * both. Other `<field>Tokens` pairs drop alone.
 */
const DROPPED_TOGETHER = new Map([['tags', 'tagsTokens'], ['tagsTokens', 'tags']]);

const DROPPABLE_LISTS = ['select', 'searchFields', 'highlight', 'orderby'];

/**
 * Never touches `filter`: it holds the ACL, and a lost term admits more rows. An emptied `select`
 * refuses the drop, since no `select` returns every retrievable field, chunk text included.
 * @param {string[]} [lists] the body keys to drop it from; all four unless narrowed
 * @returns {boolean} whether the body changed, so the caller knows a retry can differ
 */
function dropField(body, field, lists = DROPPABLE_LISTS) {
  const changes = [];
  for (const key of lists) {
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
 * Only a missing-field 400 resolves `{ok: false}`; anything else throws, so a blip is not drift.
 * @param {object} opts
 * @param {string} opts.indexName   the LIVE index name, not the schema name
 * @param {string|string[]} [opts.select]
 * @param {string|string[]} [opts.orderby]
 * @param {string|string[]} [opts.searchFields]  an unsearchable field is reported in `missing` too
 * @returns {Promise<{ok: boolean, index: string, missing?: string[]}>}
 */
async function probeIndexSchema({ indexName, select, orderby, searchFields } = {}) {
  const list = value => (Array.isArray(value) ? value.join(',') : value);
  // A term, not `*`: the service skips checking `searchFields` on a match-all.
  const body = { search: searchFields ? 'probe' : '*', top: 0, count: false };
  if (select) body.select = list(select);
  if (orderby) body.orderby = Array.isArray(orderby) ? orderby.join(', ') : orderby;
  if (searchFields) body.searchFields = list(searchFields);

  try {
    await request(`/indexes/${indexName}/docs/search?api-version=${API_VERSION}`, body);
    return { ok: true, index: indexName };
  } catch (err) {
    const missing = err.status === 400
      ? missingPropertyFrom(err) || unsearchableFieldFrom(err)
      : null;
    if (!missing) throw err;
    return { ok: false, index: indexName, missing: [missing] };
  }
}

/**
 * Sends the filter, since reading the index definition needs a role the app lacks. Only a 400
 * naming `property` means no; anything else throws, so the caller answers "unknown".
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

/** The field a 400 names from a `searchFields` list: "The field 'x' ..." or "Unknown field 'x' ...". */
function unsearchableFieldFrom(err) {
  const refusal = searchFieldRefusalFrom(err);
  return refusal ? refusal.field : null;
}

/** As above, plus whether the index lacks the field (`Unknown field`) rather than holding it unsearchable. */
function searchFieldRefusalFrom(err) {
  const match = /(The field|Unknown field) '([^']+)' in (?:the )?search field list/
    .exec((err && err.message) || '');
  return match ? { field: match[2], absent: match[1] === 'Unknown field' } : null;
}

/** The property a 400 blames, whether the index lacks it or holds it unfilterable. */
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
 * Live parent-field filter support, per field: filter only on `available`. Asked of the service,
 * since `chunks.json` can be ahead of the index. `opts` is the `{now, ttlMs}` test seam.
 * @returns {Promise<{known, available: string[], missing: string[], unknown: string[], unstamped}>}
 */
function chunkParentFieldStatus(fields, version, opts = {}) {
  const now = opts.now || Date.now();
  const ttlMs = opts.ttlMs === undefined ? LIVE_SCHEMA_TTL_MS : opts.ttlMs;
  // The promise is cached, not the value, so a burst on a cold cache sends one probe.
  if (chunkParentFieldCache && now - chunkParentFieldCache.at < chunkParentFieldCache.ttl) {
    return chunkParentFieldCache.promise;
  }
  const entry = { at: now, ttl: ttlMs, promise: null };
  // An "unknown" is a blip, not a schema fact, so it gets the short TTL.
  entry.promise = readChunkParentFieldStatus(fields, version)
    .then((status) => {
      if (!status.known) entry.ttl = Math.min(ttlMs, UNKNOWN_STATUS_TTL_MS);
      return status;
    })
    // A cached rejection would 502 every Deep Search for the full TTL; resolve it as unknown.
    .catch((err) => {
      logger.warn(`[ai-search] the live chunk parent-field probe could not run: ${err.message}`);
      entry.ttl = Math.min(ttlMs, UNKNOWN_STATUS_TTL_MS);
      // `fields` may be what threw, so it is not spread blindly here.
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

  // One probe per field: a 400 names only one field, so a combined probe would misreport the rest.
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

  // A partial answer is not worth a count request: the mark it feeds is advisory.
  if (unknown.length) return { known: false, available, missing, unknown, unstamped: null };

  try {
    // With no field available no facet filter is sent, so the count could change nothing.
    const unstamped = available.length ? await staleChunkCount({ version }) : null;
    return { known: true, available, missing, unknown: [], unstamped };
  } catch (err) {
    // Only the backfill mark is unknown; the available fields stay usable.
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
 * Chunks with an older parent-field stamp, read off the stamp: a document with no List refs stamps
 * four nulls legitimately. `null` means "cannot say", never 0.
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
 * Unstamped rows, or null for "cannot say". `id` is the indexer's key, `chunkId` the Cosmos id:
 * the caller needs both to spot index rows whose chunk is gone.
 * @returns {Promise<?{rows: Array, total: number, complete: boolean}>}
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
      // A short page ends it, never the count: rows run out first at the `$skip` ceiling.
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
 * Document ids for scoping a chunk query by keys chunks do not copy. Over `cap` the ids come back
 * empty, so the caller reports the key in `meta.dropped` rather than scoping to a prefix.
 */
async function documentIdsMatching(filter, cap = DOCUMENT_SCOPE_CAP) {
  const { configured, documentsIndex } = config();
  if (!configured) {
    warnUnconfigured();
    throw new Error('[ai-search] SEARCH_ENDPOINT is not set — the search did not run');
  }

  // `cap + 1` on purpose: without a count, a full extra row still shows the set is over the cap.
  const { value, count } = await runSearch(documentsIndex, {
    matchAll: true,
    filter,
    select: 'id',
    top: Math.min(cap + 1, MAX_PAGE_ROWS)
  });

  const rows = value || [];
  const total = Number.isFinite(count) ? count : rows.length;
  const withinCap = total <= cap;
  // No prefix: a partial scope would pass for a complete answer.
  const ids = withinCap ? rows.map(row => String(row.id)).filter(Boolean) : [];
  return { ids, total, withinCap };
}

/** Escape first, mark second. '' without highlights: chunk `content` is never selected. */
function snippetFrom(hit) {
  const highlights = (hit['@search.highlights'] && hit['@search.highlights'].content) || [];
  if (highlights.length === 0) return '';
  // Balanced per fragment: a fragment cut can land inside a highlight and orphan a sentinel.
  return highlights.map(balanceFragment).join(' … ');
}

/**
 * Display markup for one selected field. Unlike `snippetFrom`, an unmatched field falls back to its
 * escaped value, so the caller binds one string and escaping happens once, here.
 */
function markedField(hit, field) {
  const fragments = (hit['@search.highlights'] || {})[field] || [];
  if (fragments.length > 0) return fragments.map(balanceFragment).join(' … ');

  const raw = hit[field];
  return raw === undefined || raw === null ? '' : escapeHtml(String(raw));
}

/**
 * Escapes, then turns sentinels into balanced `<mark>` tags: an orphan closer is dropped and an
 * open mark is closed at the end, so an innerHTML snippet cannot break the layout around it.
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
    // Only the chunk index declares a semantic configuration; asking for one elsewhere is a 400.
    semantic: true,
    // This `select` is what stops the API shipping whole chunks — see CHUNK_SELECT.
    select: CHUNK_SELECT,
    highlight: 'content'
  });

  return {
    count,
    // Only when a field was dropped (see `send` in runSearch); the controller puts it in `meta`.
    ...(degraded ? { meta: { degraded } } : {}),
    items: value.map(hit => ({
      chunkId: hit.chunkId,
      documentId: hit.documentId,
      projectId: hit.projectId,
      pageNumber: hit.pageNumber,
      // Null or dropped both mean "a passage number, not a page"; every layer above reads a boolean.
      pageNumbered: hit.pageNumbered === true,
      read: hit.read,
      snippet: snippetFrom(hit)
    }))
  };
}

/**
 * Project search over PROJECT_SEARCH_FIELDS.
 */
async function searchProjects(opts = {}) {
  const { configured, projectsIndex } = config();
  // Throws (the caller answers 502): `count: 0` from a search that never ran would be a false
  // claim, and every sorted or filtered browse lands here too.
  if (!configured) {
    warnUnconfigured();
    throw new Error('[ai-search] SEARCH_ENDPOINT is not set — the search did not run');
  }

  const { value, count, degraded } = await runSearch(projectsIndex, {
    ...opts,
    // Type-ahead is on unless the caller opts out.
    prefix: opts.prefix !== false,
    searchFields: PROJECT_SEARCH_FIELDS,
    select: PROJECT_SELECT,
    // Only the fields the result card renders.
    highlight: 'name,displayName,description'
  });

  return {
    count,
    ...(degraded ? { meta: { degraded } } : {}),
    items: value.map(hit => ({
      ...hit,
      // The analyzer's own marks, so stemmed matches (`flooding` for `flood`) are marked too.
      highlighted: {
        name: markedField(hit, 'name'),
        displayName: markedField(hit, 'displayName'),
        description: markedField(hit, 'description')
      }
    }))
  };
}

/**
 * Two legs: direct metadata matches, then documents of projects whose name matches. Documents
 * carry no project name in the index, and without leg two most "Ajax" hits are lost.
 */
async function searchDocuments(opts = {}) {
  const { configured, documentsIndex } = config();
  if (!configured) {
    warnUnconfigured();
    throw new Error('[ai-search] SEARCH_ENDPOINT is not set — the search did not run');
  }

  // A count still runs both legs, since the total is their sum; one row each is the smallest page.
  const countOnly = opts.countOnly === true;
  const top = countOnly ? 1 : Math.min(Math.max(Number(opts.top) || 20, 1), MAX_PAGE_ROWS);
  const select = DOCUMENT_SELECT;
  const searchFields = DOCUMENT_SEARCH_FIELDS;
  // Resolved once: leg two's exclusion clause must repeat leg one's query exactly, `*` included.
  const prefix = opts.prefix !== false;

  const direct = await runSearch(documentsIndex, {
    ...opts,
    top,
    prefix,
    searchFields,
    select: countOnly ? 'id' : select,
    ...(countOnly ? {} : { highlight: 'displayName,description' })
  });

  const items = [...direct.value];
  let total = direct.count;
  // For the `degraded` mark: one page is one answer however many legs built it.
  const legs = [direct];

  // Leg two runs on every page, since eagle-public pages by a total that counts its rows. Never with
  // no keyword: matching every project name would widen the document filter to the whole corpus.
  if (opts.projectFilter !== undefined && !opts.matchAll) {
    const projects = await runSearch(config().projectsIndex, {
      keywords: opts.keywords,
      fuzzy: opts.fuzzy,
      prefix,
      filter: opts.projectFilter,
      searchFields: LEG_TWO_SEARCH_FIELDS,
      select: 'id',
      top: MAX_PROJECT_FANOUT
    });
    legs.push(projects);

    const projectIds = projects.value.map(p => String(p.id)).filter(Boolean);
    if (projectIds.length > 0) {
      // The document ACL still applies. `not search.ismatch` with leg one's exact query makes the
      // legs disjoint, so paging is leg one then leg two with no repeats or gaps.
      const directQuery = buildQuery(tokenize(opts.keywords), opts.fuzzy === true, prefix);
      const scope = `${inClause('projectId', projectIds)} and ` +
        `not search.ismatch('${directQuery.replace(/'/g, "''")}', '${searchFields}', 'full', 'any')`;
      const byProject = await runSearch(documentsIndex, {
        matchAll: true,
        // Only the rows the page still lacks; one when full, as the request is then for the count.
        top: Math.max(1, top - items.length),
        select: countOnly ? 'id' : select,
        orderby: opts.orderby,
        // Leg one owns positions 0..direct.count, so this offset is exact and stateless.
        skip: Math.max(0, (Number(opts.skip) || 0) - (direct.count || 0)),
        filter: opts.filter ? `(${opts.filter}) and ${scope}` : scope
      });
      legs.push(byProject);

      for (const doc of byProject.value) {
        if (items.length >= top) break;
        items.push(doc);
      }

      // Disjoint legs, so the counts simply add.
      total = direct.count + byProject.count;
    }
  }

  const degraded = mergeDegraded(legs);

  if (countOnly) {
    return { count: total, ...(degraded ? { meta: { degraded } } : {}), items: [] };
  }

  // Leg two rows matched on their project's name, so they render unmarked.
  return {
    count: total,
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

/**
 * Native document ids, ranked: one leg, no highlight, rows re-read from Cosmos. No keywords means
 * matchAll; keywords that tokenise to nothing match nothing.
 * @param {{keywords?: string, fuzzy?: boolean, prefix?: boolean, filter?: string, orderby?: string, top?: number, skip?: number}} opts
 * @returns {Promise<{ids: string[], count: ?number, meta?: {degraded: object}}>}
 */
async function searchDocumentIds(opts = {}) {
  const { configured, documentsIndex } = config();
  if (!configured) {
    warnUnconfigured();
    throw new Error('[ai-search] SEARCH_ENDPOINT is not set — the search did not run');
  }

  const { value, count, degraded } = await runSearch(documentsIndex, {
    keywords: opts.keywords,
    fuzzy: opts.fuzzy,
    prefix: opts.prefix !== false,
    matchAll: !String(opts.keywords ?? '').trim(),
    searchFields: DOCUMENT_SEARCH_FIELDS,
    select: 'id',
    filter: opts.filter,
    orderby: opts.orderby,
    top: opts.top,
    skip: opts.skip
  });

  return {
    ids: value.map(row => String(row.id)),
    count,
    ...(degraded ? { meta: { degraded } } : {})
  };
}

/** Keyword search for RecentActivity and ProjectNotification: one leg, one index, ids back. */
async function searchKeywordIndex(dataset, opts = {}) {
  const cfg = config();
  const index = dataset === 'activities' ? cfg.activitiesIndex : cfg.notificationsIndex;
  // The controller checks the switch first and falls back to Cosmos, so a throw here is real.
  if (!cfg.configured || index === '') {
    warnUnconfigured();
    throw new Error('[ai-search] SEARCH_ENDPOINT is not set — the search did not run');
  }

  const { searchFields, select } = KEYWORD_INDEXES[dataset];
  const { value, count, degraded } = await runSearch(index, {
    ...opts,
    prefix: opts.prefix !== false,
    searchFields,
    select
  });

  return {
    count,
    ...(degraded ? { meta: { degraded } } : {}),
    items: value
  };
}

/** Updates (Eagle `RecentActivity`). Rows come back as `{id, eagleId, projectId}`, ranked. */
const searchActivities = (opts = {}) => searchKeywordIndex('activities', opts);

/** Project notifications. Rows come back as `{id, eagleId}`, ranked. */
const searchNotifications = (opts = {}) => searchKeywordIndex('notifications', opts);

/**
 * Keyword match count in one `top: 0` request. Builds the same query as `runSearch`, so the badge
 * counts what the results page shows.
 * @returns {Promise<number|null>} null when the service answered without a count.
 */
async function countKeyword(index, opts = {}) {
  const terms = tokenize(opts.keywords);
  // An empty query is a 400, and an empty tokenisation matches nothing anyway.
  if (terms.length === 0 && !opts.matchAll) return 0;

  const body = {
    search: opts.matchAll ? '*' : buildQuery(terms, opts.fuzzy === true, opts.prefix === true),
    queryType: opts.matchAll ? 'simple' : 'full',
    top: 0,
    count: true
  };
  if (opts.searchFields) body.searchFields = opts.searchFields;
  if (opts.filter) body.filter = opts.filter;

  const data = await request(`/indexes/${index}/docs/search?api-version=${API_VERSION}`, body);
  const count = data['@odata.count'];
  return Number.isFinite(count) ? count : null;
}

/** The count behind the Projects badge, over the same fields `searchProjects` ranks on. */
function countProjects(opts = {}) {
  const { configured, projectsIndex } = config();
  // Throws: the controller turns it into an unknown count, never 0.
  if (!configured) {
    warnUnconfigured();
    throw new Error('[ai-search] SEARCH_ENDPOINT is not set — the count did not run');
  }
  return countKeyword(projectsIndex, {
    ...opts,
    prefix: opts.prefix !== false,
    searchFields: PROJECT_SEARCH_FIELDS
  });
}

/** The count twin of `searchKeywordIndex`: same index, same fields, no rows. */
function countKeywordIndex(dataset, opts = {}) {
  const cfg = config();
  const index = dataset === 'activities' ? cfg.activitiesIndex : cfg.notificationsIndex;
  if (!cfg.configured || index === '') {
    warnUnconfigured();
    throw new Error('[ai-search] SEARCH_ENDPOINT is not set — the count did not run');
  }
  return countKeyword(index, {
    ...opts,
    prefix: opts.prefix !== false,
    searchFields: KEYWORD_INDEXES[dataset].searchFields
  });
}

const countActivities = (opts = {}) => countKeywordIndex('activities', opts);
const countNotifications = (opts = {}) => countKeywordIndex('notifications', opts);

/**
 * Only a 404 for a missing index lets the caller fall back to Cosmos. Every other failure stays
 * one, so an unranked page never passes for an index answer.
 */
function isMissingIndex(err, index) {
  if (!err || err.status !== 404) return false;
  const message = String(err.message || '');
  // "No index with the name 'activities' was found in the service" is the service's own wording.
  return message.includes('was not found') || Boolean(index) && message.includes(index);
}

/** Project ids beyond this add nothing: the document page is capped long before they matter. */
const MAX_PROJECT_FANOUT = 25;

/**
 * Remove one row from an index by key: indexers never see a delete, so nothing else will.
 * Best-effort: it reports 0 on failure, and the caller decides whether to keep the row.
 */
async function deleteFromIndex(index, id) {
  const { configured } = config();
  if (!configured) {
    warnUnconfigured();
    return 0;
  }

  try {
    const { value = [] } = await request(`/indexes/${index}/docs/index?api-version=${API_VERSION}`, {
      value: [{ '@search.action': 'delete', id: String(id) }]
    });
    // A 207 is `ok` with a per-row verdict; a 404 row is already out of the index.
    const rejected = value.find(row => row && row.status === false && row.statusCode !== 404);
    if (rejected) throw new Error(`HTTP ${rejected.statusCode} ${rejected.errorMessage || 'no message'}`);
    return 1;
  } catch (err) {
    logger.error(`[ai-search] could not remove ${index}/${id} (${err.message}). It remains searchable until this is retried.`);
    return 0;
  }
}

/** One index write carries at most this many actions — the service's own cap. */
const INDEX_BATCH_ROWS = 1000;

/** Round bound for `deleteChunksForDocument`: 500 x 1000 keys, over ten times the largest document. */
const DELETE_MAX_ROUNDS = 500;

/** `deleteChunksForDocument` rounds in a row whose count may lag its deletes before it gives up. */
const DELETE_STALL_ROUNDS = 2;
const DELETE_STALL_WAIT_MS = 2000;
/** Total stall wait one `deleteChunksForDocument` call may spend: it runs inside an HTTP request. */
const DELETE_STALL_BUDGET_MS = 20000;

/** Lookup+delete batches in flight at once: a 38,090-chunk document is 38 batches, too slow in a row. */
const UNINDEX_CONCURRENCY = 4;

/**
 * Best-effort ACL write so an unpublish does not stay searchable until the next indexer run.
 * `merge`, not `mergeOrUpload`: an upload would insert a title-less half-row.
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

      // A 207 is `ok` with per-row verdicts; a 404 row is not indexed yet, so nothing to hide.
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
 * Bulk delete by index key, as read back from a search (see deleteChunksForDocument). Refused
 * batches are returned, not thrown, so a purge can name what is still findable.
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

      // A 207 is `ok` with per-row verdicts.
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

/** `search.in` batches of chunk ids; `|` is its delimiter, so such an id is looked up alone. */
function chunkIdBatches(ids) {
  const batches = ids.filter(id => id.includes('|')).map(id => [id]);
  const listed = ids.filter(id => !id.includes('|'));
  for (let start = 0; start < listed.length; start += INDEX_BATCH_ROWS) {
    batches.push(listed.slice(start, start + INDEX_BATCH_ROWS));
  }
  return batches;
}

/** The `{id, chunkId}` index rows of one `chunkIdBatches` batch. Throws when the lookup fails. */
async function lookupChunkRows(index, batch) {
  const filter = batch[0].includes('|')
    ? `chunkId eq ${quote(batch[0])}`
    : `search.in(chunkId, ${quote(batch.join('|'))}, '|')`;
  // `request` POSTs, so a 1000-id filter (~70 KB) rides in the body, not the URL.
  const found = await request(`/indexes/${index}/docs/search?api-version=${API_VERSION}`, {
    search: '*', filter, select: 'id,chunkId', top: batch.length
  });
  return (found.value || []).filter(row => row && row.id);
}

/**
 * Which `chunkIds` the index holds, or null with no index. A failed lookup counts its batch as
 * held, so nothing is rewritten on a guess.
 * @param {string[]} chunkIds  Cosmos chunk ids
 * @returns {Promise<Set<string>|null>}
 */
async function indexedChunkIds(chunkIds) {
  const { configured, index } = config();
  const ids = chunkIds.map(String);
  if (!configured) return null;
  if (ids.length === 0) return new Set();
  const found = await mapLimit(chunkIdBatches(ids), UNINDEX_CONCURRENCY, async (batch) => {
    try {
      return (await lookupChunkRows(index, batch)).map(row => String(row.chunkId));
    } catch (err) {
      logger.warn(`[ai-search] could not look up ${batch.length} chunk keys in ${index} ` +
        `(${err.message}); those unchanged chunks are skipped without the index check.`);
      return batch;
    }
  });
  return new Set([].concat(...found));
}

/**
 * Run before the Cosmos delete; the caller keeps every id returned. Known race: an indexer run in
 * flight can re-add a row, which stays until the document's chunks go by `documentId`.
 * @param {string[]} chunkIds  Cosmos chunk ids
 * @returns {Promise<{stillIndexed: string[], indexUnconfigured: string[]}>}
 */
async function deleteChunksByIds(chunkIds) {
  const { configured, index } = config();
  const ids = chunkIds.map(String);
  if (ids.length === 0) return { stillIndexed: [], indexUnconfigured: [] };
  if (!configured) {
    logger.warn(`[ai-search] SEARCH_ENDPOINT is not set; refused to delete ${ids.length} chunk ` +
      'rows from the search index. Those chunks stay in Cosmos until this is retried.');
    return { stillIndexed: [], indexUnconfigured: ids };
  }

  const unindexBatch = async (batch) => {
    let rows;
    try {
      rows = await lookupChunkRows(index, batch);
    } catch (err) {
      logger.error(
        `[ai-search] could not look up ${batch.length} chunk keys in ${index} (${err.message}). ` +
        'Those rows stay searchable until this is retried.'
      );
      return batch;
    }

    if (rows.length === 0) return [];
    const chunkIdOf = new Map(rows.map(row => [String(row.id), String(row.chunkId)]));
    const rejected = await deleteDocuments(rows.map(row => row.id));
    const kept = rejected.map(key => chunkIdOf.get(String(key)));
    // An index key where a chunk id belongs would let the caller delete a still-indexed chunk.
    if (kept.some(id => id === undefined)) return batch;
    return kept;
  };

  const failed = await mapLimit(chunkIdBatches(ids), UNINDEX_CONCURRENCY, unindexBatch);
  return { stillIndexed: [].concat(...failed), indexUnconfigured: [] };
}

/** The index names, so callers name them once and never hardcode a string. */
function indexes() {
  const { index, projectsIndex, documentsIndex } = config();
  return { chunks: index, projects: projectsIndex, documents: documentsIndex };
}

/**
 * Indexers never see deletes, so this is the only way out. Keys are read back, never re-derived
 * from the indexer's .NET base64. `opts.strict` throws INDEX_DELETE_INCOMPLETE if rows may remain.
 */
async function deleteChunksForDocument(documentId, opts = {}) {
  const { deleted, complete } = await drainIndexedChunks(documentId, opts);
  if (!complete && opts.strict) {
    const err = new Error(`search index still holds chunks of document ${documentId} ` +
      `after ${deleted} deletions`);
    err.code = 'INDEX_DELETE_INCOMPLETE';
    err.deleted = deleted;
    throw err;
  }
  return deleted;
}

/** The body of `deleteChunksForDocument`: `complete` is false wherever rows may be left behind. */
async function drainIndexedChunks(documentId, opts) {
  const { configured, index } = config();
  if (!configured) {
    warnUnconfigured();
    return { deleted: 0, complete: false };
  }

  const id = String(documentId);
  // The cap only bounds a count that keeps falling; the no-progress check stops most failures.
  const maxRounds = opts.maxRounds || DELETE_MAX_ROUNDS;
  const sleep = opts.sleepFn || ((ms) => new Promise(r => setTimeout(r, ms)));
  let deleted = 0;
  let previousRemaining = Infinity;
  let stalled = 0;
  let stalledMs = 0;

  try {
    for (let round = 1; round <= maxRounds; round++) {
      const found = await request(`/indexes/${index}/docs/search?api-version=${API_VERSION}`, {
        search: '*',
        filter: `documentId eq '${id.replace(/'/g, "''")}'`,
        select: 'id',
        // The page cap; `count` decides whether another round is needed.
        top: 1000,
        count: true
      });

      const keys = (found.value || []).map(d => d.id).filter(Boolean);
      if (keys.length === 0) return { deleted, complete: true };

      const remaining = found['@odata.count'] ?? keys.length;
      // The count can lag a delete, so a stalled round waits and rereads; past the stall rounds or
      // the budget, the delete is not landing.
      if (round > 1 && remaining >= previousRemaining) {
        const overBudget = stalledMs + DELETE_STALL_WAIT_MS > DELETE_STALL_BUDGET_MS;
        if (++stalled > DELETE_STALL_ROUNDS || overBudget) {
          logger.warn(
            `[ai-search] document ${id} still reports ${remaining} indexed chunks after ` +
            `${deleted} deletions; stopping without progress. Its remaining text stays searchable.`
          );
          return { deleted, complete: false };
        }
        stalledMs += DELETE_STALL_WAIT_MS;
        await sleep(DELETE_STALL_WAIT_MS);
        continue;
      }
      stalled = 0;
      previousRemaining = remaining;

      await request(`/indexes/${index}/docs/index?api-version=${API_VERSION}`, {
        value: keys.map(key => ({ '@search.action': 'delete', id: key }))
      });
      deleted += keys.length;

      if (remaining <= keys.length) return { deleted, complete: true };
    }

    logger.warn(
      `[ai-search] document ${id} exceeded ${maxRounds} delete rounds after ${deleted} deletions. ` +
      'Re-run the delete to clear the remainder.'
    );
    return { deleted, complete: false };
  } catch (err) {
    // Earlier rounds stay deleted, so report their count, not 0.
    logger.error(
      `[ai-search] could not remove indexed chunks for document ${id} (${err.message}) ` +
      `after deleting ${deleted}. Its remaining text stays searchable until this is retried.`
    );
    return { deleted, complete: false };
  }
}


module.exports = {
  DOCUMENT_SELECT,
  PROJECT_SELECT,
  // Exported for `/health/search-schema`, which probes the live index with what the app sends.
  PROJECT_SEARCH_FIELDS,
  CHUNK_SELECT,
  // The live-schema gate and the error classification behind `SEARCH_SCHEMA_DRIFT`.
  probeIndexSchema,
  missingPropertyFrom,
  // Exported for tests: the one-retry latch keeps its refusals out of reach of search calls.
  dropField,
  searchChunks,
  searchProjects,
  searchDocuments,
  searchDocumentIds,
  DOCUMENT_SEARCH_FIELDS,
  LEG_TWO_SEARCH_FIELDS,
  searchActivities,
  searchNotifications,
  // The `/search/counts` legs; `countKeyword` for the test that pins its cheap request body.
  countKeyword,
  countProjects,
  countActivities,
  countNotifications,
  isMissingIndex,
  // The value-level health check's one primitive: rows whose value is wrong, not fields that exist.
  countMatching,
  // For the test that holds each list against the committed index definition.
  KEYWORD_INDEXES,
  documentIdsMatching,
  DOCUMENT_SCOPE_CAP,
  chunkParentFieldStatus,
  staleChunkCount,
  // For the orphan purge in `backfill-chunk-parent-fields.js`.
  listStaleChunkIds,
  LIVE_SCHEMA_TTL_MS,
  UNKNOWN_STATUS_TTL_MS,
  deleteChunksForDocument,
  deleteChunksByIds,
  indexedChunkIds,
  deleteFromIndex,
  deleteDocuments,
  writeAcls,
  indexes,
  // The controller refuses larger pages, so it reads this one copy.
  MAX_PAGE_ROWS,
  // The chunk window stays inside one service request.
  SERVICE_MAX_TOP,
  // So a caller can tell "not configured" from "found nothing".
  config,
  semanticStats,
  // Test seam: the 402 latch would otherwise hold for the rest of the month across tests.
  resetSemanticExhausted: () => {
    semanticExhaustedMonth = null;
    Object.assign(semanticCounters, {
      requested: 0, partial: 0, lastPartialReason: null, lastPartialAt: null, exhaustedAt: null
    });
  },
  // For `src/scripts/apply-search-definitions.js`, so the token scope lives in one place.
  getToken,
  tokenize,
  buildQuery,
  // For `search/eagle-query.js`: one copy of the Lucene escaping.
  buildContainsQuery,
  snippetFrom,
  escapeHtml,
  HL_PRE,
  HL_POST
};
