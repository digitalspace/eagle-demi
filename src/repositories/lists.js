'use strict';

// `List` and `Organization` rows share one container, partitioned by `/kind`: a few thousand tiny
// rows read a kind at a time. Neither is project data, so role ACL applies and project scope does not.

const cosmos = require('../db/cosmos-nosql');
const { canRead } = require('../helpers/access-sql');
const {
  eq, inList, selectWhere, selectFor, countWhere, orderByFrom, readPage, upsertItem, fetchAll, oneRowOf,
  EAGLE_SYNC_PENDING
} = require('./_sql');

const CONTAINER = 'lists';
const PARTITION_FIELD = 'kind';
/** Null is load-bearing, not a placeholder — see the header. */
const SCOPE_FIELD = null;

const KINDS = Object.freeze({ LIST: 'List', ORGANIZATION: 'Organization' });

// Per kind: an ORDER BY on a field a kind's rows lack drops every row. Each key must be an
// included path in the `lists` indexing policy (azure/modules/cosmos-nosql.bicep).
const SORTABLE = Object.freeze({
  [KINDS.LIST]: ['name', 'type', 'listOrder'],
  [KINDS.ORGANIZATION]: ['name', 'companyType']
});
const DEFAULT_ORDER = 'c.name ASC';

/** Filter keys a caller may narrow a kind by, and the field each lands on. */
const FILTERS = Object.freeze({ type: 'type', companyType: 'companyType', legislation: 'legislation' });

async function getById(access, id, kind) {
  if (kind) {
    const item = await cosmos.readItem(CONTAINER, String(id), String(kind));
    if (!item) return null;
    return canRead(item, access, SCOPE_FIELD) ? item : null;
  }

  const spec = selectWhere({
    access,
    partitionField: SCOPE_FIELD,
    criteria: [eq('id', String(id), '@id')]
  });
  // Pages are drained, not sampled: one page of a cross-partition lookup can come back empty while
  // the row exists, and the caller reads that as "no such list".
  return await cosmos.queryFirst(CONTAINER, spec, {});
}

/** The stored row, unfiltered: a mirror write asks whether it exists, not who may read it. */
async function readForWrite(id, kind) {
  return cosmos.readItem(CONTAINER, String(id), String(kind));
}

/**
 * Rows of one kind whose `eagleId` field names the id, including one stored under it;
 * callers read by id first.
 */
async function readForWriteByEagleId(eagleId, kind) {
  const criteria = [eq(PARTITION_FIELD, String(kind), '@kind'), eq('eagleId', String(eagleId), '@eagleId')];
  const { items } = await cosmos.query(CONTAINER, {
    query: `SELECT * FROM c WHERE ${criteria.map(c => c.clause).join(' AND ')}`,
    parameters: criteria.flatMap(c => c.params)
  }, { partitionKey: String(kind) });
  return oneRowOf(CONTAINER, eagleId, items);
}

/** Rows of one kind holding a version not yet sent to Eagle: the sync-out pending hook's list. */
async function listSyncPending(kind) {
  const { clause, params } = eq(PARTITION_FIELD, String(kind), '@kind');
  return fetchAll(CONTAINER, {
    query: `SELECT * FROM c WHERE ${clause} AND ${EAGLE_SYNC_PENDING}`, parameters: params
  }, { partitionKey: String(kind) });
}

/**
 * Name and id for a bounded set of rows of one kind, in one query — the label a foreign row refers
 * to, like `notifications.proponent`, which stores an Organization id and renders as its name.
 */
async function listByIds(access, ids, kind) {
  return selectByIds(access, ids, kind, 'c.id, c.name');
}

/** Id, name and province of each organization in `ids`: the label a project pin renders. */
async function listOrganizationLabels(access, ids) {
  return selectByIds(access, ids, KINDS.ORGANIZATION, 'c.id, c.name, c.province');
}

async function selectByIds(access, ids, kind, select) {
  const unique = Array.from(new Set((ids || []).map(String)));
  if (unique.length === 0) return [];

  const spec = selectWhere({
    access,
    partitionField: SCOPE_FIELD,
    criteria: [eq(PARTITION_FIELD, String(kind), '@kind'), inList('id', unique, '@lid')],
    select
  });

  const { items } = await cosmos.query(CONTAINER, spec, { partitionKey: String(kind) });
  return items;
}

function criteriaFor(kind, opts) {
  const criteria = [eq(PARTITION_FIELD, String(kind), '@kind')];
  for (const [key, field] of Object.entries(FILTERS)) {
    // Presence, not truthiness: '' is a real stored value on every Organization that has no
    // companyType, and a falsy test would widen "the unclassified ones" to "all of them".
    if (opts[key] !== undefined && opts[key] !== null) {
      criteria.push(eq(field, String(opts[key]), `@${key}`));
    }
  }
  return criteria;
}

/**
 * Every row of one kind this caller may see.
 *
 * @param {string} kind  one of KINDS
 * @param {object} [opts]  filter keys from FILTERS, plus `pageNum` / `pageSize` / `sortBy`
 */
async function listByKind(kind, access, opts = {}) {
  const spec = byKindSpec(access, criteriaFor(kind, opts), orderByFrom(opts.sortBy, SORTABLE[kind] || [], DEFAULT_ORDER));

  return readPage(CONTAINER, spec,
    { pageNum: opts.pageNum, pageSize: opts.pageSize, partitionKey: String(kind) });
}

function byKindSpec(access, criteria, orderBy) {
  return selectWhere({
    access,
    partitionField: SCOPE_FIELD,
    criteria,
    select: selectFor(CONTAINER, access, PARTITION_FIELD),
    orderBy
  });
}

/** Every row of one kind, past `listByKind`'s MAX_PAGE_SIZE cap — for the reconcile only. */
async function listEveryOfKind(kind, access) {
  return fetchAll(CONTAINER, byKindSpec(access, criteriaFor(kind, {})), { partitionKey: String(kind) });
}

async function countByKind(kind, access, opts = {}) {
  const spec = countWhere({ access, partitionField: SCOPE_FIELD, criteria: criteriaFor(kind, opts) });
  const { items } = await cosmos.query(CONTAINER, spec, { partitionKey: String(kind) });
  return items[0] || 0;
}

/**
 * The native list contract's repository for one kind (`cosmosKind` in helpers/native-query.js),
 * pinned to its partition, so `/lists/:id` cannot answer an Organization row or the reverse.
 */
function nativeKind(kind) {
  const pinned = criteria => [eq(PARTITION_FIELD, String(kind), '@kind'), ...criteria];
  const partition = { partitionKey: String(kind) };
  return {
    async list(access, { criteria, orderBy, pageNum, pageSize }) {
      return readPage(CONTAINER, byKindSpec(access, pinned(criteria), orderBy || DEFAULT_ORDER),
        { pageNum, pageSize, ...partition });
    },
    async count(access, { criteria }) {
      const spec = countWhere({ access, partitionField: SCOPE_FIELD, criteria: pinned(criteria) });
      const { items } = await cosmos.query(CONTAINER, spec, partition);
      return items[0] || 0;
    },
    getById: (access, id) => getById(access, id, kind)
  };
}

/**
 * Whole-item write. Takes `kind: 'List'` rows from the backfill as well as the `kind:
 * 'Organization'` rows the Eagle mirror pushes — `List` has no eagle-api write path.
 */
async function upsert(item, existing) {
  return upsertItem(CONTAINER, PARTITION_FIELD, item, existing);
}

module.exports = {
  CONTAINER,
  PARTITION_FIELD,
  SCOPE_FIELD,
  KINDS,
  FILTERS,
  SORTABLE,
  getById,
  readForWrite,
  readForWriteByEagleId,
  listByIds,
  listOrganizationLabels,
  listByKind,
  listEveryOfKind,
  countByKind,
  nativeKind,
  listSyncPending,
  upsert
};
