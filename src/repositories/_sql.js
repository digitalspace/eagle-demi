'use strict';

/**
 * Not a query builder: each repository writes its own SQL so the text is reviewable at the call
 * site. These helpers only cover the mechanical parts, such as parameter naming and paging.
 */

const cosmos = require('../db/cosmos-nosql');
const { sortEntries } = require('../search/sort-entries');
const { visibilityFor, andClauses, MAX_PAGE_SIZE, MAX_PAGE_DEPTH } = require('../helpers/access-sql');
const { logger } = require('../utils/logger');
const { catalogFor } = require('../vis/catalog');
const { visible } = require('../vis/redact');
const { duplicateIdError } = require('../helpers/duplicate-id');
const { ANONYMOUS_LEVEL, LEVELS, levelOf } = require('../vis/level');

/**
 * A criterion has the readClause/scopeClause shape, so all of them compose through andClauses.
 * Values are always bound, never interpolated.
 */
function eq(field, value, paramName, alias = 'c') {
  return { clause: `${alias}.${field} = ${paramName}`, params: [{ name: paramName, value }] };
}

function isDefinedAndNotNull(field, alias = 'c') {
  return {
    clause: `(IS_DEFINED(${alias}.${field}) AND NOT IS_NULL(${alias}.${field}))`,
    params: []
  };
}

/**
 * Leaves out a row Eagle deleted: the mirror keeps it, flagged, for the reconcile and the ACL
 * cascade, but no read serves it. `IS_BOOL` first: a missing flag must read as "not deleted".
 */
const NOT_DELETED = { clause: 'NOT (IS_BOOL(c.isDeleted) AND c.isDeleted = true)', params: [] };

/** A row holding a version Eagle, its only sync-out consumer, has not been sent. */
const EAGLE_SYNC_PENDING = 'c.syncVersion > 0 AND ' +
  '(NOT IS_NUMBER(c.syncOut.eagle.sentVersion) OR c.syncVersion > c.syncOut.eagle.sentVersion)';

// Guarded by IS_*: a missing field compares as undefined, and NOT undefined would drop the row.
const FAILED_AT_VERSION = "IS_STRING(c.syncOut.eagle.status) AND c.syncOut.eagle.status = 'failed' AND " +
  'IS_NUMBER(c.syncOut.eagle.failedVersion) AND c.syncOut.eagle.failedVersion = c.syncVersion';

/** A DEMI row owed a send that a record reaching Eagle releases: not a stray, and not one that failed at its version. */
const RELEASABLE_PENDING = `c.sourceSystem = 'demi' AND ${EAGLE_SYNC_PENDING} ` +
  `AND NOT IS_DEFINED(c.syncOut.eagle.strayEagleId) AND NOT (${FAILED_AT_VERSION})`;

/** A native repository (`cosmosKind` shape) whose list and count always carry `fixed` as well. */
function withCriteria(kind, fixed) {
  const where = criteria => [...fixed, ...(criteria || [])];
  return {
    ...kind,
    list: (access, opts) => kind.list(access, { ...opts, criteria: where(opts.criteria) }),
    count: (access, opts) => kind.count(access, { ...opts, criteria: where(opts.criteria) })
  };
}

/**
 * An empty list renders `false`: `IN ()` is invalid SQL, and dropping the criterion would widen the
 * read to every row the caller may see. The caller's prefix keeps two IN clauses from colliding.
 */
function inList(field, values, prefix, alias = 'c') {
  if (!Array.isArray(values) || values.length === 0) {
    return { clause: 'false', params: [] };
  }
  const names = values.map((_, i) => `${prefix}${i}`);
  return {
    clause: `${alias}.${field} IN (${names.join(', ')})`,
    params: names.map((name, i) => ({ name, value: values[i] }))
  };
}

/**
 * SELECT with the caller's visibility predicate first and never optional, so no read goes out
 * unfiltered.
 *
 * @param {object}   opts
 * @param {object}   opts.access           from resolveAccess()
 * @param {string|null} opts.partitionField 'id' on projects, 'projectId' elsewhere, null with no project axis (boundaries)
 * @param {Array}    [opts.criteria]       extra fragments
 * @param {string}   [opts.select='*']     projection — use to omit fields a caller may not see
 * @param {string}   [opts.orderBy]        e.g. 'c.name ASC' (the path must be indexed)
 * @param {string}   [opts.groupBy]        e.g. 'c.projectId'; Cosmos refuses it beside ORDER BY, so sort grouped rows in JS
 * @returns {{query: string, parameters: Array}}
 */
function selectWhere({ access, partitionField, criteria = [], select = '*', orderBy, groupBy }) {
  if (orderBy && groupBy) throw new Error('[sql] Cosmos rejects GROUP BY beside ORDER BY');

  const predicate = andClauses(
    visibilityFor(access, partitionField),
    ...criteria.filter(Boolean)
  );

  let query = `SELECT ${select} FROM c WHERE ${predicate.clause}`;
  if (groupBy) query += ` GROUP BY ${groupBy}`;
  if (orderBy) query += ` ORDER BY ${orderBy}`;

  return { query, parameters: predicate.params };
}

/**
 * Throws unless this caller may see `field` of `entity`: a filter on a hidden field answers, through
 * which rows match, what the hidden value is. Refused, not dropped, so the caller is not misled.
 */
function assertFilterable(entity, field, access) {
  const entry = catalogFor(entity)[field];
  if (!entry || !visible(levelOf(access), entry.defaultVis)) {
    throw new Error(`[${entity}] cannot filter on a field this caller cannot see: ${field}`);
  }
}

/**
 * Projection of the catalog fields this caller's level can ever see. Defence in depth only:
 * `redactForAccess` enforces policy, since a per-record dial can restrict below `maxVis`.
 *
 * @param {string} entity          a key of src/vis/catalog
 * @param {object} access          from resolveAccess()
 * @param {string} partitionField  'id' on projects, 'projectId' elsewhere; required, a default would miss another entity's key
 */
function selectFor(entity, access, partitionField) {
  if (!partitionField) throw new Error('[vis] selectFor needs the entity partition field');

  // Same fail-closed resolution as redact.js: `null <= maxVis` is true for every ceiling, so an
  // unrecognised level must land on 4 rather than reach Cosmos as a comparison that always passes.
  const level = LEVELS.includes(access && access.level) ? access.level : ANONYMOUS_LEVEL;
  if (level === 0) return '*';

  // Always projected: canRead and the derived isPublished read them, and the dial map must be readable.
  const fields = new Set(['id', partitionField, 'read', 'isPublished', 'vis']);
  // Sealed like `read`, but the `pinsPublished` predicate reads it, so the redactor needs it.
  if (catalogFor(entity).pinsRead) fields.add('pinsRead');
  for (const [key, entry] of Object.entries(catalogFor(entity))) {
    // A dotted key projects its PARENT; the redactor narrows it back to the listed children.
    if (visible(level, entry.maxVis)) fields.add(key.split('.')[0]);
  }

  // Quoted keys and bracket accessors, because catalog fields include SQL keywords (inspections'
  // `case`). Cosmos documents `x AS p` as `VALUE { p: x }`, so rows keep their shape.
  const props = [...fields].map(field => `${JSON.stringify(field)}: c[${JSON.stringify(field)}]`);
  return `VALUE { ${props.join(', ')} }`;
}

/**
 * COUNT through selectWhere, with the read's own predicate: a count from any other filter leaks
 * the size of rows the caller cannot see.
 */
function countWhere({ access, partitionField, criteria = [] }) {
  const spec = selectWhere({ access, partitionField, criteria, select: 'VALUE COUNT(1)' });
  return spec;
}

/**
 * Paging options for the SDK. Continuation tokens rather than skip/take — Cosmos has no
 * efficient offset, so page N would cost the same as pages 1..N combined.
 */
function pageOptions({ pageSize, continuationToken, partitionKey } = {}) {
  const options = {};
  // A junk, zero or negative pageSize must NOT drop maxItemCount: cosmos.query then takes the
  // fetchAll() branch and drains the whole container cross-partition on an anonymous request.
  if (pageSize !== undefined) options.maxItemCount = Math.min(Math.max(Number(pageSize) || MAX_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  if (continuationToken) options.continuationToken = continuationToken;
  if (partitionKey !== undefined) options.partitionKey = partitionKey;
  return options;
}

/**
 * Every row a query matches. A request path may call it only when something other than the corpus
 * bounds the result, as in `documents.projectUploadMaxima` (one row per project).
 */
async function fetchAll(container, spec, opts = {}) {
  const rows = [];
  let continuationToken;
  do {
    // No maxItemCount on purpose: cosmos.query then takes the SDK's fetchAll(), which drains the
    // whole set, and this call wants the whole set.
    const page = await cosmos.query(container, spec,
      pageOptions({ ...opts, continuationToken }));
    for (const item of page.items) rows.push(item); // spread caps at ~125k args
    continuationToken = page.continuationToken;
  } while (continuationToken);
  return rows;
}

/**
 * One key, no tiebreak: a multi-property ORDER BY needs a composite index none of these containers
 * has. ORDER BY drops rows lacking the field, so `allowed` names only fields the mirror always writes.
 *
 * @param {string|string[]} sortBy  the raw query value, in any of the three wire shapes
 * @param {string[]} allowed        field names a caller may order by
 * @param {string} fallback         e.g. 'c.id ASC' — used when the caller named nothing usable
 * @param {object} [aliases]        wire key -> stored field, for sort keys no mirrored row carries (`score`, `_id`)
 */
function orderByFrom(sortBy, allowed, fallback, aliases = {}) {
  for (const entry of sortEntries(sortBy)) {
    const name = aliases[entry.replace(/^[+-]/, '')] || entry.replace(/^[+-]/, '');
    if (allowed.includes(name)) return `c.${name} ${entry.startsWith('-') ? 'DESC' : 'ASC'}`;
  }
  return fallback;
}

/**
 * Etag-guarded `replace` while the row keeps its partition, so a concurrent push gets 412. A changed
 * partition key would 404 on replace, so it upserts; the caller deletes the old-partition row.
 */
async function upsertItem(container, partitionField, item, existing) {
  if (!existing) return cosmos.create(container, item);
  if (String(existing[partitionField]) !== String(item[partitionField])) {
    return cosmos.upsert(container, item);
  }
  return cosmos.replace(container, item.id, item[partitionField], item, existing._etag);
}

/**
 * Stored row with no visibility predicate, for a write's existence check only: never return it in a
 * response. A miss in `partitionKey` (the row moved parent) searches every partition.
 *
 * @param {string} [partitionField] names the partition keys in the log when the id is duplicated
 * @throws an error with `code === DUPLICATE_ID` when the id is in more than one row, see oneRowOf
 */
async function readForWriteIn(container, id, partitionKey, partitionField) {
  if (partitionKey !== undefined && partitionKey !== null) {
    const row = await cosmos.readItem(container, String(id), String(partitionKey));
    if (row) return row;
  }
  const { clause, params } = eq('id', String(id), '@id');
  // Bounded by how many partitions hold this id, not by the corpus.
  const { items } = await cosmos.query(container,
    { query: `SELECT * FROM c WHERE ${clause}`, parameters: params });
  return oneRowOf(container, id, items, partitionField);
}

/**
 * A move whose old-partition delete failed leaves two rows, the new one naming the old one's
 * partition: that marked row is current. Any other second row throws `DUPLICATE_ID`.
 */
function oneRowOf(container, key, items, partitionField) {
  if (items.length === 2 && partitionField) {
    const marked = items.find((row, i) => row.movedFromProjectId != null &&
      String(row.movedFromProjectId) === String(items[1 - i][partitionField]));
    if (marked) return marked;
  }
  if (items.length > 1) {
    throw duplicateIdError(container, key,
      partitionField ? items.map(row => row[partitionField]) : undefined);
  }
  return items[0] || null;
}

/**
 * The DEMI-created row sync-out sent under this Eagle id, with no ACL predicate, in a container whose Eagle rows
 * are stored under their Eagle id. Throws `DUPLICATE_ID` when two rows name it.
 */
async function readDemiRowByEagleId(container, eagleId, partitionKey) {
  const { clause, params } = eq('eagleId', String(eagleId), '@eagleId');
  const { items } = await cosmos.query(container,
    { query: `SELECT * FROM c WHERE ${clause} AND c.sourceSystem = 'demi'`, parameters: params },
    partitionKey == null ? undefined : { partitionKey: String(partitionKey) });
  return oneRowOf(container, eagleId, items);
}

/** DEMI-created rows holding a version not yet sent to Eagle: a sync-out pending hook's list. */
function listDemiSyncPending(container) {
  return fetchAll(container,
    { query: `SELECT * FROM c WHERE c.sourceSystem = 'demi' AND ${EAGLE_SYNC_PENDING}`, parameters: [] });
}

/**
 * The SDK reports a failed access condition on `code` or on `statusCode` depending on the path
 * that raised it; a caller retrying a lost write should not have to know which.
 */
function racedAs(err, expected, message) {
  const status = err.code || err.statusCode;
  if (status !== expected) throw err;
  throw Object.assign(new Error(message, { cause: err }), { code: expected });
}

/**
 * Lands only while the row is still the revision the caller read; a loser gets 412. No `etag`
 * means no guard, so use `createItem` for a row the caller found absent.
 *
 * @param {string} container
 * @param {object} item
 * @param {{etag?: string, label: string}} options `label` names the repository in the error
 * @throws an error with `code === 412` when the row moved under the caller
 */
async function upsertWithEtag(container, item, { etag, label }) {
  try {
    return await cosmos.upsert(container, item, { etag });
  } catch (err) {
    return racedAs(err, 412, `[${label}] upsert of ${item && item.id} lost its etag race`);
  }
}

/**
 * `create`, not an unguarded upsert, which would replace a row another writer created in between.
 * Cosmos answers 409, which the caller re-reads and re-judges as it does a 412.
 *
 * @throws an error with `code === 409` when the row was created behind the caller
 */
async function createItem(container, item, label) {
  try {
    return await cosmos.create(container, item);
  } catch (err) {
    return racedAs(err, 409, `[${label}] create of ${item && item.id} lost to a concurrent create`);
  }
}

/**
 * Cosmos has no offsets: overfetch `skip + size` rows and slice. `size` clamps to MAX_PAGE_SIZE;
 * `readPage` refuses `skip + size` past MAX_PAGE_DEPTH.
 */
function pageSlice({ pageNum, pageSize } = {}) {
  const size = Math.min(Math.max(Number(pageSize) || MAX_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const skip = Math.max(Number(pageNum) || 0, 0) * size;
  return { size, skip, fetch: skip + size };
}

/** Fault stop for one `readPage`: the fetches its deepest page needs, plus slack for short ones. */
const READ_PAGE_MAX_FETCHES = Math.ceil(MAX_PAGE_DEPTH / MAX_PAGE_SIZE) + 30;

/**
 * One `pageSlice` page of `spec`, or its first `fetch` rows with no MAX_PAGE_SIZE clamp, following continuations;
 * a deep page costs every row before it. Throws `status: 400` past MAX_PAGE_DEPTH, before any read.
 */
async function readPage(container, spec, { pageNum, pageSize, partitionKey, fetch: first } = {}) {
  const { skip, fetch } = first === undefined ? pageSlice({ pageNum, pageSize }) : { skip: 0, fetch: first };
  if (fetch > MAX_PAGE_DEPTH) {
    throw Object.assign(new Error('page is past the deepest page this list serves: ' +
      `pageNum * pageSize + pageSize must stay within ${MAX_PAGE_DEPTH} rows`), { status: 400 });
  }
  const rows = [];
  let read = 0;
  let continuationToken;
  for (let fetches = 0; ; fetches++) {
    if (fetches === READ_PAGE_MAX_FETCHES) {
      logger.warn('[sql] page read hit its fetch bound; answering a short page', {
        container, fetches, read, skip, fetch
      });
      break;
    }
    const page = await cosmos.query(container, spec,
      pageOptions({ pageSize: fetch - read, continuationToken, partitionKey }));
    for (const item of page.items) {
      if (read++ >= skip) rows.push(item);
    }
    continuationToken = page.continuationToken;
    if (!continuationToken || read >= fetch) break;
  }
  return rows;
}

module.exports = {
  NOT_DELETED,
  EAGLE_SYNC_PENDING,
  RELEASABLE_PENDING,
  withCriteria,
  eq,
  inList,
  assertFilterable,
  orderByFrom,
  pageSlice,
  readPage,
  upsertItem,
  readForWriteIn,
  oneRowOf,
  readDemiRowByEagleId,
  listDemiSyncPending,
  upsertWithEtag,
  createItem,
  isDefinedAndNotNull,
  selectWhere,
  selectFor,
  countWhere,
  pageOptions,
  fetchAll
};
