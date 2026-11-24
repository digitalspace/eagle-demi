'use strict';

/**
 * The parts every `PUT /eagle/*` mirror shares. eagle-api pushes fire-and-forget on every write it
 * makes, keyed by its own `_id`, and the body carries the RAW Eagle record.
 */

const { logger } = require('../../utils/logger');
const { auditEvent } = require('../../utils/audit');
const { mirrorError } = require('../../helpers/duplicate-id');
const { PUSHED_AT_FIELD } = require('../../domain/eagle-push');

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

module.exports = {
  eaglePush,
  mismatchedPush,
  pushHandler,
  ignoreStalePush,
  pushConflict
};
