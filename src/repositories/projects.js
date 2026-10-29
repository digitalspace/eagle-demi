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
 * Criteria shared by list and count so the two can never diverge — a count built from a
 * different predicate would leak the size of a set the caller cannot read.
 *
 * REJECTED, NOT DROPPED, for a field this caller cannot see: a narrowed count answers what the
 * hidden value is. All three are `defaultVis: 4` today, so nothing reaches the throw.
 */
function buildCriteria(opts, access) {
  return Object.entries(CRITERIA_FIELDS)
    .filter(([field]) => opts[field])
    .map(([field, param]) => {
      assertFilterable(CONTAINER, field, access);
      return eq(field, opts[field], param);
    });
}

/**
 * Projects visible to this caller, by name.
 * ORDER BY c.name requires /name to be indexed — it is, in the container's indexing policy.
 * Without the index Cosmos rejects the sort outright rather than degrading.
 */
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

  // `queryFirst`, not a single page: one page of a cross-partition lookup legitimately comes back
  // empty while the row exists, because Cosmos answers with whatever the partitions it reached
  // within the page budget held. Reading only that page reports a live project as absent, and the
  // seeder then creates a duplicate.
  return await cosmos.queryFirst(CONTAINER, spec, {});
}

/**
 * The stored row for an Eagle id, unfiltered: a mirror asks whether it exists, not who may read
 * it. Write side only, like every `readForWrite`.
 *
 * A Track row beside its `eagle-<id>` twin is expected (the Track relink keeps the twin), so the
 * Track row wins; any other pair is refused.
 *
 * @throws an error with `code === DUPLICATE_ID` when two rows of the same kind share the eagleId
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
 * CommentPeriod keyword search matched `project.name` the same way.
 */
async function listIdsByName(access, text) {
  assertFilterable(CONTAINER, 'name', access);
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [{ clause: 'CONTAINS(c.name, @name, true)', params: [{ name: '@name', value: String(text) }] }],
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
 * `listByIds` keyed the other way round: by EAGLE project id, in one query. Adds `address` (the
 * update hit's `project.location`) and `vis`, so a per-row dial still hides it.
 *
 * `updates.projectId` holds the Eagle id, so labelling a page of updates cannot go through
 * `listByIds`. One `IN` over `eagleId` rather than a `getByEagleId` per row — a page of 200 updates
 * about 200 projects was 200 cross-partition reads.
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
 * Projects carrying a decision dated no later than `now`, newest first, at most `limit`: the home
 * feed's project decision rows. `/decisionDate/?` is an indexed path, so Cosmos sorts. A row whose
 * own dial hides `decisionDate` from this caller is left out, so the order cannot reveal it.
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
 * `{id, eagleId, sourceSystem, read, isPublished}` for every project mirroring an Eagle record — the reconcile's
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
 * Keys a native project list can sort on. Cosmos drops a row that lacks the ORDER BY field, so
 * `upsert` writes every one of them (`sortFieldFills`), as null when there is nothing to store.
 * `eacDecisionSort` stands in for `eacDecision.name`: filling `eacDecision` itself would turn "no
 * decision" into an object that readers render as a decision.
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
 * The writes that give a row every SORTABLE field. A field the row holds, null included, is left
 * alone, except two: `currentPhaseName` must be a ref holding `name` (Track sends no phase, Eagle
 * may send null or a bare id), and `eacDecisionSort`, a copy, is rewritten when stale.
 * `dateUpdated` falls back to `dateAdded`, never `_ts`.
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
 * Whole-item write. Safe only because nothing is folded into the project as an embedded array
 * any more — a replace from the Track sync would silently discard it. Use the patch helpers
 * below for partial updates.
 *
 * `etag` makes it optimistic: the write lands only while the row is still the revision the caller
 * read, and a loser gets a 412 instead of replacing the winner. Two eagle-api pushes for one
 * project 34 ms apart both read `isPublished: false` and the stale one landed last, leaving a
 * published project private in DEMI with no cascade — that is what the guard is for.
 *
 * @param {object} project
 * @param {{etag?: string, create?: boolean}} [options] `etag` is the `_etag` the caller read off
 *   the row; `create` inserts a row the caller read as absent
 * @throws an error with `code === 412` when the row moved, or `409` when it was created behind
 *   this caller
 */
async function upsert(project, { etag, create = false } = {}) {
  // A row the caller read as ABSENT has no revision to guard on, so the insert is the guard: an
  // unguarded upsert would replace a project another writer created in between, and Cosmos answers
  // a create with 409 instead — which callers re-read and re-judge exactly as they do a 412.
  const row = { ...project, ...sortFieldFills(project) };
  if (create) return createItem(CONTAINER, row, 'projects');
  return upsertWithEtag(CONTAINER, row, { etag, label: 'projects' });
}

/**
 * Record, or clear, that a visibility cascade this project owes has not run.
 *
 * `patch`, never `upsert`: the row has already been written by the time a cascade fails, and a
 * whole-item write here would replace whatever landed since. Guarded on the revision the caller
 * read, so it cannot stamp a row a later push has already moved past.
 *
 * @param {string} id
 * @param {string|null} pendingAt an ISO timestamp, or null to clear the marker
 * @param {string} [etag] the `_etag` the caller read off the row
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
 * Ids of every project holding `code`, current or legacy. Unfiltered, not systemAccess: that still
 * hides sealed (`compliance`) rows and rows with no `read[]`, and both hold their codes all the same.
 * Ids only; the link controller answers 409 without an id for a holder the caller cannot read;
 * other callers use the ids internally.
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
