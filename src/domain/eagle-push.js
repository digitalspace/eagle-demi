'use strict';

const { logger } = require('../utils/logger');
const { writeGuarded } = require('../helpers/etag-write');
const { heldSealed } = require('../helpers/access-sql');
const { constrainToProject, DELETED_CEILING } = require('../repositories/documents');

/**
 * The pusher's clock on the mirrored row. The etag guard makes a race safe but not ordered, so a later
 * push is compared against this stamp and an older body from another eagle-api pod is refused.
 */
const PUSHED_AT_FIELD = 'eaglePushedAt';

/**
 * True when this push is older than the stored row's; equal or missing stamps write. No skew tolerance: refusing
 * a skewed push ends in the same state as accepting a stale one, and any window admits the stale pushes.
 */
function isStalePush(pushedAt, current, field = PUSHED_AT_FIELD) {
  // Not mongoose's `__v`: publish, unpublish and extension write through doc.save() and Model.updateOne,
  // which skip the findOneAndUpdate hook that bumps it (eagle-api api/helpers/models.js:71).
  if (!Number.isFinite(pushedAt) || !current) return false;
  const stored = current[field];
  return Number.isFinite(stored) && pushedAt < stored;
}

/**
 * The row to write with its ordering stamp. A push with none keeps the stored one: a Cosmos write
 * replaces the item, so dropping it would clear the ordering for every later push.
 */
function stampPush(item, pushedAt, current, field = PUSHED_AT_FIELD) {
  const stamp = Number.isFinite(pushedAt) ? pushedAt : (current && current[field]);
  return Number.isFinite(stamp) ? { ...item, [field]: stamp } : item;
}

/**
 * A row DEMI sealed keeps its ACL through a push, and its `sealedAt`: a row written without the
 * stamp would read as Eagle's seal and the next push would reopen it. See `access-sql:heldSealed`.
 */
function keepSeal(item, current) {
  if (!heldSealed(current)) return item;
  return { ...item, read: current.read, isPublished: current.isPublished, sealedAt: current.sealedAt };
}

/**
 * Write the row; `build(current)` and the `pushedAt` check run per try against the row that try read.
 * `pushedAtField` names the stamp, so ENGAGE and Eagle each order their own pushes. `conflict` once every try lost.
 */
async function upsertWithRetry(repo, build, readExisting,
  { pushedAt = null, pushedAtField = PUSHED_AT_FIELD } = {}) {
  const existing = await readExisting();

  return writeGuarded({
    existing,
    reread: readExisting,
    attempt: async (current) => {
      if (isStalePush(pushedAt, current, pushedAtField)) return { ignored: 'stale', existing: current };
      const item = keepSeal(stampPush(await build(current), pushedAt, current, pushedAtField), current);
      return { saved: await repo.upsert(item, current), existing: current };
    }
  });
}

const demiOwned = (row) => Boolean(row) && row.sourceSystem === 'demi';

/** The Eagle echo applied to a row DEMI owns: no Eagle field is copied, only the raw `sources.eagle`. */
function eagleOwnedOnto(current, eagleId, doc) {
  return { ...current, eagleId, sources: { ...current.sources, eagle: doc } };
}

/**
 * `upsertWithRetry` for a mirror whose rows DEMI may own: a DEMI row keeps every field but `eagleId`, `sources.eagle`
 * and `fromEagle`; any other row is `build(current)`. `label` names the controller in the log line.
 */
async function upsertKeepingDemiRows(repo, eagleId, doc, build, readExisting, { pushedAt = null, label, fromEagle = {} }) {
  const written = await upsertWithRetry(repo,
    (current) => (demiOwned(current) ? { ...eagleOwnedOnto(current, eagleId, doc), ...fromEagle } : build(current)),
    readExisting, { pushedAt });
  if (written.saved && demiOwned(written.existing)) {
    logger.info(`[${label}] eagle push kept to the raw copy on a row it does not own`,
      { eagleId, id: written.saved.id, sourceSystem: written.existing.sourceSystem });
  }
  return written;
}

/**
 * `read` under the deleted ceiling (level 2) when Eagle pushed the record with `isDeleted: true`,
 * as the comment-period mirror does: DEMI flags and narrows a delete, it never removes the row.
 */
function underDeleteCeiling(read, doc) {
  return doc.isDeleted === true ? constrainToProject(read, DELETED_CEILING) : read;
}

module.exports = {
  PUSHED_AT_FIELD,
  isStalePush,
  stampPush,
  keepSeal,
  upsertWithRetry,
  upsertKeepingDemiRows,
  underDeleteCeiling
};
