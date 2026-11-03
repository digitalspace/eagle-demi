'use strict';

// Container `notifications` (Eagle `ProjectNotification`), partitioned by `/id`. No project axis, as for `boundaries`:
// `associatedProjectId` may name a project that does not exist yet, so role ACL applies and project scope does not.

const cosmos = require('../db/cosmos-nosql');
const { canRead } = require('../helpers/access-sql');
const {
  eq, inList, isDefinedAndNotNull, selectWhere, selectFor, countWhere, orderByFrom, readPage, upsertItem, fetchAll,
  readDemiRowByEagleId, listDemiSyncPending
} = require('./_sql');

const CONTAINER = 'notifications';
// A few dozen small rows read whole: /id spreads them evenly and gives 1 RU point reads.
const PARTITION_FIELD = 'id';
/** Null: role ACL only, no project scope. */
const SCOPE_FIELD = null;

const SORTABLE = ['notificationReceivedDate', 'name', 'type', 'region', 'decision', 'proponent', 'subType'];
const DEFAULT_ORDER = 'c.notificationReceivedDate DESC';
/**
 * eagle-public's notifications page sorts by `-_id`, the Mongo id it used as an arrival proxy.
 * Received-date descending is the same order, said in a field these rows carry.
 */
const SORT_ALIASES = { _id: 'notificationReceivedDate' };

/** Filter keys the public notifications page narrows by, and the field each lands on. */
const FILTERS = Object.freeze({ type: 'type', region: 'region', pcp: 'pcp', decision: 'decision' });

/**
 * Shared by the read and its count so the two cannot diverge. Presence, not truthiness: `pcp` is
 * stored as the string 'none' when there is no period, which is a real value to filter for.
 */
function criteriaFor(filters = {}) {
  return Object.entries(FILTERS)
    .filter(([key]) => filters[key] !== undefined && filters[key] !== null)
    .map(([key, field]) => eq(field, String(filters[key]), `@${key}`));
}

async function getById(access, id) {
  const item = await cosmos.readItem(CONTAINER, String(id), String(id));
  if (!item) return null;
  return canRead(item, access, SCOPE_FIELD) ? item : null;
}

/** The stored row, unfiltered: a mirror write asks whether it exists, not who may read it. */
async function readForWrite(id) {
  return cosmos.readItem(CONTAINER, String(id), String(id));
}

/** The DEMI-created row sync-out sent under this Eagle id; `readForWrite` finds an Eagle row. */
const readForWriteByEagleId = (eagleId) => readDemiRowByEagleId(CONTAINER, eagleId);

/** The sync-out pending hook's list. */
const listSyncPending = () => listDemiSyncPending(CONTAINER);

async function list(access, { pageNum, pageSize, sortBy, ...filters } = {}) {
  const spec = listSpec(access, filters, orderByFrom(sortBy, SORTABLE, DEFAULT_ORDER, SORT_ALIASES));

  return readPage(CONTAINER, spec, { pageNum, pageSize });
}

function listSpec(access, filters, orderBy) {
  return selectWhere({
    access,
    partitionField: SCOPE_FIELD,
    criteria: criteriaFor(filters),
    select: selectFor(CONTAINER, access, PARTITION_FIELD),
    orderBy
  });
}

/** Every row `list` pages over, unsorted — for the reconcile only; see `updates.listEvery`. */
async function listEvery(access) {
  return fetchAll(CONTAINER, listSpec(access, {}));
}

/**
 * Name and id of each notification in `ids`, the label an update refers to, or whole rows under `{full: true}`
 * for the keyword search. Cosmos answers in its own order; a caller that asked for a ranking re-imposes it.
 */
async function listByIds(access, ids, { full = false } = {}) {
  const unique = Array.from(new Set((ids || []).map(String)));
  if (unique.length === 0) return [];

  const spec = selectWhere({
    access,
    partitionField: SCOPE_FIELD,
    criteria: [inList(PARTITION_FIELD, unique, '@nid')],
    select: full ? selectFor(CONTAINER, access, PARTITION_FIELD) : 'c.id, c.name'
  });

  const { items } = await cosmos.query(CONTAINER, spec, {});
  return items;
}

/**
 * Notifications with a decision dated no later than `now`, newest first, at most `limit`.
 * Sorted here: `decisionDate` is not indexed, so Cosmos cannot ORDER BY it; a few dozen rows scan cheaply.
 */
async function listDecisions(access, { limit, now }) {
  const spec = selectWhere({
    access,
    partitionField: SCOPE_FIELD,
    criteria: [
      isDefinedAndNotNull('decisionDate'),
      { clause: 'c.decisionDate <= @now', params: [{ name: '@now', value: now.toISOString() }] }
    ],
    select: selectFor(CONTAINER, access, PARTITION_FIELD)
  });
  const { items } = await cosmos.query(CONTAINER, spec, {});
  return items
    .sort((a, b) => Date.parse(b.decisionDate) - Date.parse(a.decisionDate))
    .slice(0, limit);
}

async function count(access, filters = {}) {
  const { items } = await cosmos.query(CONTAINER,
    countWhere({ access, partitionField: SCOPE_FIELD, criteria: criteriaFor(filters) }), {});
  return items[0] || 0;
}

/** The contract's criteria (`helpers/native-query.js`) under the role ACL alone; see the header. */
function nativeSpec(access, criteria, orderBy) {
  return selectWhere({
    access, partitionField: SCOPE_FIELD, criteria, select: selectFor(CONTAINER, access, PARTITION_FIELD), orderBy
  });
}

/** The read `GET /notifications` goes through. `readAll` is a keyword list's read-back (`search/native-index.js`). */
const nativeRepository = Object.freeze({
  list: (access, { criteria, orderBy, pageNum, pageSize }) =>
    readPage(CONTAINER, nativeSpec(access, criteria, orderBy || DEFAULT_ORDER), { pageNum, pageSize }),
  async count(access, { criteria }) {
    const { items } = await cosmos.query(CONTAINER, countWhere({ access, partitionField: SCOPE_FIELD, criteria }), {});
    return items[0] || 0;
  },
  readAll: (access, { criteria, orderBy }) => fetchAll(CONTAINER, nativeSpec(access, criteria, orderBy)),
  // Mirrored: the DEMI id is the Eagle `_id`, so one point read answers both.
  getById
});

async function upsert(item, existing) {
  return upsertItem(CONTAINER, PARTITION_FIELD, item, existing);
}

module.exports = {
  CONTAINER,
  PARTITION_FIELD,
  SCOPE_FIELD,
  SORTABLE,
  FILTERS,
  getById,
  readForWrite,
  readForWriteByEagleId,
  listSyncPending,
  list,
  listEvery,
  listByIds,
  listDecisions,
  count,
  nativeRepository,
  upsert
};
