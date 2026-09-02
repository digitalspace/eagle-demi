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

const CONTAINER = 'updates';
const PARTITION_FIELD = 'id';

/** Nobody has claimed the notification yet. An absent field and an explicit null both count. */
const UNCLAIMED = 'FROM c WHERE NOT IS_DEFINED(c.notifiedAt) OR IS_NULL(c.notifiedAt)';

async function getById(access, id) {
  const item = await cosmos.readItem(CONTAINER, String(id), String(id));
  if (!item) return null;
  // The Cosmos partition is /id; the project axis a SCOPED caller is confined to is projectId.
  return canRead(item, access, 'projectId') ? item : null;
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

module.exports = { CONTAINER, PARTITION_FIELD, getById, upsert, claimForNotify, releaseNotify };
