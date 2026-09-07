'use strict';

/**
 * Updates repository — Cosmos NoSQL.
 *
 * Container `updates` (Eagle `RecentActivity`), partitioned by `/id` (the Eagle `_id`). Rows are
 * small, read whole and written only by the Eagle mirror, so every access is a point read or a
 * point write.
 *
 * `notifiedAt` is the publish-notify claim: it is set by a CONDITIONAL patch, so two concurrent
 * pushes of the same newly published update produce one notification, not two.
 */

const cosmos = require('../db/cosmos-nosql');
const { canRead } = require('../helpers/access-sql');
const { eq, selectWhere, selectFor, countWhere, pageOptions, orderByFrom, pageSlice } = require('./_sql');

const CONTAINER = 'updates';
const PARTITION_FIELD = 'id';
/**
 * The project axis a SCOPED caller is confined to. Holds the EAGLE project id — `doc.project` as
 * eagle-api pushed it — unlike `commentPeriods.projectId`, which holds the DEMI one. Callers
 * filtering this container must not translate the id first.
 */
const SCOPE_FIELD = 'projectId';

const SORTABLE = ['dateAdded', 'dateUpdated'];
const DEFAULT_ORDER = 'c.dateAdded DESC';

/**
 * The three states `pinned` can be stored in — the mirror writes `doc.pinned` straight through, so
 * an Eagle record that never set it lands here undefined. Cosmos drops a row from `c.pinned != true`
 * when the property is absent, so "not pinned" is spelled out rather than negated.
 */
const PINNED = { clause: '(IS_DEFINED(c.pinned) AND c.pinned = true)', params: [] };
const UNPINNED = {
  clause: '(NOT IS_DEFINED(c.pinned) OR IS_NULL(c.pinned) OR c.pinned = false)',
  params: []
};

/** eagle-api answers `?top=true` with at most this many rows in total — see listTop. */
const TOP_ROWS = 4;

/** Nobody has claimed the notification yet. An absent field and an explicit null both count. */
const UNCLAIMED = 'FROM c WHERE NOT IS_DEFINED(c.notifiedAt) OR IS_NULL(c.notifiedAt)';

async function getById(access, id) {
  const item = await cosmos.readItem(CONTAINER, String(id), String(id));
  if (!item) return null;
  // The Cosmos partition is /id; the project axis a SCOPED caller is confined to is projectId.
  return canRead(item, access, 'projectId') ? item : null;
}

function criteriaFor(projectId) {
  return projectId ? [eq(SCOPE_FIELD, String(projectId), '@projectId')] : [];
}

/**
 * The updates this caller may see, newest first.
 *
 * @param {object} [opts.projectId]  an EAGLE project id — see SCOPE_FIELD
 */
async function list(access, { projectId, pageNum, pageSize, sortBy } = {}) {
  const spec = selectWhere({
    access,
    partitionField: SCOPE_FIELD,
    criteria: criteriaFor(projectId),
    select: selectFor(CONTAINER, access, PARTITION_FIELD),
    orderBy: orderByFrom(sortBy, SORTABLE, DEFAULT_ORDER)
  });

  const { skip, fetch } = pageSlice({ pageNum, pageSize });
  const { items } = await cosmos.query(CONTAINER, spec, pageOptions({ pageSize: fetch }));
  return skip > 0 ? items.slice(skip) : items;
}

/** The same predicate as the read, so the total cannot describe rows the page may not carry. */
async function count(access, { projectId } = {}) {
  const spec = countWhere({ access, partitionField: SCOPE_FIELD, criteria: criteriaFor(projectId) });
  const { items } = await cosmos.query(CONTAINER, spec, {});
  return items[0] || 0;
}

/**
 * The home-page strip: pinned updates newest first, topped up with unpinned ones to TOP_ROWS.
 *
 * FOUR ROWS IN TOTAL, not four of each. That is what eagle-api's `/api/public/recentActivity?top=true`
 * answers (`api/controllers/recentActivity.js:75-81` runs the pinned and unpinned pipelines at
 * `$limit: 4` each and then slices the unpinned to `4 - pinned.length`), and this endpoint replaces
 * that URL — eight rows would silently double the strip.
 */
async function listTop(access) {
  const [pinned, unpinned] = await Promise.all([PINNED, UNPINNED].map(async (state) => {
    const spec = selectWhere({
      access,
      partitionField: SCOPE_FIELD,
      criteria: [state],
      select: selectFor(CONTAINER, access, PARTITION_FIELD),
      orderBy: DEFAULT_ORDER
    });
    const { items } = await cosmos.query(CONTAINER, spec, pageOptions({ pageSize: TOP_ROWS }));
    return items.slice(0, TOP_ROWS);
  }));

  return [...pinned, ...unpinned.slice(0, Math.max(0, TOP_ROWS - pinned.length))];
}

/**
 * Whole-item write, guarded by what the caller read.
 *
 * A plain upsert would carry a `notifiedAt` read before a concurrent push claimed it, handing the
 * claim back and announcing the same publication twice. Create when the row is absent, etag-guarded
 * replace when it is not: either way a racing writer gets 409/412 instead of a silent overwrite.
 */
async function upsert(item, existing) {
  if (!existing) return cosmos.create(CONTAINER, item);
  return cosmos.replace(CONTAINER, item.id, item.id, item, existing._etag);
}

/**
 * Take the notification claim, or find it already taken.
 * @returns {Promise<object|null>} the patched row, or null when somebody else holds the claim.
 */
async function claimForNotify(id, now) {
  try {
    return await cosmos.patch(CONTAINER, String(id), String(id),
      [{ op: 'set', path: '/notifiedAt', value: now }], UNCLAIMED);
  } catch (err) {
    // 412 = the condition was false, i.e. another push got there first. Not an error.
    if (err.code === 412 || err.statusCode === 412) return null;
    throw err;
  }
}

/** Give the claim back, so a later publish notifies again. */
async function releaseNotify(id) {
  return cosmos.patch(CONTAINER, String(id), String(id),
    [{ op: 'set', path: '/notifiedAt', value: null }]);
}

module.exports = {
  CONTAINER,
  PARTITION_FIELD,
  SCOPE_FIELD,
  SORTABLE,
  TOP_ROWS,
  getById,
  list,
  count,
  listTop,
  upsert,
  claimForNotify,
  releaseNotify
};
