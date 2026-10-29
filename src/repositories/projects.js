'use strict';

// Container `projects`, partitioned by `/id` (the Track id). Named methods, never a generic find(filter):
// that interface let a broken translator disable access control; each method owns SQL that cannot read unfiltered.

const cosmos = require('../db/cosmos-nosql');
const { canRead } = require('../helpers/access-sql');
const { logger } = require('../utils/logger');
const { duplicateIdError } = require('../helpers/duplicate-id');
const { eagleOnlyProjectId } = require('../merge/project');
const { dialAllows } = require('../helpers/native-query');
const { levelOf } = require('../vis/level');
const { deriveAssessments } = require('../merge/assessments');
const { raced } = require('../helpers/etag-write');
const {
  eq, inList, isDefinedAndNotNull, selectWhere, selectFor, countWhere, pageOptions, fetchAll,
  upsertWithEtag, createItem, assertFilterable, readPage
} = require('./_sql');

const CONTAINER = 'projects';
const PARTITION_FIELD = 'id';

/** Every field a caller may narrow a project list by, and the SQL parameter each binds to. */
const CRITERIA_FIELDS = {
  regionalDistrict: '@rd',
  municipality: '@muni',
  electoralDistrict: '@ed'
};

/**
 * Criteria shared by list and count, so a count cannot leak the size of a set the caller cannot read. A hidden
 * field is rejected, not dropped: a narrowed count would reveal the hidden value.
 */
function buildCriteria(opts, access) {
  return Object.entries(CRITERIA_FIELDS)
    .filter(([field]) => opts[field])
    .map(([field, param]) => {
      assertFilterable(CONTAINER, field, access);
      return eq(field, opts[field], param);
    });
}

/** Projects visible to this caller, by name. ORDER BY c.name needs /name indexed, or Cosmos rejects the sort. */
function visibleSpec(access, opts) {
  return selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: buildCriteria(opts, access),
    // getById keeps the raw point read: canRead needs the whole row, and the controllers upsert
    // what they read.
    select: selectFor('projects', access, PARTITION_FIELD),
    orderBy: 'c.name ASC'
  });
}

/** One continuation page: `{items, continuationToken}`. With no `pageSize`, every row. */
async function listVisible(access, opts = {}) {
  return cosmos.query(CONTAINER, visibleSpec(access, opts), pageOptions(opts));
}

/** One offset page (`pageNum`, `pageSize`) of `listVisible`'s rows, past the first 1,000. */
async function listPage(access, { pageNum, pageSize } = {}) {
  return readPage(CONTAINER, visibleSpec(access, {}), { pageNum, pageSize });
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
 * Point read by Track id (the partition key, so 1 RU). Gated with canRead(): a point read skips the query
 * predicate, so without it a by-id fetch would return what a list would not.
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

/** By Eagle ObjectId, for the seeders. Cross-partition, but at most one row, so a few RU, not a scan. */
async function getByEagleId(access, eagleId) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [eq('eagleId', String(eagleId), '@eagleId')]
  });

  // `queryFirst`, not one page: a cross-partition page can come back empty while the row exists, and the
  // seeder would then create a duplicate.
  return await cosmos.queryFirst(CONTAINER, spec, {});
}

/**
 * The stored row for an Eagle id, unfiltered, write side only. A Track row beside its `eagle-<id>` twin wins (the
 * relink keeps the twin); any other pair throws with `code === DUPLICATE_ID`.
 */
async function readForWriteByEagleId(eagleId) {
  const { clause, params } = eq('eagleId', String(eagleId), '@eagleId');
  const { items } = await cosmos.query(CONTAINER,
    { query: `SELECT * FROM c WHERE ${clause}`, parameters: params });
  if (items.length <= 1) return items[0] || null;
  const tracked = items.filter(row => row.id !== eagleOnlyProjectId(String(eagleId)));
  if (tracked.length === 1) return tracked[0];
  throw duplicateIdError(CONTAINER, eagleId, items.map(row => row[PARTITION_FIELD]));
}

/** The stored row by DEMI id, unfiltered. Write side only, like every `readForWrite`. */
async function readForWrite(id) {
  return cosmos.readItem(CONTAINER, String(id), String(id));
}

/**
 * Names and Eagle ids for a bounded id set, to label search hits; only the label is projected, not the record.
 * `eagleId` is what the response puts in `project._id`, the id eagle-api's routes accept.
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

/** Whole rows (this caller's `selectFor` projection) for ids, unordered: an index page joined back. */
async function listRowsByIds(access, ids) {
  const unique = Array.from(new Set((ids || []).map(String)));
  if (unique.length === 0) return [];
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [inList(PARTITION_FIELD, unique, '@pid')],
    select: selectFor('projects', access, PARTITION_FIELD)
  });
  const { items } = await cosmos.query(CONTAINER, spec, {});
  return items;
}

/** The most ids `listIdsByName` answers; a wider match is cut here and logged. */
const NAME_MATCH_MAX_IDS = 500;

/**
 * Ids of the projects this caller may see whose name contains `text`, case-insensitive — eagle-api's
 * CommentPeriod keyword search matched `project.name` the same way. A name its row's dial hides never matches.
 */
async function listIdsByName(access, text) {
  assertFilterable(CONTAINER, 'name', access);
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [{
      clause: `(${dialAllows('name', levelOf(access))} AND CONTAINS(c.name, @name, true))`,
      params: [{ name: '@name', value: String(text) }]
    }],
    select: 'VALUE c.id'
  });
  // One past the cap, so "cut" is measured rather than guessed from a full page.
  const ids = await cosmos.queryPage(CONTAINER, spec, { size: NAME_MATCH_MAX_IDS + 1 });
  if (ids.length > NAME_MATCH_MAX_IDS) {
    logger.warn('[projects] name match cut at its id cap', { text: String(text), cap: NAME_MATCH_MAX_IDS });
  }
  return ids.slice(0, NAME_MATCH_MAX_IDS).map(String);
}

/**
 * `listByIds` by EAGLE id (`updates.projectId` holds one), in one `IN` rather than a read per row. Adds
 * `address` (an update hit's `project.location`) and `vis`, so a per-row dial still hides it.
 */
async function listByEagleIds(access, eagleIds) {
  const unique = Array.from(new Set((eagleIds || []).map(String)));
  if (unique.length === 0) return [];

  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [inList('eagleId', unique, '@eid')],
    select: 'c.id, c.name, c.eagleId, c.address, c.vis'
  });

  const { items } = await cosmos.query(CONTAINER, spec, {});
  return items;
}

/**
 * Projects with a decision dated no later than `now`, newest first: the home feed's decision rows. A row whose
 * dial hides `decisionDate` from this caller is left out, so the order cannot reveal it.
 */
async function listDecisions(access, { limit, now }) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [
      // A null or absent date fails the comparison in Cosmos, so it needs no IS_DEFINED term.
      { clause: 'c.decisionDate <= @now', params: [{ name: '@now', value: now.toISOString() }] },
      { clause: dialAllows('decisionDate', levelOf(access)), params: [] }
    ],
    select: selectFor(CONTAINER, access, PARTITION_FIELD),
    orderBy: 'c.decisionDate DESC'
  });
  return readPage(CONTAINER, spec, { pageSize: limit });
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
 * `{id, eagleId}` of every Eagle-only project: the seeder's reconcile set; Track rows stay out or they would read as surplus.
 * NO ORDER BY: a cross-partition sort's plan path drops `x-ms-continuation`, so fetchAll stopped at 1,000 rows.
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
 * Every project mirroring an Eagle record, Track-sourced included (a matched Track row carries `eagleId` too, else it
 * reads as missing); `sourceSystem` because only Eagle-sourced rows may be purged. NO ORDER BY, as `listEagleOnlyIds`.
 */
async function listWithEagleId(access) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: eagleIdCriteria(),
    select: 'c.id, c.eagleId, c.sourceSystem, c.read, c.isPublished'
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
 * Native list sort keys. Cosmos drops a row lacking the ORDER BY field, so `upsert` writes each (`sortFieldFills`);
 * `eacDecisionSort` stands in for `eacDecision.name`, since filling `eacDecision` would render as a decision.
 */
const SORTABLE = [
  'name', 'dateUpdated', 'proponentName', 'projectType', 'sector', 'region', 'currentPhaseName.name', 'eacDecisionSort'
];

const NULL_WHEN_ABSENT = ['proponentName', 'projectType', 'sector', 'region'];

/** `dateAdded` (stored as a Date.toString() string) as ISO with Z, or null when absent or unparseable. */
function isoOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** `currentPhaseName` as a ref that holds `name`, or undefined when it already does. A bare id is kept as `_id`. */
function phaseRef(phase) {
  if (phase !== null && typeof phase === 'object') {
    return phase.name === undefined ? { ...phase, _id: phase._id ?? null, name: null } : undefined;
  }
  return { _id: phase ?? null, name: null };
}

/**
 * Writes giving a row every SORTABLE field, leaving held ones alone except `currentPhaseName` (must be a ref with
 * `name`) and a stale `eacDecisionSort`. `dateUpdated` falls back to `dateAdded`, never `_ts`.
 */
function sortFieldFills(row) {
  const fills = {};
  if (row.dateUpdated === undefined) fills.dateUpdated = isoOrNull(row.dateAdded);
  for (const field of NULL_WHEN_ABSENT) {
    if (row[field] === undefined) fills[field] = null;
  }
  const phase = phaseRef(row.currentPhaseName);
  if (phase) fills.currentPhaseName = phase;
  const decision = row.eacDecision && typeof row.eacDecision.name === 'string' ? row.eacDecision.name : null;
  if (row.eacDecisionSort !== decision) fills.eacDecisionSort = decision;
  return fills;
}

/**
 * Whole-item write, guarded by `etag` (412 when the row moved) or `create` (409 when created behind the caller):
 * otherwise two pushes 34 ms apart can leave a published project private. Safe only while no embedded array is folded in.
 */
async function upsert(project, { etag, create = false } = {}) {
  // A row read as ABSENT has no revision to guard on, so the insert is the guard: Cosmos answers 409, which
  // callers re-read and re-judge as they do a 412.
  const row = { ...project, ...sortFieldFills(project) };
  if (create) return createItem(CONTAINER, row, 'projects');
  return upsertWithEtag(CONTAINER, row, { etag, label: 'projects' });
}

/**
 * Record or clear (`pendingAt` null) that this project owes a visibility cascade. `patch` guarded on the caller's
 * `etag`, never `upsert`: a whole-item write would replace whatever landed since.
 */
async function patchCascadePending(id, pendingAt, etag) {
  const op = pendingAt
    ? { op: 'set', path: '/cascadePendingAt', value: pendingAt }
    : { op: 'remove', path: '/cascadePendingAt' };
  return cosmos.patch(CONTAINER, String(id), String(id), [op], undefined, etag);
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

/** Set visibility dials (`null` removes one) and re-derive the fields built from the anonymous view; null when the row is gone. */
async function patchVis(id, vis) {
  // Never upsert. One whole-map `/vis` set is safe only under the etag; a set per dial plus the
  // derived fields would pass patch's op cap.
  const key = String(id);

  const write = async (row) => {
    if (!row) return null;
    const dials = row.vis && typeof row.vis === 'object' ? row.vis : {};
    const unchanged = Object.entries(vis)
      .every(([field, level]) => (level === null ? !Object.hasOwn(dials, field) : dials[field] === level));
    if (unchanged) return row;

    const nextVis = { ...dials };
    for (const [field, level] of Object.entries(vis)) {
      if (level === null) delete nextVis[field];
      else nextVis[field] = level;
    }
    const derived = deriveAssessments({ ...row, vis: nextVis }, { previous: row.assessments });
    return cosmos.patch(CONTAINER, key, key, [
      { op: 'set', path: '/vis', value: nextVis },
      { op: 'set', path: '/assessments', value: derived.assessments },
      { op: 'set', path: '/phaseIds', value: derived.phaseIds },
      { op: 'set', path: '/activeWork', value: derived.activeWork }
    ], undefined, row._etag);
  };

  try {
    return await write(await cosmos.readItem(CONTAINER, key, key));
  } catch (err) {
    if (!raced(err)) throw err;
    logger.warn('[projects] visibility patch lost its etag race, rebuilding once', { id: key });
    return write(await cosmos.readItem(CONTAINER, key, key));
  }
}

/**
 * Ids of every project holding `code`, current or legacy. Unfiltered, not systemAccess: that still hides sealed
 * (`compliance`) rows and rows with no `read[]`, which hold codes all the same.
 */
async function listShortCodeOwners(code) {
  const spec = {
    query: 'SELECT c.id FROM c WHERE (c.shortCode = @code OR ARRAY_CONTAINS(c.legacyShortCodes, @code))',
    parameters: [{ name: '@code', value: code }]
  };
  return (await fetchAll(CONTAINER, spec)).map(row => String(row.id));
}

/** Set the three short-link fields only, guarded on the revision the caller read. */
async function patchShortLink(id, { shortCode, shortCodeSource, legacyShortCodes }, etag) {
  return cosmos.patch(CONTAINER, String(id), String(id), [
    { op: 'set', path: '/shortCode', value: shortCode },
    { op: 'set', path: '/shortCodeSource', value: shortCodeSource },
    { op: 'set', path: '/legacyShortCodes', value: legacyShortCodes || [] }
  ], undefined, etag);
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
  listPage,
  countVisible,
  getById,
  EAGLE_OBJECT_ID,
  getByEagleId,
  readForWriteByEagleId,
  readForWrite,
  listByIds,
  listRowsByIds,
  listIdsByName,
  NAME_MATCH_MAX_IDS,
  listByEagleIds,
  listDecisions,
  listWithCentroid,
  countWithCentroid,
  listEagleOnlyIds,
  countEagleOnlyIds,
  listWithEagleId,
  countWithEagleId,
  SORTABLE,
  sortFieldFills,
  upsert,
  patchCascadePending,
  patchWildfireStats,
  patchBoundaries,
  patchVis,
  listShortCodeOwners,
  patchShortLink,
  deleteById
};
