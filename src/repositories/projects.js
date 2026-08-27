'use strict';

/**
 * Projects repository — Cosmos NoSQL.
 *
 * Container `projects`, partitioned by `/id` (the Track project id). Every query is either a
 * point read or a full list; no query filters on a grouping dimension, so /id gives perfect
 * distribution and 1 RU point reads.
 *
 * Named methods rather than a generic find(filter): the filter-object interface is what let a
 * broken translator disable access control. Each method owns its SQL and cannot emit an
 * unfiltered read.
 */

const cosmos = require('../db/cosmos-nosql');
const config = require('../config');
const { canRead } = require('../helpers/access-sql');
const { eq, inList, isDefinedAndNotNull, selectWhere, countWhere, pageOptions, fetchAll } = require('./_sql');

const CONTAINER = 'projects';
const PARTITION_FIELD = 'id';

/**
 * Criteria shared by list and count so the two can never diverge — a count built from a
 * different predicate would leak the size of a set the caller cannot read.
 */
function buildCriteria({ regionalDistrict, municipality, electoralDistrict }) {
  const criteria = [];

  if (regionalDistrict) criteria.push(eq('regionalDistrict', regionalDistrict, '@rd'));
  if (municipality) criteria.push(eq('municipality', municipality, '@muni'));
  if (electoralDistrict) criteria.push(eq('electoralDistrict', electoralDistrict, '@ed'));

  return criteria;
}

/**
 * List projects visible to this caller.
 * ORDER BY c.name requires /name to be indexed — it is, in the container's indexing policy.
 * Without the index Cosmos rejects the sort outright rather than degrading.
 */
async function listVisible(access, opts = {}) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: buildCriteria(opts),
    orderBy: 'c.name ASC'
  });

  return cosmos.query(CONTAINER, spec, pageOptions(opts));
}

async function countVisible(access, opts = {}) {
  const spec = countWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: buildCriteria(opts)
  });

  const value = await cosmos.queryValue(CONTAINER, spec);
  return value || 0;
}

/**
 * Point read by Track id. The partition key IS the id here, so this is a true 1 RU read.
 *
 * Gated with canRead(): a point read bypasses the query predicate entirely, so without this a
 * by-id fetch would return what a list would not.
 */
async function getById(access, id) {
  const doc = await cosmos.readItem(CONTAINER, String(id), String(id));
  if (!doc) return null;
  return canRead(doc, access, PARTITION_FIELD) ? doc : null;
}

/**
 * Look up by an alternate identity. Used by the seeders, which hold an Eagle ObjectId rather
 * than a Track id.
 *
 * Cross-partition by necessity — eagleId is not the partition key — but it returns at most
 * one item, so the cost is a few RU, not a scan.
 */
async function getByEagleId(access, eagleId) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [eq('eagleId', String(eagleId), '@eagleId')]
  });

  const { items } = await cosmos.query(CONTAINER, spec, { maxItemCount: 1 });
  return items[0] || null;
}

/**
 * Names and Eagle ids for a bounded set of project ids, in one query.
 *
 * Chunk and document search hits carry a projectId and no name, so the results have to be labelled.
 * Only the name and the alternate identifier are projected — the caller is entitled to the label,
 * not to the project record. `eagleId` is what the search response puts in `project._id`, because
 * that is the id eagle-api's routes accept; it rides along here rather than in a second lookup,
 * since this read already runs once per result page and is already ACL-gated.
 */
async function listByIds(access, ids) {
  const unique = Array.from(new Set((ids || []).map(String)));
  if (unique.length === 0) return [];

  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [inList(PARTITION_FIELD, unique, '@pid')],
    select: 'c.id, c.name, c.eagleId'
  });

  const { items } = await cosmos.query(CONTAINER, spec, {});
  return items;
}

/** Projects with a usable centroid — for boundary tagging. */
async function listWithCentroid(access) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    // The leaf, not the object: only scalar paths are indexed (Bicep includes /centroid/type/?).
    criteria: [isDefinedAndNotNull('centroid.type')],
    select: 'c.id, c.name, c.centroid'
  });
  return cosmos.query(CONTAINER, spec);
}

/**
 * A stored project as it may leave over HTTP.
 *
 * `sources` holds raw upstream payloads for re-merge traceability, not API surface, so only the
 * enrichment keys named in ENRICHMENT_SOURCES pass — an allowlist, so a new upstream field is
 * never published by default. `read[]` is the caller's own ACL restated and would publish internal
 * role names; `isPublished` is derived from it. `_etag` has no round-tripping caller.
 *
 * Applied at res.json and nowhere else: updateProject reads, spreads and upserts, so stripping in
 * the data layer would erase these from the stored document on the next edit.
 */
function publicView(project) {
  if (!project) return project;

  const { sources, read, _etag, ...rest } = project;
  const view = {
    ...rest,
    isPublished: Array.isArray(read) && read.length > 0
      ? read.includes('public')
      : rest.isPublished === true
  };

  const allowed = {};
  for (const key of config.enrichmentSources) {
    if (sources && sources[key] !== undefined) allowed[key] = sources[key];
  }

  return Object.keys(allowed).length ? { ...view, sources: allowed } : view;
}

/** The reconcile predicate, shared so the enumeration and its COUNT cannot drift apart. */
const eagleOnlyCriteria = () => [eq('sourceSystem', 'eagle', '@sourceSystem')];

/**
 * `{id, eagleId}` for every Eagle-only project row — the seeder's reconcile set.
 *
 * Track-sourced rows are excluded by the `sourceSystem` filter: they exist whether or not Eagle
 * still carries a counterpart, so computing them as surplus would delete the master registry.
 *
 * NO ORDER BY: a cross-partition sort takes the SDK's query-plan path, whose mergeHeaders never
 * copies `x-ms-continuation`, so fetchAll saw no token and stopped at the first 1,000 rows.
 */
async function listEagleOnlyIds(access) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: eagleOnlyCriteria(),
    select: 'c.id, c.eagleId'
  });
  return fetchAll(CONTAINER, spec);
}

/** COUNT of exactly what listEagleOnlyIds reads — the reconcile's proof that it ran to the end. */
async function countEagleOnlyIds(access) {
  const spec = countWhere({ access, partitionField: PARTITION_FIELD, criteria: eagleOnlyCriteria() });
  const value = await cosmos.queryValue(CONTAINER, spec);
  return value || 0;
}

/** Every row carrying an Eagle identity, whatever wrote it. Shared so its COUNT cannot drift. */
const eagleIdCriteria = () => [isDefinedAndNotNull('eagleId')];

/**
 * `{id, eagleId, sourceSystem}` for every project mirroring an Eagle record — the reconcile's
 * membership set.
 *
 * WIDER than `listEagleOnlyIds` on purpose. A Track-sourced row also carries an `eagleId` when the
 * merge matched one, so a diff computed off the Eagle-sourced rows alone reads every matched
 * project as missing from DEMI. `sourceSystem` rides along because only the Eagle-sourced rows may
 * be purged when Eagle drops one.
 *
 * NO ORDER BY, for the reason `listEagleOnlyIds` gives.
 */
async function listWithEagleId(access) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: eagleIdCriteria(),
    select: 'c.id, c.eagleId, c.sourceSystem'
  });
  return fetchAll(CONTAINER, spec);
}

/** COUNT of exactly what listWithEagleId reads — the reconcile's proof that it ran to the end. */
async function countWithEagleId(access) {
  const spec = countWhere({ access, partitionField: PARTITION_FIELD, criteria: eagleIdCriteria() });
  const value = await cosmos.queryValue(CONTAINER, spec);
  return value || 0;
}

/**
 * Whole-item write. Safe only because nothing is folded into the project as an embedded array
 * any more — a replace from the Track sync would silently discard it. Use the patch helpers
 * below for partial updates.
 */
async function upsert(project) {
  return cosmos.upsert(CONTAINER, project);
}

async function patchWildfireStats(id, stats) {
  return cosmos.patch(CONTAINER, String(id), String(id), [
    { op: 'set', path: '/sources/wildfire', value: stats }
  ]);
}

async function patchBoundaries(id, { regionalDistrict, municipality, electoralDistrict }) {
  return cosmos.patch(CONTAINER, String(id), String(id), [
    { op: 'set', path: '/regionalDistrict', value: regionalDistrict || '' },
    { op: 'set', path: '/municipality', value: municipality || '' },
    { op: 'set', path: '/electoralDistrict', value: electoralDistrict || '' }
  ]);
}

async function deleteById(id) {
  return cosmos.remove(CONTAINER, String(id), String(id));
}

module.exports = {
  CONTAINER,
  PARTITION_FIELD,
  buildCriteria,
  listVisible,
  countVisible,
  getById,
  getByEagleId,
  listByIds,
  listWithCentroid,
  publicView,
  listEagleOnlyIds,
  countEagleOnlyIds,
  listWithEagleId,
  countWithEagleId,
  upsert,
  patchWildfireStats,
  patchBoundaries,
  deleteById
};
