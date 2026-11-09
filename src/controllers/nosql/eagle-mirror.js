'use strict';

/**
 * The parts every `PUT /eagle/*` mirror shares. eagle-api pushes fire-and-forget on every write it
 * makes, keyed by its own `_id`, and the body carries the RAW Eagle record.
 */

const { logger } = require('../../utils/logger');
const { auditEvent } = require('../../utils/audit');
const { mirrorError } = require('../../helpers/duplicate-id');
const { writeGuarded } = require('../../helpers/etag-write');
const { heldSealed } = require('../../helpers/access-sql');
const { constrainToProject, DELETED_CEILING } = require('../../repositories/documents');

/**
 * The pusher's clock on the mirrored row. The etag guard makes a race safe but not ordered, so a later
 * push is compared against this stamp and an older body from another eagle-api pod is refused.
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

/** The 400 for a push whose body names another record than its path. */
function mismatchedPush(res) {
  return res.status(400).json({ error: 'body.doc._id must match the :eagleId in the path' });
}

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
 * Answer a push a newer one overtook: nothing written, nothing cascaded, and 200, since eagle-api re-sends a 5xx.
 * `current` is the stored row that won; `projectId` is omitted by mirrors with no project.
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
 * Answer a push that kept losing its race. A 503, not a 409: eagle-api's push client
 * (`api/helpers/pushClient.js`) retries a 500-and-up only.
 */
function pushConflict(res, { label, eagleId, projectId }) {
  logger.warn(`[${label}] eagle push lost its etag race, asking for a retry`,
    { eagleId, projectId });
  return res.status(503).json({
    error: 'The record is being written by another request. Push it again.'
  });
}

const publishedDetail = (saved, existing, eagleId) => ({
  eagleId,
  isPublishedFrom: existing ? existing.isPublished : null,
  isPublishedTo: saved.isPublished
});

/**
 * A `PUT /eagle/*` handler. `refuse(written, doc, res)` runs before the conflict check, `after(written, res)` after
 * the audit; each stops it only by returning the sent response (`return res.status(..).json(..)`), else undefined.
 */
function pushHandler({
  label, action, targetType, mirror, refuse, projectScoped = false, detail = publishedDetail, after, failure
}) {
  return async (req, res) => {
    try {
      const push = eaglePush(req);
      if (!push) return mismatchedPush(res);
      const { eagleId, doc, pushedAt } = push;

      const written = await mirror(eagleId, doc, { pushedAt });
      const refused = refuse && refuse(written, doc, res);
      if (refused) return refused;
      if (written.status === 'conflict') return pushConflict(res, { label, eagleId });
      const { saved, existing, ignored } = written;
      if (ignored) {
        return ignoreStalePush(req, res, {
          label, action, targetType, current: existing,
          ...(projectScoped && { projectId: existing.projectId }), pushedAt
        });
      }

      auditEvent(req, {
        action,
        targetType,
        targetId: saved.id,
        ...(projectScoped && { projectId: saved.projectId }),
        detail: detail(saved, existing, eagleId)
      });
      const answered = after && await after(written, res);
      if (answered) return answered;
      return res.json({ id: saved.id, action: 'upsert' });
    } catch (err) {
      return mirrorError(res, err, failure);
    }
  };
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

/** The Mongo `ObjectId | { _id }` a populated Eagle reference arrives as, as a string or null. */
function refId(value) {
  if (!value) return null;
  return String((typeof value === 'object' && value._id) || value) || null;
}

module.exports = {
  eaglePush,
  mismatchedPush,
  pushHandler,
  isStalePush,
  stampPush,
  ignoreStalePush,
  pushConflict,
  keepSeal,
  upsertWithRetry,
  upsertKeepingDemiRows,
  underDeleteCeiling,
  refId
};
