'use strict';

/**
 * `GET /documents/passages`: one row per chunks-index hit, `q` required. Rows carry the highlight as
 * `snippet`, never chunk text, and only for chunks whose parent document the caller may read.
 */

const aiSearch = require('../../search/ai-search');
const chunkQuery = require('../../search/chunk-query');
const { andOData, indexFilter } = require('../../search/native-index');
const { DOCUMENT_FACETS } = require('../../search/eagle-query');
const { CHUNK_PARENT_LIST_REFS } = require('../../repositories/chunks');
const { filterFor, inClause } = require('../../helpers/access-odata');
const { MAX_IDS, projectParentJoin } = require('../../helpers/native-query');
const { listHandler } = require('../nosql/mirror-reads');
const { recoverChunkFilters } = require('../search/index-filters');
const summary = require('../search/summary');
const { logger } = require('../../utils/logger');

// Native field -> chunks index column; the index keeps the stored names.
const FILTERS = ['projectId', 'documentId', ...CHUNK_PARENT_LIST_REFS];
const INDEX_MAP = Object.freeze({ columns: Object.fromEntries(FILTERS.map(field => [field, field])) });
// Chunk column -> the wire key `recoverChunkFilters` reads.
const WIRE_KEYS = Object.freeze(Object.fromEntries(
  Object.entries(DOCUMENT_FACETS).map(([key, column]) => [column, key])));

function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

/**
 * The parent document's fields a passage row repeats, read off the row already redacted for this
 * caller, so a withheld field is absent rather than defaulted.
 */
function parentFields(parent) {
  const documentName = parent.displayName || parent.documentFileName;
  const fields = { documentName, documentType: parent.type, milestone: parent.milestone,
    milestoneId: parent.milestoneId, datePosted: parent.datePosted };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value != null && value !== ''));
}

async function readPassages(access, parsed) {
  if (!parsed.q) throw failure(400, 'q is required');
  if (parsed.ids) throw failure(400, 'ids is not supported on passages');
  // Anonymous callers never get here above 100: the contract's `pageSizeFor` refuses them first.
  if (parsed.pageSize > aiSearch.SERVICE_MAX_TOP) {
    throw failure(400, `pageSize takes at most ${aiSearch.SERVICE_MAX_TOP} on passages`);
  }

  const acl = filterFor(access, 'projectId', 'documentId');
  if (acl.empty) return { rows: [], count: 0 };

  const facets = CHUNK_PARENT_LIST_REFS.filter(column => parsed.filters[column]);
  const live = await chunkQuery.liveFacetColumns(facets, acl, parsed.filters.projectId || []);
  const recovery = await recoverFacets(access, parsed, live);
  const { filter } = indexFilter(INDEX_MAP, recovery.parsed, access, acl);

  const { items, count } = await aiSearch.searchChunks({
    filter: recovery.clauses.length ? andOData(filter, ...recovery.clauses) : filter,
    keywords: parsed.q,
    fuzzy: parsed.fuzzy,
    skip: parsed.pageNum * parsed.pageSize,
    top: parsed.pageSize
  });
  if (items.length === 0) return { rows: [], count };

  const gated = await chunkQuery.gateChunksByParent(access, items, count);
  const checked = checkParents(gated, recovery.checks);
  const rows = checked.visible.map(chunk => ({
    id: String(chunk.chunkId),
    documentId: String(chunk.documentId),
    projectId: String(chunk.projectId),
    pageNumber: chunk.pageNumber,
    pageNumbered: chunk.pageNumbered === true,
    snippet: chunk.snippet || '',
    ...parentFields(gated.docById.get(String(chunk.documentId)))
  }));
  return { rows, count: checked.count };
}

/**
 * Facets the chunks index cannot answer go to a documentId scope, or past its cap to a parent-row
 * check. Returns a copy of `parsed`: `passagesFor` keys on the original.
 */
async function recoverFacets(access, parsed, live) {
  if (!live.unavailable.length) return { parsed, clauses: [], checks: [] };

  const filters = { ...parsed.filters };
  const query = parsed.filters.projectId ? { project: parsed.filters.projectId } : {};
  for (const column of live.unavailable) {
    delete filters[column];
    query[`and[${WIRE_KEYS[column]}]`] = parsed.filters[column];
  }
  const { scope, recovered, capped } =
    await recoverChunkFilters(query, live.unavailable.map(column => WIRE_KEYS[column]), access);

  const checks = live.unavailable.filter(column => !recovered.includes(WIRE_KEYS[column]))
    .map(column => [column, parsed.filters[column]]);
  const clauses = scope ? [scope] : [];
  // Only the backlog blocks these columns, and a never-stamped chunk carries null in all of them, so
  // the clause keeps every chunk the row check may admit. A column the index lacks fails the request.
  if (live.unstampedScope && !live.missingColumn && !live.unknownScope) {
    clauses.push(...checks.map(([column, values]) => `${inClause(column, values)} or ${column} eq null`));
  }
  if (checks.length) {
    logger.warn('[passages] facet filter checked on parent documents: the documents index could not scope it', {
      columns: checks.map(([column]) => column), reasons: chunkQuery.facetReasons(live), capped
    });
  }
  return { parsed: { ...parsed, filters }, clauses, checks };
}

/** Keeps a gated chunk only if its parent, as this caller may read it, holds an asked value of each checked column. */
function checkParents(gated, checks) {
  if (!checks.length) return gated;
  const visible = gated.visible.filter((chunk) => {
    const parent = gated.docById.get(String(chunk.documentId));
    return checks.every(([column, values]) => parent[column] != null && values.includes(String(parent[column])));
  });
  // An upper bound, as the gate's own count is for withheld parents.
  const removed = gated.visible.length - visible.length;
  return { visible, count: Math.max(gated.count - removed, visible.length) };
}

// list and count of one request get the same `parsed`, so they share one index read.
const reads = new WeakMap();
function passagesFor(access, parsed) {
  if (!reads.has(parsed)) reads.set(parsed, readPassages(access, parsed));
  return reads.get(parsed);
}

const repository = Object.freeze({
  async list(access, { parsed }) {
    return (await passagesFor(access, parsed)).rows;
  },
  async count(access, { parsed }) {
    return (await passagesFor(access, parsed)).count;
  }
});

const SPEC = Object.freeze({
  entity: 'passages',
  repository,
  sortKeys: [],
  filters: FILTERS,
  aliases: { project: 'projectId' },
  multiValueFilters: FILTERS,
  searchOptions: ['fuzzy'],
  // The index matches chunk text; `snippet` is the only part of it a row shows.
  qFields: ['snippet'],
  parentJoin: projectParentJoin
});

const list = listHandler(SPEC);

/** Absent `pageSize` would default to the contract's 1000, past this list's cap. */
exports.getPassages = (req, res) => {
  const query = req.query || {};
  req.query = query.pageSize === undefined ? { ...query, pageSize: String(MAX_IDS) } : query;
  return list(req, res);
};
exports.SPEC = SPEC;

const SUMMARY_PARAMS = Object.freeze(['q', 'fuzzy']);

/** The refusal for a summary query, or null. As strict as the list: no `keywords` alias, no paging. */
function summaryQueryError(query) {
  for (const [key, value] of Object.entries(query)) {
    if (!SUMMARY_PARAMS.includes(key)) return `unknown parameter: ${key}`;
    if (typeof value !== 'string') return `parameter given more than once: ${key}`;
  }
  if (query.fuzzy !== undefined && query.fuzzy !== 'true' && query.fuzzy !== 'false') {
    return 'fuzzy takes only true or false';
  }
  return null;
}

/** `GET /documents/passages/summary`: the `/search/summary` handler behind this route's own parameters. */
exports.summarizePassages = (req, res) => {
  const error = summaryQueryError(req.query || {});
  if (error) return res.status(400).json({ error });
  return summary.summarize(req, res);
};
