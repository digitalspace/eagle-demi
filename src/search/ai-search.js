'use strict';

/**
 * Azure AI Search — the Deep Search backend over extracted document text.
 *
 * Classic lexical BM25 only. No vectors, no semantic ranker: retrieval is keyword matching and AI
 * is a summariser over the final top-N, not a retriever.
 *
 * Deliberately plain `fetch` against the REST API rather than `@azure/search-documents`. Two
 * calls are needed — search and delete — and the SDK would be a new dependency for what a request
 * body already expresses. `@azure/identity` is NOT new: it is already how Cosmos authenticates.
 *
 * The service has `disableLocalAuth`, so there is no admin key to configure or leak, and its
 * `publicNetworkAccess` is Disabled (landing-zone policy), so this only works from inside the
 * VNet — which the App Service is. See docs/bcgov-azure-landing-zone.md.
 */

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

let tokenCache = null;
let credential = null;
let unconfiguredWarned = false;

/**
 * One service, three indexes. `SEARCH_INDEX` names the chunk index for backward compatibility;
 * the other two are derived from it so a single app setting still configures everything.
 */
function config() {
  const endpoint = (process.env.SEARCH_ENDPOINT || '').replace(/\/$/, '');
  const index = process.env.SEARCH_INDEX || 'demi-chunks';
  return {
    endpoint,
    index,
    projectsIndex: process.env.SEARCH_INDEX_PROJECTS || 'demi-projects',
    documentsIndex: process.env.SEARCH_INDEX_DOCUMENTS || 'demi-documents',
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
  console.warn(
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

async function request(path, body) {
  const { endpoint } = config();
  const res = await fetch(`${endpoint}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await getToken()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    // The status matters: 403 (missing data-plane role) and 404 (wrong index name) both return
    // JSON that reads like an empty result if only the body is inspected.
    const detail = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${detail.slice(0, 300)}`);
  }
  return res.json();
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
 * `(term OR term~1)` per term, ANDed together.
 *
 * The OR is not redundant. A fuzzy term bypasses the query analyzer, so it matches only against
 * what is already in the index; the plain term goes through `en.microsoft` and picks up stemming.
 * Measured on the live index, the bare fuzzy form happened to match too — because the INDEX side
 * is lemmatised — but that is a property of the current analyzer, and the OR does not depend on it.
 */
function buildQuery(terms, fuzzy, prefix = false) {
  const last = terms.length - 1;
  return terms
    .map((t, i) => {
      const parts = [t];
      if (fuzzy && t.length >= MIN_FUZZY_LENGTH) parts.push(`${t}~1`);
      // Prefix on the LAST term only — the one still being typed. Applying it to every term would
      // match `pipe` inside `pipeline` in the middle of a phrase and blur the query; applying it
      // to none loses search-as-you-type, which Typesense provided via `prefix=true` and the
      // frontend relies on because it searches on debounced keystrokes.
      if (prefix && i === last && t.length >= MIN_FUZZY_LENGTH) parts.push(`${t}*`);
      return parts.length > 1 ? `(${parts.join(' OR ')})` : t;
    })
    .join(' AND ');
}

/**
 * One search request. Every dataset goes through here so the ACL filter, the query shape and the
 * "null filter means unrestricted, empty filter is a bug" rule are written once.
 */
async function runSearch(index, opts = {}) {
  const terms = tokenize(opts.keywords);
  if (terms.length === 0 && !opts.matchAll) return { value: [], count: 0 };

  const body = {
    search: opts.matchAll ? '*' : buildQuery(terms, opts.fuzzy === true, opts.prefix === true),
    queryType: opts.matchAll ? 'simple' : 'full',
    top: Math.min(Math.max(Number(opts.top) || 20, 1), 250),
    count: true
  };
  if (opts.select) body.select = opts.select;
  if (opts.searchFields) body.searchFields = opts.searchFields;
  if (opts.highlight) {
    body.highlight = opts.highlight;
    body.highlightPreTag = HL_PRE;
    body.highlightPostTag = HL_POST;
  }
  // Omitted entirely when null. An empty-string filter is UNRESTRICTED, not "no matches".
  if (opts.filter) body.filter = opts.filter;

  const data = await request(`/indexes/${index}/docs/search?api-version=${API_VERSION}`, body);
  const value = data.value || [];
  return { value, count: data['@odata.count'] ?? value.length };
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
    // `content` is not retrievable — the API never ships whole chunks, only the matched span.
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
      snippet: snippetFrom(hit)
    }))
  };
}

/**
 * Project search. Mirrors the Typesense `query_by=name,displayName,description,proponent`.
 */
async function searchProjects(opts = {}) {
  const { configured, projectsIndex } = config();
  if (!configured) {
    warnUnconfigured();
    return { items: [], count: 0 };
  }

  const { value, count } = await runSearch(projectsIndex, {
    ...opts,
    prefix: true,
    searchFields: 'name,displayName,description,proponent',
    // Every name here must exist in the index — a stray one is a 400 on EVERY query, not a
    // missing field in the response. `trackProjectId` was in this list and is not in the index
    // (it is an int in Cosmos), which turned all project search into a silent fallback.
    select: 'id,name,displayName,description,proponent,sector,status,region,centroid,' +
      'legacyEagleId,read,isPublished'
  });

  return { count, items: value };
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
  if (!configured) {
    warnUnconfigured();
    return { items: [], count: 0 };
  }

  const top = Math.min(Math.max(Number(opts.top) || 20, 1), 250);
  const select = 'id,displayName,documentFileName,description,type,projectId,read,isPublished';

  const direct = await runSearch(documentsIndex, {
    ...opts,
    top,
    prefix: true,
    searchFields: 'displayName,documentFileName,description',
    select
  });

  const items = [...direct.value];
  const seen = new Set(items.map(d => String(d.id)));

  // Leg two runs only when there is room left; a full page of direct hits is already the answer.
  if (items.length < top && opts.projectFilter !== undefined) {
    const projects = await runSearch(config().projectsIndex, {
      keywords: opts.keywords,
      fuzzy: opts.fuzzy,
      prefix: true,
      filter: opts.projectFilter,
      searchFields: 'name,displayName,proponent',
      select: 'id',
      top: MAX_PROJECT_FANOUT
    });

    const projectIds = projects.value.map(p => String(p.id)).filter(Boolean);
    if (projectIds.length > 0) {
      // The caller's document ACL still applies — visibility of a project never widens access to
      // its documents, it only decides which ids are worth asking about.
      const scope = `search.in(projectId, ${quoteList(projectIds)}, ',')`;
      const byProject = await runSearch(documentsIndex, {
        matchAll: true,
        top,
        select,
        filter: opts.filter ? `(${opts.filter}) and ${scope}` : scope
      });

      for (const doc of byProject.value) {
        if (items.length >= top) break;
        if (seen.has(String(doc.id))) continue;
        seen.add(String(doc.id));
        items.push(doc);
      }
    }
  }

  return { count: Math.max(direct.count, items.length), items };
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
    console.error(
      `[ai-search] could not remove ${index}/${id} (${err.message}). ` +
      'It remains searchable until this is retried.'
    );
    return 0;
  }
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
async function deleteChunksForDocument(documentId) {
  const { configured, index } = config();
  if (!configured) {
    warnUnconfigured();
    return 0;
  }

  const id = String(documentId);
  try {
    const found = await request(`/indexes/${index}/docs/search?api-version=${API_VERSION}`, {
      search: '*',
      filter: `documentId eq '${id.replace(/'/g, "''")}'`,
      select: 'id',
      // A document can hold thousands of chunks; this is the page cap, and `count` tells us
      // whether a second pass is needed rather than leaving the rest silently indexed.
      top: 1000,
      count: true
    });

    const keys = (found.value || []).map(d => d.id).filter(Boolean);
    if (keys.length === 0) return 0;

    await request(`/indexes/${index}/docs/index?api-version=${API_VERSION}`, {
      value: keys.map(key => ({ '@search.action': 'delete', id: key }))
    });

    const total = found['@odata.count'] ?? keys.length;
    if (total > keys.length) {
      console.warn(
        `[ai-search] document ${id} has ${total} indexed chunks; deleted the first ${keys.length}. ` +
        'Re-run the delete to clear the remainder.'
      );
    }
    return keys.length;
  } catch (err) {
    // Best-effort by design: the Cosmos rows are already gone and the caller has already
    // succeeded. Loud, because the consequence is searchable text for a deleted document.
    console.error(
      `[ai-search] could not remove indexed chunks for document ${id} (${err.message}). ` +
      'Its text remains searchable until this is retried.'
    );
    return 0;
  }
}

module.exports = {
  searchChunks,
  searchProjects,
  searchDocuments,
  deleteChunksForDocument,
  deleteFromIndex,
  indexes,
  // Exported so a caller can tell "search is not configured" from "search found nothing". The API
  // is right to treat the first as a degraded state and return []; an instrument is not, and must
  // refuse to publish a zero it cannot distinguish from an unset app setting.
  config,
  // Exported for tests.
  tokenize,
  buildQuery,
  snippetFrom,
  escapeHtml,
  HL_PRE,
  HL_POST
};
