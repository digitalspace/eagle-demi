'use strict';

/**
 * Project notifications repository — Cosmos NoSQL.
 *
 * Container `notifications` (Eagle `ProjectNotification`), partitioned by `/id`. ~17 small rows read
 * whole, so /id gives perfect distribution and 1 RU point reads.
 *
 * A notification is not project data: `associatedProjectId` is a loose reference to a project that
 * may not exist yet, so there is NO project axis and `visibilityFor` is called with a null partition
 * field — role ACL applies, project scope does not. Same rule as `boundaries`.
 */

const cosmos = require('../db/cosmos-nosql');
const { canRead } = require('../helpers/access-sql');
const { eq, inList, selectWhere, selectFor, countWhere, pageOptions, orderByFrom, pageSlice, upsertItem } = require('./_sql');

const CONTAINER = 'notifications';
const PARTITION_FIELD = 'id';
/** Null is load-bearing, not a placeholder — see the header. */
const SCOPE_FIELD = null;

const SORTABLE = ['notificationReceivedDate', 'name'];
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

async function list(access, { pageNum, pageSize, sortBy, ...filters } = {}) {
  const spec = selectWhere({
    access,
    partitionField: SCOPE_FIELD,
    criteria: criteriaFor(filters),
    select: selectFor(CONTAINER, access, PARTITION_FIELD),
    orderBy: orderByFrom(sortBy, SORTABLE, DEFAULT_ORDER, SORT_ALIASES)
  });

  const { skip, fetch } = pageSlice({ pageNum, pageSize });
  const { items } = await cosmos.query(CONTAINER, spec, pageOptions({ pageSize: fetch }));
  return skip > 0 ? items.slice(skip) : items;
}

/**
 * A bounded set of notifications in one query: name and id for the label an update refers to, or
 * whole rows under `{full: true}` for the keyword search, which reads back what the index ranked.
 *
 * Cosmos answers in its own order; a caller that asked for a ranking re-imposes it.
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

async function count(access, filters = {}) {
  const { items } = await cosmos.query(CONTAINER,
    countWhere({ access, partitionField: SCOPE_FIELD, criteria: criteriaFor(filters) }), {});
  return items[0] || 0;
}

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
  list,
  listByIds,
  count,
  upsert
};
