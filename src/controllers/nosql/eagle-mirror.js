'use strict';

/**
 * The parts every `PUT /eagle/*` mirror shares. eagle-api pushes fire-and-forget on every write it
 * makes, keyed by its own `_id`, and the body carries the RAW Eagle record.
 */

const { logger } = require('../../utils/logger');
const { auditEvent } = require('../../utils/audit');
const { writeGuarded } = require('../../helpers/etag-write');
const { levelOfRead } = require('../../helpers/access-sql');

/**
 * The pusher's clock, carried on the mirrored row.
 *
 * The etag guard makes a lost race safe but not ordered: two eagle-api pods push the same record
 * and the older body can still be the one that lands last. This stamp is what a later push is
 * compared against, so the older one is refused instead of rebuilt and written.
 */
const PUSHED_AT_FIELD = 'eaglePushedAt';

/** The push envelope's `pushedAt` as a number, or null — older clients send none. */
function pushedAtOf(body) {
  const value = body && body.pushedAt;
  return Number.isFinite(value) ? value : null;
}

/** `{ eagleId, doc, pushedAt }`, or null when the body does not agree with the path. */
function eaglePush(req) {
  const eagleId = String(req.params.eagleId);
  const doc = req.body && req.body.doc;
  if (!doc || String(doc._id || '') !== eagleId) return null;
  return { eagleId, doc, pushedAt: pushedAtOf(req.body) };
}

/**
 * Whether this push is older than the one the stored row already carries. No skew tolerance: a
 * push refused for clock skew leaves DEMI on the older record, the same outcome as accepting a
 * stale one, while any tolerance admits every stale push that lands inside the window — which is
 * the case this guard exists for (34 ms in the 2026-09-15 incident).
 *
 * Equal stamps WRITE: two pushes sharing a millisecond came from one pod, which ordered them
 * itself. A push with no stamp writes too, or a client that predates the field could never
 * update a row a newer client had stamped.
 *
 * Ordering on mongoose's `__v` instead does not hold: eagle-api bumps it in the `findOneAndUpdate`
 * hook only (`api/helpers/models.js:71`), and the publish, unpublish and extension paths write
 * through `doc.save()` and `Model.updateOne`, which that hook never sees.
 */
function isStalePush(pushedAt, current) {
  if (!Number.isFinite(pushedAt) || !current) return false;
  const stored = current[PUSHED_AT_FIELD];
  return Number.isFinite(stored) && pushedAt < stored;
}

/**
 * The row to write, carrying the stamp it is ordered by. A push without one keeps whatever the
 * stored row holds — a Cosmos write replaces the item, so not carrying it would clear the ordering
 * for every push behind it.
 */
function stampPush(item, pushedAt, current) {
  const stamp = Number.isFinite(pushedAt) ? pushedAt : (current && current[PUSHED_AT_FIELD]);
  return Number.isFinite(stamp) ? { ...item, [PUSHED_AT_FIELD]: stamp } : item;
}

/**
 * Answer a push a newer one has already overtaken: nothing written, nothing cascaded, and 200 —
 * eagle-api's push client re-sends a 5xx and there is nothing here worth sending again.
 *
 * @param {object} options `current` is the stored row that won, `projectId` omitted for the
 *   mirrors that have no project dimension.
 */
function ignoreStalePush(req, res, { label, action, targetType, current, projectId, pushedAt }) {
  const eaglePushedAt = current[PUSHED_AT_FIELD];
  logger.info(`[${label}] eagle push ignored, a newer push already landed`,
    { id: current.id, pushedAt, eaglePushedAt });
  auditEvent(req, {
    action,
    outcome: 'ignored',
    targetType,
    targetId: current.id,
    projectId,
    detail: { ignored: 'stale', pushedAt, eaglePushedAt }
  });
  return res.json({ ok: true, ignored: 'stale', eaglePushedAt });
}

/**
 * Answer a push that kept losing its race, in the same words on every mirror.
 *
 * A 5xx rather than a 409, because that is the only answer eagle-api's push client sends again: it
 * retries a 500-and-up and gives up on everything below (`api/helpers/pushClient.js`). Nothing is
 * wrong with the push, it just never found the row standing still.
 */
function pushConflict(res, { label, eagleId, projectId }) {
  logger.warn(`[${label}] eagle push lost its etag race, asking for a retry`,
    { eagleId, projectId });
  return res.status(503).json({
    error: 'The record is being written by another request. Push it again.'
  });
}

/** A sealed (level 0) row keeps its ACL: Eagle knows nothing of the seal, so a push never reopens it. */
function keepSeal(item, current) {
  if (!current || levelOfRead(current.read) !== 0) return item;
  return { ...item, read: current.read, isPublished: current.isPublished };
}

/**
 * Write the row, rebuilding against whatever is stored after each lost race. `build(current)` runs
 * per try, so anything carried across from the stored row is carried from the value that is
 * actually stored rather than the one this request read first.
 *
 * `pushedAt` is judged inside each attempt, against the row THAT attempt read: a retry after a
 * lost race decides against the push that won, not against the revision this request first saw.
 *
 * @returns {Promise<{saved: object, existing: object|null}|{ignored: string, existing: object}
 *   |{status: 'conflict'}>} `conflict` once every try has lost.
 */
async function upsertWithRetry(repo, build, readExisting, { pushedAt = null } = {}) {
  const existing = await readExisting();

  return writeGuarded({
    existing,
    reread: readExisting,
    attempt: async (current) => {
      if (isStalePush(pushedAt, current)) return { ignored: 'stale', existing: current };
      const item = keepSeal(stampPush(build(current), pushedAt, current), current);
      return { saved: await repo.upsert(item, current), existing: current };
    }
  });
}

/** The Mongo `ObjectId | { _id }` a populated Eagle reference arrives as, as a string or null. */
function refId(value) {
  if (!value) return null;
  return String((typeof value === 'object' && value._id) || value) || null;
}

module.exports = {
  eaglePush,
  isStalePush,
  stampPush,
  ignoreStalePush,
  pushConflict,
  upsertWithRetry,
  refId
};
