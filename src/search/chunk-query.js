'use strict';

/**
 * Chunk-index logic shared by compat `/search?dataset=DocumentChunk` and native passages: which
 * parent-field columns this scope can filter on, and the parent-document gate on a page of chunks.
 * See wiki Search-Query-Construction#chunk-filters-answer-on-the-chunks-own-copy.
 */

const aiSearch = require('./ai-search');
const chunksRepo = require('../repositories/chunks');
const documentsRepo = require('../repositories/documents');
const projectsRepo = require('../repositories/projects');
const { redactAllForAccess } = require('../vis/redact');
const { logger } = require('../utils/logger');

/**
 * Which of the asked chunk index columns the LIVE chunks index cannot answer for this scope.
 *
 * EXPRESSIBLE IS TWO FACTS, NOT ONE: the live index has to carry the column, AND every row this
 * request can see has to already hold the current stamp. A chunk the backfill has not reached
 * holds `null` in all four, so a clause over a carried-but-unstamped column is not a narrower
 * answer — it is 0 rows under a 200, which reads as "no documents of that type" rather than as a
 * backfill that has not finished. `eagle-query` reads the packaged `chunks.json`, which an operator
 * PUT applies separately, so package and service disagree for the length of a deploy window.
 *
 * @param {string[]} columns        chunk index columns the request filters on
 * @param {{filter: ?string}} acl   the caller's clause, as the chunk query itself receives it
 * @param {string[]} projectIds     DEMI project ids from the request, empty for a corpus-wide read
 * @returns {Promise<{unavailable: string[], unstampedScope: boolean, unknownScope: boolean,
 *   missingColumn: boolean}>}
 *   `unavailable` are the columns not to send. `unstampedScope` is true ONLY for a MEASURED backlog
 *   in this caller's own scope. `unknownScope`: a column withheld because a question went
 *   unanswered. `missingColumn`: the live index does not carry the column at all, which is a deploy
 *   whose `chunks.json` PUT has not been applied. None of the three says a count.
 */
async function liveFacetColumns(columns, acl, projectIds) {
  if (!columns.length) {
    return { unavailable: [], unstampedScope: false, unknownScope: false, missingColumn: false };
  }

  // THE FOUR LIST REFS ONLY: `projectId` is stamped beside them but no facet filters on it, and a
  // fifth probe is a fifth request per cold cache over a column nobody asked about.
  const status = await aiSearch.chunkParentFieldStatus(
    chunksRepo.CHUNK_PARENT_LIST_REFS, chunksRepo.CHUNK_PARENT_FIELDS_VERSION);
  // The probe resolves to a partial answer rather than throwing, so the shape is checked as well.
  const shape = (status && typeof status === 'object') ? status : {};
  const answerable = new Set(Array.isArray(shape.available) ? shape.available : []);
  const absent = new Set(Array.isArray(shape.missing) ? shape.missing : []);
  const carried = columns.filter(column => answerable.has(column));
  // UNDECIDED IS NOT ABSENT: only an unanswered question clears by itself, so only it earns the reason.
  const undecided = columns.some(column => !answerable.has(column) && !absent.has(column));
  // Settled, but a different reason: it clears when the index definition is applied, not by waiting.
  const missingColumn = columns.some(column => absent.has(column));
  if (!carried.length) {
    return { unavailable: columns, unstampedScope: false, unknownScope: undecided, missingColumn };
  }

  // The index-wide count is the FREE SUPERSET: nothing behind anywhere means nothing behind here.
  // Anything else is decided under this request's own predicate.
  const stale = shape.unstamped === 0 ? 0 : await staleChunksInScope(acl, projectIds);
  if (stale !== 0) {
    // Withheld WHOLE, carried columns included: one unstamped column answering 0 poisons the whole
    // conjunction. A `null` count withholds too, but is reported as the unknown it is.
    return {
      unavailable: columns,
      unstampedScope: stale > 0,
      unknownScope: stale === null || undecided,
      missingColumn
    };
  }

  // ONLY WHAT THE PROBE PROVED FILTERABLE IS SENT: a clause the index cannot answer 502s the whole
  // request, while a withheld one costs one filter that the caller may still recover elsewhere.
  return {
    unavailable: columns.filter(column => !carried.includes(column)),
    unstampedScope: false,
    unknownScope: undecided,
    missingColumn
  };
}

/**
 * How many SCOPES of stale-chunk count are remembered at once. Bounded because the key carries a
 * project id, so an unbounded map grows with every project ever searched in this process.
 * Oldest-first eviction: a refreshed entry is re-inserted, which keeps a busy scope near the end.
 */
const STALE_SCOPE_CACHE_MAX = 32;
const staleScopeCounts = new Map();

/**
 * How many chunks THIS REQUEST could see still carry an older parent-field stamp than the code
 * writes — `null` when the question could not be answered, never 0.
 *
 * SCOPED, because the mark it gates says the caller's own filter is missing rows: same predicate,
 * same population, one answer. Never the caller's keywords — a stale chunk that does not match the
 * terms is still a row the facet filter had to skip. Cached per scope for `LIVE_SCHEMA_TTL_MS`,
 * since Deep Search fires on a debounced keystroke; an unanswered count is held for
 * `UNKNOWN_STATUS_TTL_MS` only. See wiki Search-Query-Construction#deep-search-can-be-degraded-three-ways.
 *
 * @param {{filter: ?string}} acl  the caller's clause, as the chunk query itself received it
 * @param {string[]} projectIds    DEMI project ids from the request, empty for a corpus-wide read
 */
async function staleChunksInScope(acl, projectIds) {
  const now = Date.now();
  // The ACL CLAUSE ITSELF is the access half of the key, not a role list: it is exactly what makes
  // two callers see the same rows, so two callers it renders identically may share one count.
  const key = `${acl.filter || '*'}\n${projectIds.join(',')}`;
  const hit = staleScopeCounts.get(key);
  if (hit && now - hit.at < hit.ttl) {
    // Re-inserted so a HIT moves the key to the end too: eviction reads insertion order.
    staleScopeCounts.delete(key);
    staleScopeCounts.set(key, hit);
    return hit.promise;
  }

  const entry = { at: now, ttl: aiSearch.LIVE_SCHEMA_TTL_MS, promise: null };
  // The PROMISE is cached rather than its value, so a burst hitting a cold cache issues one probe.
  entry.promise = aiSearch.staleChunkCount({
    version: chunksRepo.CHUNK_PARENT_FIELDS_VERSION,
    aclFilter: acl.filter || null,
    projectIds
  })
    .then((count) => {
      // `null` is "cannot say", not a fact about the backfill, so it is held for the short TTL.
      if (count === null) entry.ttl = aiSearch.UNKNOWN_STATUS_TTL_MS;
      return count;
    })
    .catch((err) => {
      // The page is unaffected: this is the count behind an advisory mark, and a question that was
      // not answered leaves the page unmarked exactly as `unstamped: null` does.
      logger.warn(`[search] could not count unstamped chunks for this scope: ${err.message}`);
      entry.ttl = aiSearch.UNKNOWN_STATUS_TTL_MS;
      return null;
    });

  staleScopeCounts.delete(key);
  staleScopeCounts.set(key, entry);
  if (staleScopeCounts.size > STALE_SCOPE_CACHE_MAX) {
    staleScopeCounts.delete(staleScopeCounts.keys().next().value);
  }
  return entry.promise;
}

/**
 * Test seam: the counts live for the schema TTL, which outlives a whole test process, so without
 * it whether a probe is issued depends on which test ran first.
 */
const resetStaleChunkScopeCache = () => staleScopeCounts.clear();

/**
 * THE GATE, not a label lookup: a caller who cannot see a chunk's parent document cannot see its
 * text. Parents are read under the CALLER's access, never systemAccess(), and redacted before any
 * label is read off them. `listByIds` is ACL-enforcing and unbounded, so a miss means DENIED, not
 * truncated. See wiki Search-Query-Construction#the-parent-document-is-the-chunk-gate.
 *
 * @param {object} access    the caller's resolved access
 * @param {object[]} items   one page of chunk hits, each with `documentId` and `projectId`
 * @param {number} count     the index-wide passage total for the query
 * @returns {Promise<{visible: object[], docById: Map, projById: Map, count: number}>}
 *   `count` is net of what this page withheld, floored at `visible.length`.
 */
async function gateChunksByParent(access, items, count) {
  const projectIds = items.map(c => c.projectId);
  const [parentDocs, parentProjects] = await Promise.all([
    documentsRepo.listByIds(access, items.map(c => c.documentId), projectIds),
    projectsRepo.listByIds(access, projectIds)
  ]);
  const docById = new Map(redactAllForAccess('documents', parentDocs, access)
    .map(d => [String(d.id), d]));
  const projById = new Map(redactAllForAccess('projects', parentProjects, access)
    .map(p => [String(p.id), p]));

  const visible = items.filter(chunk => docById.has(String(chunk.documentId)));
  const withheld = items.length - visible.length;
  if (withheld > 0) {
    logger.warn('[search] withheld chunks whose parent document is not visible', {
      withheld, returned: visible.length
    });
  }
  return {
    visible,
    docById,
    projById,
    count: withheld > 0 ? Math.max(count - withheld, visible.length) : count
  };
}

module.exports = {
  liveFacetColumns,
  staleChunksInScope,
  resetStaleChunkScopeCache,
  gateChunksByParent
};
