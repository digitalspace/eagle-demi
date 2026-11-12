'use strict';

/**
 * Cosmos container `documents`, partitioned by `/projectId` so a project's list is one partition.
 * A read by id alone is cross-partition but returns one item: a few RU, not a scan.
 */

const cosmos = require('../db/cosmos-nosql');
const {
  canRead, readForLevel, levelOfRead, capRead, systemAccess, SEALED_TOKEN
} = require('../helpers/access-sql');
const {
  eq, inList, isDefinedAndNotNull, selectWhere, selectFor, countWhere, pageOptions, fetchAll,
  upsertWithEtag, createItem, readForWriteIn, NOT_DELETED, EAGLE_SYNC_PENDING, upsertItem, oneRowOf
} = require('./_sql');
// The fields the chunks carry a copy of, read from the one list that owns them.
const { CHUNK_PARENT_FIELDS } = require('./chunks');
const { eagleReadUnder } = require('../helpers/eagle-acl');

const CONTAINER = 'documents';
const PARTITION_FIELD = 'projectId';

const { EXTRACTION_FIELDS, DEMI_OWNED_FIELDS } = require('../ownership/document');

/**
 * The "chunks missed the new parent fields" flag and its raise token. A re-seed or Eagle push that
 * rebuilds the row must carry both, or the missed re-stamp goes unseen.
 */
const PARENT_PENDING_FIELDS = ['parentFieldsPending', 'parentFieldsPendingAt'];

/**
 * The requested projects as a list. Presence, not truthiness: `''` is a real partition. One option
 * for one or many ids, so the count and the read cannot be built from different ones.
 */
function projectIdList(projectId) {
  if (projectId === undefined || projectId === null) return [];
  return (Array.isArray(projectId) ? projectId : [projectId]).map(String);
}

/**
 * Update-form images (`documentSource: 'UPDATE'`) show on their Update only, never in a list. A
 * missing `documentSource` is undefined in Cosmos SQL and would drop the row, so test strings only.
 */
const UPDATE_SOURCE = 'UPDATE';

function notUpdateImage() {
  return {
    clause: '(NOT IS_STRING(c.documentSource) OR c.documentSource != @updateSource)',
    params: [{ name: '@updateSource', value: UPDATE_SOURCE }]
  };
}

/**
 * Leaves out uploads intake has not released; rows that never went through intake stay in. A literal,
 * not a parameter: demi-documents-ds.json repeats this exact text and takes no parameters.
 */
const SCAN_CLEARED_CLAUSE = "(NOT IS_STRING(c.scanStatus) OR c.scanStatus = 'clean')";

function scanCleared() {
  return { clause: SCAN_CLEARED_CLAUSE, params: [] };
}

/** The JS twin of SCAN_CLEARED_CLAUSE, for a row already read. */
function isScanCleared(row) {
  return Boolean(row) && (typeof row.scanStatus !== 'string' || row.scanStatus === 'clean');
}

function buildCriteria({ projectId, extracted, sourceSystem, extractionError, hasProjectId,
  parentFieldsPending, withoutUpdateImages }) {
  const criteria = [scanCleared()];
  const projectIds = projectIdList(projectId);
  if (projectIds.length === 1) criteria.push(eq('projectId', projectIds[0], '@projectId'));
  else if (projectIds.length > 1) criteria.push(inList('projectId', projectIds, '@projectId'));
  if (sourceSystem) criteria.push(eq('sourceSystem', sourceSystem, '@sourceSystem'));

  // Null and absent `projectId` are two partitions `listDistinctProjectIds` skips, walked together,
  // so these two predicates must stay complements. `''` is a real partition, on the `true` side.
  if (hasProjectId === true) criteria.push(isDefinedAndNotNull('projectId'));
  if (hasProjectId === false) {
    const defined = isDefinedAndNotNull('projectId');
    criteria.push({ clause: `NOT ${defined.clause}`, params: defined.params });
  }

  // Set when the re-stamp could not be queued or was skipped, cleared when one lands. An
  // undefined property never equals `true` in Cosmos SQL, so unflagged rows need no IS_DEFINED.
  if (parentFieldsPending === true) criteria.push(eq('parentFieldsPending', true, '@pending'));

  // Every document carries the field, so plain equality. A SQL `!= true` would drop rows missing
  // the field, silently skipping them.
  if (extracted === true) criteria.push(eq('contentExtracted', true, '@extracted'));
  if (extracted === false) criteria.push(eq('contentExtracted', false, '@extracted'));

  // NOT IS_NULL carries this: a successful extraction writes the field back as an explicit null.
  if (extractionError === true) criteria.push(isDefinedAndNotNull('contentExtractionError'));

  // Opt-in, not default: the backfills and purges walk every row, Update images included.
  if (withoutUpdateImages === true) criteria.push(notUpdateImage());

  return criteria;
}

/**
 * The one partition to pin to, else `undefined` (fan out). `''` and null (`[null]`) are real
 * partitions; a row with no `projectId` at all is `PartitionKey.None` (`[{}]`), a different one.
 */
function partitionKeyFor(projectId) {
  // Before `projectIdList`, which drops null along with undefined — the distinction this makes is
  // the whole point, and `String(null)` would give the partition `'null'`, where nothing lives.
  if (projectId === null) return null;
  const ids = projectIdList(projectId);
  return ids.length === 1 ? ids[0] : undefined;
}

/**
 * Documents visible to this caller. ORDER BY `c.id`: the search controller pages by re-running and
 * slicing, and `id` is never missing, while a single-property ORDER BY drops rows that lack it.
 */
async function listVisible(access, opts = {}) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: buildCriteria(opts),
    // getById keeps the raw point read: canRead needs the whole row, downloadDocument reads
    // `s3Key` off it, and the controllers upsert what they read.
    select: selectFor('documents', access, PARTITION_FIELD),
    orderBy: 'c.id ASC'
  });

  const options = pageOptions({
    ...opts,
    partitionKey: partitionKeyFor(opts.projectId)
  });

  return cosmos.query(CONTAINER, spec, options);
}

/**
 * Newest `dateUploaded` per readable project. GROUP BY, not a TOP window: one Eagle bulk push gives
 * hundreds of rows one date. Needs `/dateUploaded/?` indexed; the caller sorts (no ORDER BY allowed).
 */
async function projectUploadMaxima(access) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [isDefinedAndNotNull('dateUploaded'), notUpdateImage(), scanCleared()],
    select: 'c.projectId, MAX(c.dateUploaded) AS dateUploaded',
    groupBy: 'c.projectId'
  });

  return fetchAll(CONTAINER, spec);
}

/** How many documents of a project the recent-uploads panel lists when a row is expanded. */
const RECENT_UPLOAD_DOCUMENTS = 5;

/**
 * Newest dated documents of one project, for its panel row. Single-partition and TOP-bounded, so one
 * shot. Cosmos does not order ties on the sort key; the caller breaks them.
 */
async function newestUploads(access, projectId) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [
      eq('projectId', String(projectId), '@projectId'),
      isDefinedAndNotNull('dateUploaded'),
      notUpdateImage(),
      scanCleared()
    ],
    select: `TOP ${RECENT_UPLOAD_DOCUMENTS} ${selectFor('documents', access, PARTITION_FIELD)}`,
    orderBy: 'c.dateUploaded DESC'
  });

  const { items } = await cosmos.query(CONTAINER, spec,
    pageOptions({ partitionKey: partitionKeyFor(projectId) }));
  return items;
}

/**
 * DEMI seals only: level 0 plus `sealedAt` (an Eagle-sealed row heals on its next push). Visibility
 * still applies, so no `compliance` gets nothing; `SEALED_TOKEN` is our own literal, safe inline.
 */
async function listSealed(access, opts = {}) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [{ clause: `ARRAY_CONTAINS(c.read, '${SEALED_TOKEN}') AND IS_STRING(c.sealedAt)`, params: [] }],
    select: 'c.id, c.projectId, c.sealedAt, c.displayName',
    orderBy: 'c.id ASC'
  });

  return cosmos.query(CONTAINER, spec, pageOptions(opts));
}

async function countVisible(access, opts = {}) {
  const spec = countWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: buildCriteria(opts)
  });
  // The partition key only, so the count pins what the read pins; page size and continuation mean
  // nothing for a one-row aggregate.
  const value = await cosmos.queryValue(CONTAINER, spec, pageOptions({
    partitionKey: partitionKeyFor(opts.projectId)
  }));
  return value || 0;
}

/** Featured documents in a project other than `exceptId`, at every level (domain/document-feature.js). */
async function countFeatured(projectId, { exceptId } = {}) {
  const criteria = [...buildCriteria({ projectId }), eq('isFeatured', true, '@featured'), NOT_DELETED];
  if (exceptId !== undefined) {
    criteria.push({ clause: 'c.id != @exceptId', params: [{ name: '@exceptId', value: String(exceptId) }] });
  }
  const spec = countWhere({ access: systemAccess(), partitionField: PARTITION_FIELD, criteria });
  const value = await cosmos.queryValue(CONTAINER, spec, pageOptions({ partitionKey: partitionKeyFor(projectId) }));
  return value || 0;
}

/**
 * Fetch by id, visibility applied in the query so a hidden row never reaches this process. Unreleased
 * uploads are skipped; `includeUnscanned` is for intake paths only, never a general read.
 */
async function getById(access, id, projectId, { includeUnscanned = false } = {}) {
  // Same helper as the reads: `''` is a real partition and must get the point read.
  const partitionKey = partitionKeyFor(projectId);
  if (partitionKey !== undefined) {
    const doc = await cosmos.readItem(CONTAINER, String(id), partitionKey);
    if (!doc) return null;
    if (!includeUnscanned && !isScanCleared(doc)) return null;
    return canRead(doc, access, PARTITION_FIELD) ? doc : null;
  }

  const criteria = [eq('id', String(id), '@id')];
  if (!includeUnscanned) criteria.push(scanCleared());
  const spec = selectWhere({ access, partitionField: PARTITION_FIELD, criteria });
  // Drain every page: a cross-partition page comes back empty when the partitions it reached first
  // lack the id, and reading only that page reports a live document as deleted.
  return await cosmos.queryFirst(CONTAINER, spec, {});
}

/**
 * The stored row, unfiltered, for the Eagle mirror's existence check: a sealed or read-less row
 * must be found, or the push creates over it and loses every etag race. Never a response.
 */
async function readForWrite(id, projectId) {
  return readForWriteIn(CONTAINER, id, projectId, PARTITION_FIELD);
}

/**
 * The stored row whose `eagleId` names this id, unfiltered like `readForWrite`: in the partition first,
 * then across partitions. Throws `DUPLICATE_ID` when two rows name it.
 */
async function readForWriteByEagleId(eagleId, projectId) {
  const { clause, params } = eq('eagleId', String(eagleId), '@eagleId');
  // Only DEMI-owned rows carry a foreign eagleId; the filter lets the indexed path narrow the scan.
  const spec = { query: `SELECT * FROM c WHERE ${clause} AND c.sourceSystem = 'demi'`, parameters: params };
  if (projectId != null) {
    const { items } = await cosmos.query(CONTAINER, spec, { partitionKey: String(projectId) });
    if (items.length) return oneRowOf(CONTAINER, eagleId, items, PARTITION_FIELD);
  }
  const { items } = await cosmos.query(CONTAINER, spec);
  return oneRowOf(CONTAINER, eagleId, items, PARTITION_FIELD);
}

/** Drop a moved row's owed-delete marker once the old partition's copy is gone. */
async function clearMovedFrom(id, projectId) {
  return cosmos.patch(CONTAINER, String(id), String(projectId), [
    { op: 'remove', path: '/movedFromProjectId' },
    { op: 'remove', path: '/movedFromEtag' }
  ]);
}

/** The row as stored in one partition, with no ACL check. For write paths only. */
async function readStored(id, projectId) {
  return cosmos.readItem(CONTAINER, String(id), String(projectId));
}

/**
 * The chunk card's display fields for a bounded id set, in the hits' partitions only. `milestone` is
 * the label: the card binds it raw, so the id alone would put a GUID on screen.
 */
async function listByIds(access, ids, projectIds) {
  const unique = Array.from(new Set((ids || []).map(String)));
  const projects = Array.from(new Set((projectIds || []).map(String)));
  if (unique.length === 0) return [];

  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [
      inList('id', unique, '@did'),
      inList(PARTITION_FIELD, projects, '@dpid'),
      // This read is the chunk gate: an Update image's chunk, if one was ever made, stays out.
      notUpdateImage(),
      scanCleared()
    ],
    select: 'c.id, c.displayName, c.documentFileName, c.type, c.milestone, c.milestoneId, c.datePosted'
  });

  const { items } = await cosmos.query(CONTAINER, spec, {});
  return items;
}

/**
 * Every document in one project with what the ACL cascade needs. `isDeleted`: a row Eagle deleted
 * keeps a `public` snapshot. `sourceSystem` picks the Eagle rule for Eagle mirrors.
 */
async function aclRowsForProject(access, projectId) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [eq('projectId', String(projectId), '@projectId')],
    select: 'c.id, c.read, c.ownRead, c.isDeleted, c.sourceSystem'
  });
  const { items } = await cosmos.query(CONTAINER, spec, { partitionKey: String(projectId) });
  return items;
}

/**
 * The document's ACL capped at its project's ladder level, never widened. A missing project ACL
 * reads as level 1 (fail closed); a read with no ladder token is kept as it is.
 */
function constrainToProject(ownRead, projectRead) {
  return capRead(ownRead, projectRead);
}

/**
 * The widest level a row Eagle deleted may hold: staff, as a takedown. Stated once here for
 * `helpers/acl-cascade` and both Eagle mirrors.
 */
const DELETED_CEILING = readForLevel(2);

/**
 * `levelHeldAt` after a DEMI level move: a stamp on a narrow, `null` once a widen reaches level 4 or
 * Eagle's level (null = unknown), else `undefined` (keep). While held, an Eagle push may only lower.
 */
function levelHoldAfter(row, to, eagleLevel) {
  const from = levelOfRead(row && row.read);
  if (to < from) return new Date().toISOString();
  if (!row || !row.levelHeldAt || to === from) return undefined;
  return to === 4 || (eagleLevel !== null && to >= eagleLevel) ? null : undefined;
}

/** An Eagle push's document row, capped at the stored level while DEMI holds it. Lower wins. */
function holdLevel(row, stored) {
  if (!row || !row.levelHeldAt || !stored) return row;
  row.read = capRead(row.read, stored.read);
  // Every project cascade re-derives `read` from `ownRead`, so an uncapped one republishes the row.
  if (Array.isArray(stored.ownRead) && stored.ownRead.length > 0) {
    row.ownRead = capRead(row.ownRead, stored.ownRead);
  }
  row.isPublished = row.read.includes('public');
  return row;
}

/**
 * Cap every document's own ACL (`ownRead`, captured from `read` when missing) at its project's, so a
 * document never out-ranks its project. Narrows, never assigns; one bulk PATCH, no read-back.
 *
 * @param {string[]} read  the project's new ACL
 * @returns {Promise<object>} the bulk result, plus touched `ids` and each row's derived `{id, read, isPublished}`
 */
async function setAclForProject(access, projectId, read) {
  if (!Array.isArray(read) || read.length === 0) {
    throw new TypeError('[documents] setAclForProject requires a non-empty read[] ACL');
  }

  const rows = await aclRowsForProject(access, projectId);
  if (rows.length === 0) {
    return { succeeded: 0, failed: 0, statusCounts: {}, requestCharge: 0, ids: [], rows: [] };
  }

  const pk = String(projectId);
  const updatedAt = new Date().toISOString();
  // Each row's derived ACL, kept so the caller can write the same values into the search index
  // without re-deriving the rule a second way.
  const derived = [];
  const result = await cosmos.bulkVerified(CONTAINER, rows.map(row => {
    // No snapshot: on a first cascade `read` is the row's own ACL. No `read` either: `[]`, since
    // Cosmos rejects a valueless `set` and the failed patch would leave the old, wider ACL.
    const own = Array.isArray(row.ownRead) && row.ownRead.length > 0 ? row.ownRead
      : (Array.isArray(row.read) ? row.read : []);
    // An Eagle mirror's `ownRead` goes through the Eagle rule, so a captured `compliance` is not
    // kept. A DEMI-native row, or an empty `own`, keeps the plain cap so neither is widened.
    const capped = row.sourceSystem === 'eagle' && own.length > 0
      ? eagleReadUnder(own, read)
      : constrainToProject(own, read);
    // Both ceilings, lower wins: the project's, and level 2 once Eagle has deleted the record —
    // without the second, the next project publish would republish a document Eagle deleted.
    const next = row.isDeleted === true ? constrainToProject(capped, DELETED_CEILING) : capped;
    derived.push({ id: String(row.id), read: next, isPublished: next.includes('public') });
    return {
      operationType: 'Patch',
      partitionKey: pk,
      id: String(row.id),
      resourceBody: {
        operations: [
          { op: 'set', path: '/ownRead', value: own },
          { op: 'set', path: '/read', value: next },
          { op: 'set', path: '/isPublished', value: next.includes('public') },
          { op: 'set', path: '/updatedAt', value: updatedAt }
        ]
      }
    };
  }));

  return { ...result, ids: derived.map(row => row.id), rows: derived };
}

/**
 * DEMI-owned fields, chunk parent fields and the pending flag of one partition. An upsert replaces the
 * item, so the seeder carries these forward and spots a parent field the re-seed moved.
 */
async function extractionRowsForProject(access, projectId) {
  // `read` and `ownRead`: `holdLevel` caps a held row at them, and reads a missing one as level 1.
  return projectedRowsForProject(access, projectId,
    [...DEMI_OWNED_FIELDS, ...CHUNK_PARENT_FIELDS, ...PARENT_PENDING_FIELDS, 'read', 'ownRead']);
}

/**
 * `c.id`, `c._etag` and the named columns. `_etag` rides along so a caller that decides something
 * from these values can write it back conditionally and lose the race rather than overwrite it.
 */
function projectedSelect(fields) {
  return ['c.id', 'c._etag', ...fields.map(f => `c.${f}`)].join(', ');
}

/** One partition, `c.id` plus the named columns and nothing else. Paged, ordered by id. */
async function projectedRowsForProject(access, projectId, fields) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [eq('projectId', String(projectId), '@projectId')],
    select: projectedSelect(fields),
    orderBy: 'c.id ASC'
  });
  return fetchAll(CONTAINER, spec, { partitionKey: String(projectId) });
}

/** The reconcile predicate, shared so the enumeration and its COUNT cannot drift apart. */
const seededCriteria = () => [eq('sourceSystem', 'eagle', '@sourceSystem')];

/**
 * Every Eagle-seeded document, the reconcile set; Eagle only, so a DEMI upload is never purged. No
 * ORDER BY: the SDK's cross-partition sort drops `x-ms-continuation` and fetchAll stops at 1,000.
 */
async function listSeededIds(access) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: seededCriteria(),
    select: 'c.id, c.projectId, c.read, c.isPublished, c.pdfTitle'
  });
  return fetchAll(CONTAINER, spec);
}

/** COUNT of exactly what listSeededIds reads — the reconcile's proof that it ran to the end. */
async function countSeededIds(access) {
  const spec = countWhere({ access, partitionField: PARTITION_FIELD, criteria: seededCriteria() });
  const value = await cosmos.queryValue(CONTAINER, spec);
  return value || 0;
}

/**
 * Partitions as the documents name them (an Eagle-only project may have no project row). No ORDER BY:
 * cross-partition DISTINCT rejects it. Null `projectId` is left out, never folded into `''`.
 */
async function listDistinctProjectIds(access) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: buildCriteria({ hasProjectId: true }),
    select: 'DISTINCT VALUE c.projectId'
  });
  return fetchAll(CONTAINER, spec);
}

/**
 * Rows with null or absent `projectId`: two partitions read as one union, so cross-partition. A walk
 * that skips them leaves their chunks unstamped. No ORDER BY, same trap as `listSeededIds`.
 */
async function projectedRowsWithNoProject(access, fields) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: buildCriteria({ hasProjectId: false }),
    select: projectedSelect(fields)
  });
  return fetchAll(CONTAINER, spec);
}

/**
 * Chunk parent fields and the pending pair of one partition, projected for the backfill walk. The
 * pair rides this read because the walk clears on its token, and a second read could race a write.
 */
async function parentFieldRowsForProject(access, projectId) {
  return projectedRowsForProject(access, projectId,
    [...CHUNK_PARENT_FIELDS, ...PARENT_PENDING_FIELDS]);
}

/** The same columns for the no-project bucket. */
async function parentFieldRowsWithNoProject(access) {
  return projectedRowsWithNoProject(access, [...CHUNK_PARENT_FIELDS, ...PARENT_PENDING_FIELDS]);
}

/** `{id, projectId, displayName, displayNameSort}` for that bucket — the sort-key backfill's walk. */
async function displayNameRowsWithNoProject(access) {
  return projectedRowsWithNoProject(access, ['projectId', 'displayName', 'displayNameSort']);
}

/**
 * Every document flagged `parentFieldsPending`, `{id, projectId}` only. Cross-partition on
 * purpose: which partitions they sit in is what is not known in advance, and the set is small.
 */
async function listParentFieldsPending(access) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: buildCriteria({ parentFieldsPending: true }),
    select: 'c.id, c.projectId'
  });
  return fetchAll(CONTAINER, spec);
}

/** COUNT of exactly what `listParentFieldsPending` reads — the number the drift alert matches on. */
async function countParentFieldsPending(access) {
  const spec = countWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: buildCriteria({ parentFieldsPending: true })
  });
  const value = await cosmos.queryValue(CONTAINER, spec);
  return value || 0;
}

/** `toISOString` output only: a patch condition is a raw string with no parameter binding, so
 * only a token this repository minted may go in. */
const PENDING_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Mint a `parentFieldsPendingAt` token strictly later than the row's, so a clear guarded on the old
 * token cannot take a newer flag down. Shared with writers that raise the flag inline.
 *
 * @param {string} [existingPendingAt] the row's current value, if it has one
 * @returns {string} ISO-8601 instant, strictly later than `existingPendingAt`
 */
function freshPendingAt(existingPendingAt) {
  const existing = Date.parse(existingPendingAt);
  const now = Date.now();
  return new Date(Number.isNaN(existing) ? now : Math.max(now, existing + 1)).toISOString();
}

/**
 * The flag pair for a writer raising it inline on its own upsert, which cannot carry the raise
 * condition: pass the row's `_etag` to `upsert(row, { etag })` and handle the 412.
 *
 * @param {string} [existingPendingAt] the row's current value, if it has one
 */
function pendingRaiseOps(existingPendingAt) {
  return {
    parentFieldsPending: true,
    parentFieldsPendingAt: freshPendingAt(existingPendingAt)
  };
}

/** The only shape allowed into a patch condition, guard token or minted token alike. */
function assertPendingToken(token) {
  if (!PENDING_AT_PATTERN.test(token)) {
    throw new TypeError(`[documents] parentFieldsPendingAt is not an ISO instant: ${token}`);
  }
  return token;
}

/**
 * Test-and-set: write the token only while no stored token beats it. `NOT IS_STRING`: a clear stores
 * null, and `null < "..."` is undefined in Cosmos SQL, so `NOT IS_DEFINED` would 412 every raise.
 */
function raiseCondition(token) {
  return 'FROM c WHERE NOT IS_STRING(c.parentFieldsPendingAt) ' +
    `OR c.parentFieldsPendingAt < ${JSON.stringify(assertPendingToken(token))}`;
}

/**
 * Raise attempts against concurrent raisers. A bound, not a tuning knob: losing more means something
 * raises in a loop, and a throw beats a flag whose token nobody owns.
 */
const RAISE_MAX_TRIES = 3;

/**
 * Raise or clear the "chunks missed the new parent fields" flag, in the row's own partition (null
 * stays null). A clear guards on the token, not the etag, which any unrelated write changes.
 *
 * @param {{pendingAt: string}} [guard] clear only; absent = unconditional, mismatch = `conflict`
 * @returns {Promise<{status: string, pendingAt?: string|null, reason?: string}>} `raised`, `cleared`, `conflict`, or `missing` (`reason` `lookup` or `patch`)
 * @throws when a raise loses `RAISE_MAX_TRIES` races, since the stored token is then unknown
 */
async function setParentFieldsPending(id, projectId, pending, guard) {
  if (guard !== undefined && (typeof guard !== 'object' || guard === null)) {
    throw new TypeError(`[documents] parentFieldsPending guard must be an object: ${guard}`);
  }

  let partitionKey = partitionKeyFor(projectId);
  let row = null;
  if (partitionKey === undefined) {
    row = await getById(systemAccess(), id);
    if (!row) return { status: 'missing', reason: 'lookup' };
    partitionKey = row.projectId;
  }

  return pending === true
    ? raisePending(id, partitionKey, row)
    : clearPending(id, partitionKey, guard);
}

/** Test-and-set the flag, re-minting off the stored token each time a concurrent raiser wins. */
async function raisePending(id, partitionKey, known) {
  // The stored value is what the new token has to beat, so a raise on a pinned partition still
  // costs the point read the lookup above skipped.
  let row = known;

  for (let attempt = 1; attempt <= RAISE_MAX_TRIES; attempt++) {
    if (!row) row = await cosmos.readItem(CONTAINER, String(id), partitionKey);
    const { parentFieldsPending, parentFieldsPendingAt } =
      pendingRaiseOps(row && row.parentFieldsPendingAt);

    try {
      await cosmos.patch(CONTAINER, String(id), partitionKey, [
        { op: 'set', path: '/parentFieldsPending', value: parentFieldsPending },
        { op: 'set', path: '/parentFieldsPendingAt', value: parentFieldsPendingAt }
      ], raiseCondition(parentFieldsPendingAt));
      return { status: 'raised', pendingAt: parentFieldsPendingAt };
    } catch (err) {
      if (err.code === 404) return { status: 'missing', reason: 'patch' };
      if (err.code !== 412) throw err;
      // Somebody else's token is on the row now. Drop the stale copy so the next mint beats THAT.
      row = null;
    }
  }

  throw new Error(
    `[documents] parentFieldsPending raise for ${id} lost ${RAISE_MAX_TRIES} races; ` +
    'the stored token is not this run\'s and clearing on one would take another raise down');
}

/** Write the flag down, optionally only while the row still carries the token it was raised with. */
async function clearPending(id, partitionKey, guard) {
  const token = guard ? guard.pendingAt : undefined;
  const condition = token === undefined
    ? undefined
    : `FROM c WHERE c.parentFieldsPendingAt = ${JSON.stringify(assertPendingToken(token))}`;

  try {
    await cosmos.patch(CONTAINER, String(id), partitionKey, [
      { op: 'set', path: '/parentFieldsPending', value: false },
      { op: 'set', path: '/parentFieldsPendingAt', value: null }
    ], condition);
  } catch (err) {
    if (err.code === 404) return { status: 'missing', reason: 'patch' };
    if (err.code !== 412 || condition === undefined) throw err;
    return { status: 'conflict', pendingAt: token };
  }

  return { status: 'cleared', pendingAt: null };
}

/**
 * Whole-item write. `etag` makes it optimistic: a loser gets a 412 instead of overwriting the winner.
 *
 * @param {object} document
 * @param {{etag?: string}} [options] `etag` is the `_etag` the caller read off the row
 * @throws an error with `code === 412` when the row moved under the caller
 */
async function upsert(document, { etag, create = false } = {}) {
  // A row read as absent has no etag, so the insert is the guard: a racing create gets a 409,
  // which callers re-read and re-judge like a 412.
  if (create) return createItem(CONTAINER, document, 'documents');
  return upsertWithEtag(CONTAINER, document, { etag, label: 'documents' });
}

/**
 * Bulk write for the seeder. All documents must belong to the SAME project, since that is the
 * partition key — the seeder groups by project before calling this.
 */
async function bulkUpsertForProject(projectId, docs) {
  const operations = docs.map(resourceBody => ({
    operationType: 'Upsert',
    partitionKey: String(projectId),
    resourceBody
  }));
  return cosmos.bulkVerified(CONTAINER, operations);
}

/**
 * Record the outcome of an extraction run. Partial update: it must not disturb the ACL,
 * publication state or anything the seeders wrote.
 */
async function patchExtraction(id, projectId, fields) {
  const ops = Object.entries(fields).map(([key, value]) => ({
    op: 'set',
    path: `/${key}`,
    value
  }));
  return cosmos.patch(CONTAINER, String(id), String(projectId), ops);
}

/**
 * Move a document to a ladder level; this, not deletion, hides it. Only level 4 carries `public`,
 * and `isPublished` mirrors `read[]`.
 */
async function setPublished(id, projectId, level, { levelHeldAt, etag } = {}) {
  const read = readForLevel(level);
  // `undefined` leaves the stored hold alone; see `levelHoldAfter`.
  const hold = levelHeldAt === undefined ? [] : [{ op: 'set', path: '/levelHeldAt', value: levelHeldAt }];
  return cosmos.patch(CONTAINER, String(id), String(projectId), [
    ...hold,
    { op: 'set', path: '/isPublished', value: read.includes('public') },
    { op: 'set', path: '/read', value: read },
    // `ownRead` moves with it: this is the document's own ACL, and a stale snapshot would let the
    // next project re-publish resurrect a document an operator unpublished.
    { op: 'set', path: '/ownRead', value: read },
    { op: 'set', path: '/updatedAt', value: new Date().toISOString() }
  ], undefined, etag);
}

/**
 * Remove the record, never the stored blob: no request path may destroy a source file. The caller
 * removes the search entry, since the change feed emits no deletes in latest-version mode.
 */
async function deleteById(id, projectId, { etag } = {}) {
  return cosmos.remove(CONTAINER, String(id), String(projectId), { etag });
}

/**
 * What `listByIdsUnscoped` may project, an allowlist because the projection is SQL text: no `*`, no
 * smuggled clause. `vis` feeds `redactForAccess` on entry names, never the caller.
 */
const MANIFEST_FIELDS = [
  'id', 'projectId', 'fileSize', 'isPublished',
  'displayName', 'documentFileName', 's3Key', 'fileExt', 'mimeType', 'vis'
];

/**
 * Documents of a bounded id set with no project ids (a bulk download has none), so cross-partition;
 * the caller batches at 200 ids. Never pass a sealed compartment in `access`.
 *
 * @param {string} select comma-separated `c.<field>`, each field one of MANIFEST_FIELDS
 */
async function listByIdsUnscoped(access, ids, select) {
  const unique = Array.from(new Set((ids || []).map(String)));
  if (unique.length === 0) return [];

  const unknown = String(select).split(',')
    .map(field => field.trim().replace(/^c\./, ''))
    .filter(field => !MANIFEST_FIELDS.includes(field));
  if (unknown.length > 0) {
    throw new Error(`[documents] projection not allowed here: ${unknown.join(', ')}`);
  }

  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [inList('id', unique, '@bid'), scanCleared()],
    select
  });

  const { items } = await cosmos.query(CONTAINER, spec, {});
  return items;
}

/** What the document pending hook and `enqueue` read: `wants`, `inFlight` and the version check. */
const SYNC_PENDING_FIELDS = ['id', 'projectId', 'sourceSystem', 'eagleId', 'syncVersion', 'syncOut', 'scanStatus'];

/**
 * The sync-out pending hook's list, across partitions: DEMI rows holding a version not yet sent, and rows never
 * sent that are untied or tied to an id sync-out minted. Native writes raise no syncVersion.
 */
async function listSyncPending() {
  const tied = isDefinedAndNotNull('eagleId').clause;
  const select = SYNC_PENDING_FIELDS.map(field => `c.${field}`).join(', ');
  const neverSent = `(NOT IS_NUMBER(c.syncOut.eagle.sentVersion) AND (NOT ${tied} OR c.syncOut.eagle.mintedId = c.eagleId))`;
  return fetchAll(CONTAINER, {
    query: `SELECT ${select} FROM c WHERE c.sourceSystem = 'demi' AND (${neverSent} OR (${EAGLE_SYNC_PENDING}))`,
    parameters: []
  });
}

/** Stored rows of `ids` across partitions, unfiltered: what sync-out reads to name a document by its Eagle id. */
async function listSyncRefs(ids) {
  const unique = Array.from(new Set((ids || []).map(String)));
  if (unique.length === 0) return [];
  const { clause, params } = inList('id', unique, '@ref');
  const select = [...SYNC_PENDING_FIELDS, 'isDeleted'].map(field => `c.${field}`).join(', ');
  return fetchAll(CONTAINER, { query: `SELECT ${select} FROM c WHERE ${clause}`, parameters: params });
}

/** Sync-out's `repo.upsert(item, existing)`: guarded on the stored row's `_etag`, which `upsert` above never reads. */
async function upsertForSync(item, existing) {
  return upsertItem(CONTAINER, PARTITION_FIELD, item, existing);
}

module.exports = {
  CONTAINER,
  UPDATE_SOURCE,
  SCAN_CLEARED_CLAUSE,
  isScanCleared,
  PARTITION_FIELD,
  EXTRACTION_FIELDS,
  DEMI_OWNED_FIELDS,
  levelHoldAfter,
  holdLevel,
  PARENT_PENDING_FIELDS,
  MANIFEST_FIELDS,
  buildCriteria,
  listVisible,
  projectUploadMaxima,
  newestUploads,
  listSealed,
  countVisible,
  countFeatured,
  getById,
  readForWrite,
  readForWriteByEagleId,
  clearMovedFrom,
  readStored,
  listByIds,
  listByIdsUnscoped,
  aclRowsForProject,
  constrainToProject,
  DELETED_CEILING,
  setAclForProject,
  extractionRowsForProject,
  parentFieldRowsForProject,
  projectedRowsForProject,
  parentFieldRowsWithNoProject,
  displayNameRowsWithNoProject,
  listSeededIds,
  countSeededIds,
  listDistinctProjectIds,
  listParentFieldsPending,
  countParentFieldsPending,
  setParentFieldsPending,
  freshPendingAt,
  pendingRaiseOps,
  RAISE_MAX_TRIES,
  upsert,
  bulkUpsertForProject,
  patchExtraction,
  setPublished,
  listSyncPending,
  listSyncRefs,
  upsertForSync,
  deleteById
};
