'use strict';

/**
 * Comments repository — Cosmos NoSQL.
 *
 * Container `comments` (Eagle `Comment`), partitioned by `/periodId`: every list is "the comments of
 * this period". `projectId` rides on each row as well, because that — never `periodId` — is the axis
 * a SCOPED caller is confined to, so it is what `canRead` and `visibilityFor` are given.
 */

const cosmos = require('../db/cosmos-nosql');
const { canRead } = require('../helpers/access-sql');
const { eq, selectWhere, selectFor, countWhere, pageOptions, orderByFrom, pageSlice, upsertItem } = require('./_sql');
const { cascadeAcl } = require('../helpers/acl-cascade');

const CONTAINER = 'comments';
const PARTITION_FIELD = 'periodId';
/** The project axis — see the header. Not the partition key. */
const SCOPE_FIELD = 'projectId';

const SORTABLE = ['dateAdded', 'commentId'];
const DEFAULT_ORDER = 'c.commentId ASC';

/** Point read. With the period it is single-partition; without, the predicate runs in the query. */
async function getById(access, id, periodId) {
  if (periodId) {
    const item = await cosmos.readItem(CONTAINER, String(id), String(periodId));
    if (!item) return null;
    return canRead(item, access, SCOPE_FIELD) ? item : null;
  }

  const spec = selectWhere({
    access,
    partitionField: SCOPE_FIELD,
    criteria: [eq('id', String(id), '@id')]
  });
  // Pages are drained, not sampled: one page of a cross-partition lookup can come back empty while
  // the row exists, and the caller reads that as "no such comment".
  return await cosmos.queryFirst(CONTAINER, spec, {});
}

function criteriaFor(periodId) {
  return [eq(PARTITION_FIELD, String(periodId), '@periodId')];
}

async function listByPeriod(periodId, access, { pageNum, pageSize, sortBy } = {}) {
  const spec = selectWhere({
    access,
    partitionField: SCOPE_FIELD,
    criteria: criteriaFor(periodId),
    select: selectFor(CONTAINER, access, SCOPE_FIELD),
    orderBy: orderByFrom(sortBy, SORTABLE, DEFAULT_ORDER)
  });

  const { skip, fetch } = pageSlice({ pageNum, pageSize });
  const { items } = await cosmos.query(CONTAINER, spec,
    pageOptions({ pageSize: fetch, partitionKey: String(periodId) }));
  return skip > 0 ? items.slice(skip) : items;
}

/**
 * The same predicate as the read. eagle-public renders this number as "N comments", so a count
 * built from a different filter would advertise the size of a set the caller cannot open.
 */
async function countByPeriod(periodId, access) {
  const spec = countWhere({ access, partitionField: SCOPE_FIELD, criteria: criteriaFor(periodId) });
  const { items } = await cosmos.query(CONTAINER, spec, { partitionKey: String(periodId) });
  return items[0] || 0;
}

/** Whole-item write. A comment that changed period moves partition — see `upsertItem`. */
async function upsert(item, existing) {
  return upsertItem(CONTAINER, PARTITION_FIELD, item, existing);
}

/** Removes a row left in a stale partition by a comment that changed period. */
async function deleteById(id, periodId) {
  return cosmos.remove(CONTAINER, String(id), String(periodId));
}

/** The ACL inputs of every comment in one period — see `commentPeriods.aclRowsForProject`. */
async function aclRowsForPeriod(access, periodId) {
  const spec = selectWhere({
    access,
    partitionField: SCOPE_FIELD,
    criteria: criteriaFor(periodId),
    select: 'c.id, c.read, c.sources.eagle.read AS eagleRead'
  });
  const { items } = await cosmos.query(CONTAINER, spec, { partitionKey: String(periodId) });
  return items;
}

/**
 * Re-derive every comment's ACL from its own and its period's.
 *
 * The period's ACL is already narrowed to its project, so this one constrain carries both
 * ceilings — the same reasoning the comment mirror states.
 */
async function setAclForPeriod(access, periodId, read) {
  return cascadeAcl(CONTAINER, periodId, await aclRowsForPeriod(access, periodId), read);
}

module.exports = {
  CONTAINER,
  PARTITION_FIELD,
  SCOPE_FIELD,
  SORTABLE,
  getById,
  listByPeriod,
  countByPeriod,
  aclRowsForPeriod,
  setAclForPeriod,
  upsert,
  deleteById
};
