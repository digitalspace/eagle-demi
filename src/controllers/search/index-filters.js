'use strict';

// Which container owns an Eagle id, said once for the mirrors, the seed and this read path.
const { pickParent } = require('../../helpers/parent-admit');
const { logger } = require('../../utils/logger');
const { inClause } = require('../../helpers/access-odata');
const aiSearch = require('../../search/ai-search');
const eagleQuery = require('../../search/eagle-query');
const { documentsAcl } = require('../../search/document-query');
const { andOData } = require('../../search/native-index');
const chunkQuery = require('../../search/chunk-query');
const projectsRepo = require('../../repositories/projects');
const { EAGLE_OBJECT_ID } = projectsRepo;
const notificationsRepo = require('../../repositories/notifications');

/**
 * Rewrite `&project=`/`&and[project]=` from Eagle ObjectIds into DEMI project ids. Unresolved ids pass
 * through, see wiki Search-Query-Construction#unresolved-project-ids-pass-through-as-literals.
 * @returns {object} the query with every project id in DEMI's id space.
 */
async function resolveProjectFilter(access, query) {
  const requested = eagleQuery.projectIdsFrom(query);
  if (requested.length === 0) return query;

  const demiIds = [];
  for (const id of requested) {
    if (!EAGLE_OBJECT_ID.test(id)) {
      demiIds.push(id);
      continue;
    }
    // `pickParent` is the rule the mirrors partition by. A project's `eagleId` can be a
    // notification's id, and that project's partition holds none of the notification's rows.
    const [project, notification] = await Promise.all([
      projectsRepo.getByEagleId(access, id),
      notificationsRepo.getById(access, id)
    ]);
    const parent = pickParent(project, notification);
    // Neither row: keep the caller's own id. It may still name a real partition, and an id that
    // matches nothing is the right answer for one that names nothing.
    demiIds.push(parent ? parent.id : id);
  }

  return eagleQuery.withProjectIds(query, demiIds);
}

/**
 * Resolve the chunk filters a chunk carries no copy of against the `documents` index. See
 * wiki Search-Query-Construction#chunk-filters-answer-on-the-chunks-own-copy.
 * @returns {{scope: ?string, recovered: string[], capped: boolean}} `capped`: too many documents match.
 */
async function recoverChunkFilters(query, dropped, access) {
  if (!dropped.length) return { scope: null, recovered: [], capped: false };
  // THE DOCUMENTS INDEX'S OWN ACL, never the chunk query's: a document-scoped credential compares
  // `documentId` there and `id` here, and the chunk clause sent to this index is a 400.
  const acl = documentsAcl(access);

  // Ask the index which keys it can express by building a filter, not a hardcoded list that goes
  // stale. Rebuilt in the WIRE shape: `dropped` holds base names, the query holds `and[name]`.
  const narrowed = {};
  // The caller's project scope comes along, and it is what decides whether the rest fits under the
  // cap. `project` is never in `dropped` here, so nothing else would offer it.
  if (query.project !== undefined) narrowed.project = query.project;
  // Read through `andParams`, the generator `buildFilter` also reads with, so both wire shapes are
  // handled — see wiki Search-Query-Construction#query-parser-shapes.
  const wanted = new Set(dropped);
  for (const [key, value] of eagleQuery.andParams(query)) {
    if (wanted.has(key)) narrowed[`and[${key}]`] = value;
  }
  // The bare-key form, for the handful of filters that are not `and[...]` at all.
  for (const key of dropped) {
    if (query[key] !== undefined) narrowed[key] = query[key];
  }
  if (Object.keys(narrowed).length === 0) return { scope: null, recovered: [], capped: false };

  const { filter: docFilter, dropped: stillDropped } =
    eagleQuery.buildFilter(narrowed, 'Document', acl, access);
  const recovered = dropped.filter(key => !stillDropped.includes(key));
  if (!recovered.length || !docFilter) return { scope: null, recovered: [], capped: false };

  const { ids, total, withinCap } = await aiSearch.documentIdsMatching(docFilter);
  if (!withinCap) {
    logger.warn('[search] chunk filter matches too many documents to scope', {
      keys: recovered, documents: total, cap: aiSearch.DOCUMENT_SCOPE_CAP
    });
    return { scope: null, recovered: [], capped: true };
  }

  // No matching document means no matching chunk, and that is a MEASUREMENT. Expressed as a clause
  // that cannot match rather than an early return, so count and ACL stay on one code path.
  if (ids.length === 0) return { scope: "documentId eq ''", recovered, capped: false };

  return { scope: inClause('documentId', ids), recovered, capped: false };
}

/**
 * `recoverChunkFilters`, then a parent-row check for each facet it could not scope, as native
 * passages does. `handled`: the dropped keys either one answers.
 */
async function recoverChunkFacets(query, dropped, access, liveFacets) {
  const { scope, recovered, capped } = await recoverChunkFilters(query, dropped, access);
  const unscoped = liveFacets.unavailable.filter(key => dropped.includes(key) && !recovered.includes(key));
  const params = Array.from(eagleQuery.andParams(query));
  const valuesFor = key => params.filter(([name]) => name === key).flatMap(([, value]) => eagleQuery.valuesOf(value));
  // An empty value is no filter and not dropped, as `buildFilter` reads it where the chunks index answers.
  const keys = unscoped.filter(key => valuesFor(key).length);
  const handled = [...recovered, ...unscoped];
  if (!keys.length) return { scope, handled, capped, checks: [] };

  const checks = keys.map(key => [eagleQuery.DOCUMENT_FACETS[key], valuesFor(key)]);
  const reasons = chunkQuery.facetReasons(liveFacets);
  logger.warn('[search] facet filter checked on parent documents: the documents index could not scope it',
    { keys, reasons, capped });
  return { scope: andOData(scope, ...chunkQuery.parentCheckClauses(liveFacets, checks)), handled, capped, checks };
}

/**
 * The facet WIRE KEYS this request sent that the live chunks index cannot answer. They go to
 * `buildFilter` as inexpressible, so the documents-index recovery can still answer them.
 */
async function liveChunkFacets(query, acl, projectIds) {
  const asked = new Set(eagleQuery.filterKeysIn(query));
  const facets = Object.keys(eagleQuery.DOCUMENT_FACETS).filter(key => asked.has(key));
  const live = await chunkQuery.liveFacetColumns(
    facets.map(key => eagleQuery.DOCUMENT_FACETS[key]), acl, projectIds);
  const unavailable = new Set(live.unavailable);
  return { ...live, unavailable: facets.filter(key => unavailable.has(eagleQuery.DOCUMENT_FACETS[key])) };
}

/**
 * The OData scope for `?docIds=<pipe-separated Eagle ids>`, or null when the caller sent none.
 * A PRESENT-BUT-EMPTY value matches nothing, not everything: it names an empty set.
 */
function documentIdScope(raw) {
  if (raw === undefined || raw === null) return null;
  const ids = String(Array.isArray(raw) ? raw.join('|') : raw)
    .split('|').map(v => v.trim()).filter(Boolean);
  if (ids.length === 0) return "id eq ''";
  return inClause('id', ids);
}

module.exports = {
  resolveProjectFilter,
  recoverChunkFilters,
  recoverChunkFacets,
  liveChunkFacets,
  documentIdScope
};
