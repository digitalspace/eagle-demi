'use strict';

/**
 * Native passage reads: `GET /documents/passages`, one row per chunks-index hit, on the list
 * contract in `helpers/native-query.js`. `q` is required; rows carry the index highlight as
 * `snippet`, never chunk text, and only for chunks whose parent document the caller may read.
 */

const aiSearch = require('../../search/ai-search');
const chunkQuery = require('../../search/chunk-query');
const { indexFilter } = require('../../search/native-index');
const { CHUNK_PARENT_LIST_REFS } = require('../../repositories/chunks');
const { filterFor } = require('../../helpers/access-odata');
const { MAX_IDS, projectParentJoin } = require('../../helpers/native-query');
const { listHandler } = require('../nosql/mirror-reads');
const { logger } = require('../../utils/logger');

// Native field -> chunks index column; the index keeps the stored names.
const FILTERS = ['projectId', 'documentId', ...CHUNK_PARENT_LIST_REFS];
const INDEX_MAP = Object.freeze({ columns: Object.fromEntries(FILTERS.map(field => [field, field])) });

function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readPassages(access, parsed) {
  if (!parsed.q) throw failure(400, 'q is required');
  if (parsed.ids) throw failure(400, 'ids is not supported on passages');
  if (parsed.pageSize > MAX_IDS) throw failure(400, `pageSize takes at most ${MAX_IDS} on passages`);

  const acl = filterFor(access, 'projectId', 'documentId');
  const { filter, empty } = indexFilter(INDEX_MAP, parsed, access, acl);
  if (empty) return { rows: [], count: 0 };

  // A facet over chunks the backfill has not stamped answers 0 rows; refuse rather than say "none".
  const facets = CHUNK_PARENT_LIST_REFS.filter(column => parsed.filters[column]);
  const live = await chunkQuery.liveFacetColumns(facets, acl, parsed.filters.projectId || []);
  if (live.unavailable.length) {
    const reasons = chunkQuery.facetReasons(live);
    logger.warn('[passages] facet filter refused: chunk index cannot answer it for this scope', {
      columns: live.unavailable, reasons
    });
    throw failure(503, `cannot filter passages on ${live.unavailable.join(', ')} yet: ${reasons.join(', ')}`);
  }

  const { items, count } = await aiSearch.searchChunks({
    filter,
    keywords: parsed.q,
    skip: parsed.pageNum * parsed.pageSize,
    top: parsed.pageSize
  });
  if (items.length === 0) return { rows: [], count };

  const gated = await chunkQuery.gateChunksByParent(access, items, count);
  const rows = gated.visible.map(chunk => ({
    id: String(chunk.chunkId),
    documentId: String(chunk.documentId),
    projectId: String(chunk.projectId),
    pageNumber: chunk.pageNumber,
    pageNumbered: chunk.pageNumbered === true,
    snippet: chunk.snippet || ''
  }));
  return { rows, count: gated.count };
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
