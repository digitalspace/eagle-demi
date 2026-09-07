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
const { selectWhere, selectFor, countWhere, pageOptions, orderByFrom, pageSlice } = require('./_sql');

const CONTAINER = 'notifications';
const PARTITION_FIELD = 'id';
/** Null is load-bearing, not a placeholder — see the header. */
const SCOPE_FIELD = null;

const SORTABLE = ['notificationReceivedDate', 'name'];
const DEFAULT_ORDER = 'c.notificationReceivedDate DESC';

async function getById(access, id) {
  const item = await cosmos.readItem(CONTAINER, String(id), String(id));
  if (!item) return null;
  return canRead(item, access, SCOPE_FIELD) ? item : null;
}

async function list(access, { pageNum, pageSize, sortBy } = {}) {
  const spec = selectWhere({
    access,
    partitionField: SCOPE_FIELD,
    select: selectFor(CONTAINER, access, PARTITION_FIELD),
    orderBy: orderByFrom(sortBy, SORTABLE, DEFAULT_ORDER)
  });

  const { skip, fetch } = pageSlice({ pageNum, pageSize });
  const { items } = await cosmos.query(CONTAINER, spec, pageOptions({ pageSize: fetch }));
  return skip > 0 ? items.slice(skip) : items;
}

async function count(access) {
  const { items } = await cosmos.query(CONTAINER,
    countWhere({ access, partitionField: SCOPE_FIELD }), {});
  return items[0] || 0;
}

async function upsert(item, existing) {
  if (!existing) return cosmos.create(CONTAINER, item);
  return cosmos.replace(CONTAINER, item.id, item.id, item, existing._etag);
}

module.exports = {
  CONTAINER,
  PARTITION_FIELD,
  SCOPE_FIELD,
  SORTABLE,
  getById,
  list,
  count,
  upsert
};
