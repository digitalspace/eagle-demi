'use strict';

// Container `projects`, partitioned by `/id` (the Track id). Named methods, never a generic find(filter):
// that interface let a broken translator disable access control; each method owns SQL that cannot read unfiltered.

const cosmos = require('../db/cosmos-nosql');
const { canRead } = require('../helpers/access-sql');
const { logger } = require('../utils/logger');
const { duplicateIdError } = require('../helpers/duplicate-id');
const { eagleOnlyProjectId } = require('../merge/project');
const { dialAllows } = require('../helpers/dial');
const { levelOf } = require('../vis/level');
const { isDeepStrictEqual } = require('node:util');
const { deriveAssessments } = require('../merge/assessments');
const { legislationTransitions } = require('../merge/track-derived');
const { raced, writeGuarded } = require('../helpers/etag-write');
const { SORTABLE, sortFieldFills } = require('../helpers/project-fills');
const {
  eq, inList, isDefinedAndNotNull, selectWhere, selectFor, countWhere, pageOptions, fetchAll,
  upsertWithEtag, createItem, assertFilterable, readPage, EAGLE_SYNC_PENDING
} = require('./_sql');

const CONTAINER = 'projects';
const PARTITION_FIELD = 'id';

/** Every field a caller may narrow a project list by, and the SQL parameter each binds to. */
const CRITERIA_FIELDS = {
  regionalDistrict: '@rd',
  municipality: '@muni',
  electoralDistrict: '@ed'
};

/** Shared by list and count, so a count cannot size a set the caller cannot read; a hidden field throws, never drops. */
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

/** Point read by Track id, gated with canRead(): a point read skips the query predicate a list applies. */
async function getById(access, id) {
  const doc = await cosmos.readItem(CONTAINER, String(id), String(id));
  if (!doc) return null;
  return canRead(doc, access, PARTITION_FIELD) ? doc : null;
}

/** An Eagle ObjectId: DEMI ids are Track integers, `eagle-<ObjectId>` or UUIDs, so this shape is only Eagle's. */
const EAGLE_OBJECT_ID = /^[0-9a-f]{24}$/i;

const lowerId = (a, b) => (String(b.id) < String(a.id) ? b : a);

/** The row an Eagle id names: a non-twin over the `eagle-<id>` twin, then a Track source, then the lowest id. */
function pickByEagleId(rows, eagleId) {
  const twinId = eagleOnlyProjectId(String(eagleId));
  const found = (Array.isArray(rows) ? rows : []).filter(row => row && typeof row === 'object');
  const nonTwins = found.filter(row => row.id !== twinId);
  if (nonTwins.length === 0) return found[0] || null;
  const tracked = nonTwins.filter(row => row.sources && row.sources.track);
  return (tracked.length > 0 ? tracked : nonTwins).reduce(lowerId);
}

// Every row, drained (no `maxItemCount`): a page or `queryFirst` can stop at the twin while the Track row exists.
async function allByEagleId(spec) {
  const { items } = await cosmos.query(CONTAINER, spec, {});
  return items;
}

const eagleIdSpec = (eagleId) => {
  const { clause, params } = eq('eagleId', String(eagleId), '@eagleId');
  return { query: `SELECT * FROM c WHERE ${clause}`, parameters: params };
};

/** By Eagle ObjectId, under the caller's access. A Track row and its `eagle-<id>` twin answer the Track row. */
async function getByEagleId(access, eagleId) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [eq('eagleId', String(eagleId), '@eagleId')]
  });
  return pickByEagleId(await allByEagleId(spec), eagleId);
}

/** `getByEagleId` unfiltered: for reads that must see a private or sealed row. Never throws on a duplicate. */
async function readByEagleId(eagleId) {
  return pickByEagleId(await allByEagleId(eagleIdSpec(eagleId)), eagleId);
}

/** Stored row for an Eagle id, unfiltered, write side; a Track row beats its twin, any other pair throws DUPLICATE_ID. */
async function readForWriteByEagleId(eagleId) {
  const items = await allByEagleId(eagleIdSpec(eagleId));
  if (items.length <= 1) return items[0] || null;
  const tracked = items.filter(row => row.id !== eagleOnlyProjectId(String(eagleId)));
  if (tracked.length === 1) return tracked[0];
  throw duplicateIdError(CONTAINER, eagleId, items.map(row => row[PARTITION_FIELD]));
}

/** The stored row by DEMI id, unfiltered. Write side only, like every `readForWrite`. */
async function readForWrite(id) {
  return cosmos.readItem(CONTAINER, String(id), String(id));
}

/** `isNativeProject` (src/merge/project.js) in SQL: no Track source, not Eagle's own row or its `eagle-<id>` id. */
const NATIVE_PROJECT = '(NOT IS_DEFINED(c.sources.track) OR IS_NULL(c.sources.track)) AND ' +
  "(NOT IS_DEFINED(c.sourceSystem) OR IS_NULL(c.sourceSystem) OR c.sourceSystem != 'eagle') AND NOT STARTSWITH(c.id, 'eagle-')";

/** Every native row, unfiltered, for the seeder: it keeps these whole, and one it missed would be rebuilt from Track. */
async function listNative() {
  return fetchAll(CONTAINER, { query: `SELECT * FROM c WHERE ${NATIVE_PROJECT}`, parameters: [] });
}

// isDemiOwnedProject in SQL: a taken-over row with an Eagle id; an `eagle-<id>` twin without the marker stays out.
// `demiOwnedAt` is an ISO string or absent, so the string test matches the JS `hasValue`.
const DEMI_OWNED_EAGLE_PROJECT = 'IS_STRING(c.demiOwnedAt) AND c.demiOwnedAt != \'\' AND IS_STRING(c.eagleId) AND c.eagleId != \'\'';

/** Native and DEMI-owned Eagle rows whose `syncVersion` the sync-out has not sent; for `src/sync-out/pending.js`. */
async function listSyncPending() {
  return fetchAll(CONTAINER, {
    query: `SELECT * FROM c WHERE ((${NATIVE_PROJECT}) OR (${DEMI_OWNED_EAGLE_PROJECT})) AND ${EAGLE_SYNC_PENDING}`,
    parameters: []
  });
}

/** Names and Eagle ids for an id set, to label search hits; `eagleId` is the `project._id` eagle-api accepts. */
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

/** The most ids `listDialHiddenIds` answers. Past it, or on a drain cut short, the read throws: a cut list lets the rest through. */
const DIAL_HIDDEN_MAX_IDS = 500;
const DIAL_HIDDEN_OVER_CAP = 'DIAL_HIDDEN_OVER_CAP';

/** Ids of the projects this caller may see whose own dial hides any of `storedFields` from them. */
async function listDialHiddenIds(access, storedFields) {
  const fields = [...new Set(storedFields)];
  if (fields.length === 0) return [];
  const allowed = fields.map(field => dialAllows(field, levelOf(access))).join(' AND ');
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [{ clause: `NOT (${allowed})`, params: [] }],
    select: 'VALUE c.id'
  });
  const ids = await cosmos.queryPage(CONTAINER, spec, { size: DIAL_HIDDEN_MAX_IDS + 1, whole: true });
  if (!ids || ids.length > DIAL_HIDDEN_MAX_IDS) {
    logger.error('[projects] dial-hidden ids past their cap or cut short', { fields, cap: DIAL_HIDDEN_MAX_IDS, cut: !ids });
    throw Object.assign(new Error('[projects] dial-hidden ids past their cap or cut short'), { code: DIAL_HIDDEN_OVER_CAP });
  }
  return ids.map(String);
}

/** `listByIds` by Eagle id in one `IN`, plus `address` and `vis`, so a per-row dial still hides it. */
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

/** Decisions dated no later than `now`, newest first, for the home feed; a dial hiding `decisionDate` drops the row. */
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
    select: 'c.id, c.eagleId, c.isDeleted, c.demiOwnedAt'
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
    select: 'c.id, c.eagleId, c.sourceSystem, c.read, c.isPublished, c.isDeleted, ' +
      'c.sources.eagle.isDeleted AS eagleDeleted, c.cascadePendingAt'
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
async function patchVis(id, vis, { inputsFor } = {}) {
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
    const inputs = inputsFor ? await inputsFor(row) : {};
    const derived = deriveAssessments({ ...row, vis: nextVis }, { previous: row.assessments, ...inputs });
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

const DERIVED_FIELDS = ['legislationTransitions', 'assessments', 'phaseIds', 'activeWork'];

// In mergeTrackProject's order: transitions first, since assessments read their dates. JSON form, as Cosmos stores it.
function derivedOf(row, { worksForDerive, catalog } = {}) {
  const works = worksForDerive ?? row.works;
  const transitions = Array.isArray(works)
    ? legislationTransitions(row.legislationYearList, works) : row.legislationTransitions;
  const next = { ...row, legislationTransitions: transitions };
  return JSON.parse(JSON.stringify({ legislationTransitions: transitions,
    ...deriveAssessments(next, { previous: row.assessments, worksForDerive, catalog }) }));
}

/**
 * Re-derive the Track-built fields and patch only those that moved, under the row etag; inputs reload on each try.
 * Resolves `{status}`: `patched`, `unchanged` (no write), `missing` (no row) or `conflict` (every try lost).
 */
async function patchDerived(id, { inputsFor } = {}) {
  const key = String(id);
  const read = () => cosmos.readItem(CONTAINER, key, key);
  return writeGuarded({
    existing: await read(),
    reread: read,
    attempt: async (row) => {
      if (!row) return { status: 'missing' };
      const derived = derivedOf(row, inputsFor ? await inputsFor(row) : {});
      const ops = DERIVED_FIELDS.filter(field => !isDeepStrictEqual(derived[field], row[field]))
        .map(field => ({ op: 'set', path: `/${field}`, value: derived[field] }));
      if (!ops.length) return { status: 'unchanged' };
      await cosmos.patch(CONTAINER, key, key, ops, undefined, row._etag);
      return { status: 'patched' };
    }
  });
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
  readByEagleId,
  pickByEagleId,
  readForWriteByEagleId,
  readForWrite,
  listSyncPending,
  listNative,
  listByIds,
  listRowsByIds,
  listIdsByName,
  NAME_MATCH_MAX_IDS,
  listDialHiddenIds,
  DIAL_HIDDEN_MAX_IDS,
  DIAL_HIDDEN_OVER_CAP,
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
  patchDerived,
  listShortCodeOwners,
  patchShortLink,
  deleteById
};
