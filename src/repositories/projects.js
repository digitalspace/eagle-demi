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
const { canRead } = require('../helpers/access-sql');
const { catalogFor } = require('../vis/catalog');
const { visible } = require('../vis/redact');
const { levelOf } = require('../vis/level');
const { eq, inList, isDefinedAndNotNull, selectWhere, selectFor, countWhere, pageOptions, fetchAll } = require('./_sql');

const CONTAINER = 'projects';
const PARTITION_FIELD = 'id';

/** Every field a caller may narrow a project list by, and the SQL parameter each binds to. */
const CRITERIA_FIELDS = {
  regionalDistrict: '@rd',
  municipality: '@muni',
  electoralDistrict: '@ed'
};

/**
 * Criteria shared by list and count so the two can never diverge — a count built from a
 * different predicate would leak the size of a set the caller cannot read.
 *
 * REJECTED, NOT DROPPED, for a field this caller cannot see: a narrowed count answers what the
 * hidden value is. All three are `defaultVis: 4` today, so nothing reaches the throw.
 */
function buildCriteria(opts, access) {
  const catalog = catalogFor('projects');
  const level = levelOf(access);

  return Object.entries(CRITERIA_FIELDS)
    .filter(([field]) => opts[field])
    .map(([field, param]) => {
      const entry = catalog[field];
      if (!entry || !visible(level, entry.defaultVis)) {
        throw new Error(`[projects] cannot filter on a field this caller cannot see: ${field}`);
      }
      return eq(field, opts[field], param);
    });
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
    criteria: buildCriteria(opts, access),
    // getById keeps the raw point read: canRead needs the whole row, and the controllers upsert
    // what they read.
    select: selectFor('projects', access, PARTITION_FIELD),
    orderBy: 'c.name ASC'
  });

  return cosmos.query(CONTAINER, spec, pageOptions(opts));
}

async function countVisible(access, opts = {}) {
  const spec = countWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: buildCriteria(opts, access)
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
 * An Eagle ObjectId. DEMI project ids are Track integers or `eagle-<ObjectId>`, so an id in this
 * shape is unambiguously Eagle's and the two spaces cannot collide.
 */
const EAGLE_OBJECT_ID = /^[0-9a-f]{24}$/i;

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

/** The leaf, not the object: only scalar paths are indexed (Bicep includes /centroid/type/?). */
const centroidCriteria = () => [isDefinedAndNotNull('centroid.type')];

/** Projects with a usable centroid — for boundary tagging. */
async function listWithCentroid(access) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: centroidCriteria(),
    select: 'c.id, c.name, c.centroid'
  });
  return cosmos.query(CONTAINER, spec);
}

/** COUNT of exactly what listWithCentroid reads. */
async function countWithCentroid(access) {
  const spec = countWhere({ access, partitionField: PARTITION_FIELD, criteria: centroidCriteria() });
  const value = await cosmos.queryValue(CONTAINER, spec);
  return value || 0;
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

/**
 * Set field visibility dials. `patch`, NEVER `upsert` — an upsert writes the whole record, so a
 * classify would clobber any content write that landed since this caller read it (the failure
 * api-keys.touchLastUsed documents). A dial the body does not name is left alone; a `null` level
 * REMOVES the dial, so the field falls back to its catalog `defaultVis`.
 */
async function patchVis(id, vis) {
  // Cosmos refuses `set /vis/<field>` when the parent node is absent, and no write site emits
  // `vis`, so an unclassified project takes one whole-map set — it has no dials to preserve.
  const existing = await cosmos.readItem(CONTAINER, String(id), String(id));
  const dials = existing && existing.vis && typeof existing.vis === 'object' ? existing.vis : null;

  const operations = dials
    ? Object.entries(vis)
      .filter(([field, level]) => level !== null || Object.hasOwn(dials, field))
      .map(([field, level]) => (level === null
        ? { op: 'remove', path: `/vis/${field}` }
        : { op: 'set', path: `/vis/${field}`, value: level }))
    : [{
      op: 'set',
      path: '/vis',
      value: Object.fromEntries(Object.entries(vis).filter(([, level]) => level !== null))
    }];

  // Every key asked to remove a dial the record never held. patch() throws on an empty array.
  if (!operations.length) return existing;

  return cosmos.patch(CONTAINER, String(id), String(id), operations);
}

async function deleteById(id) {
  return cosmos.remove(CONTAINER, String(id), String(id));
}

module.exports = {
  CONTAINER,
  PARTITION_FIELD,
  buildCriteria,
  CRITERIA_FIELDS,
  listVisible,
  countVisible,
  getById,
  EAGLE_OBJECT_ID,
  getByEagleId,
  listByIds,
  listWithCentroid,
  countWithCentroid,
  listEagleOnlyIds,
  countEagleOnlyIds,
  listWithEagleId,
  countWithEagleId,
  upsert,
  patchWildfireStats,
  patchBoundaries,
  patchVis,
  deleteById
};
