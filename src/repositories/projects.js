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
const { eq, inList, isDefinedAndNotNull, selectWhere, countWhere, pageOptions } = require('./_sql');

const CONTAINER = 'projects';
const PARTITION_FIELD = 'id';

/**
 * Criteria shared by list and count so the two can never diverge — a count built from a
 * different predicate would leak the size of a set the caller cannot read.
 */
function buildCriteria({ trackOnly, regionalDistrict, municipality, electoralDistrict }) {
  const criteria = [];

  // Provenance, not visibility. `sourceSystem` replaces the old
  // `sources.track EXISTS AND != null` test with an indexed equality — and sidesteps the
  // Mongo/SQL disagreement over whether a missing field matches $ne.
  if (trackOnly) criteria.push(eq('sourceSystem', 'track', '@sourceSystem'));

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
 * Names for a bounded set of project ids, in one query.
 *
 * Chunk search hits carry a projectId and no name, so the results have to be labelled. Only the
 * name is projected — the caller is entitled to the label, not to the project record.
 */
async function listByIds(access, ids) {
  const unique = Array.from(new Set((ids || []).map(String)));
  if (unique.length === 0) return [];

  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [inList(PARTITION_FIELD, unique, '@pid')],
    select: 'c.id, c.name'
  });

  const { items } = await cosmos.query(CONTAINER, spec, {});
  return items;
}

/** Projects with a usable centroid — for boundary tagging. */
async function listWithCentroid(access) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [isDefinedAndNotNull('centroid')],
    select: 'c.id, c.name, c.centroid'
  });
  return cosmos.query(CONTAINER, spec);
}

/**
 * A stored project as it may leave over HTTP.
 *
 * `sources` retains the raw Track and Eagle payloads so a re-merge never has to re-fetch upstream
 * (merge/project.js). That is traceability, not API surface: passing it through puts every field a
 * future upstream adds onto an anonymous response with nobody having looked at it, and the read
 * ACL cannot help — it gates which rows are returned, not which fields.
 *
 * `sources.wildfire` is the exception and stays: it is DEMI's own aggregate, written by
 * patchWildfireStats below, and the map explorer renders it.
 *
 * An allowlist rather than a denylist for the same reason, which also retires the dead
 * `sources.nrpti` block without a second rule.
 *
 * Applied at res.json and nowhere else. Stripping in the data layer instead would be silently
 * destructive: updateProject reads, spreads and upserts, so a stripped read would erase `sources`
 * from the stored document on the next edit.
 */
function publicView(project) {
  if (!project) return project;

  const { sources, ...rest } = project;
  const wildfire = sources && sources.wildfire;

  return wildfire ? { ...rest, sources: { wildfire } } : rest;
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
  upsert,
  patchWildfireStats,
  patchBoundaries,
  deleteById
};
