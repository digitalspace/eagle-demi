'use strict';

/**
 * ENGAGE ingest for comment periods: `PUT /engage/engagements/:engagementId`.
 *
 * ENGAGE owns the rows it pushes (`sourceSystem: 'engage'`). The Eagle mirror (`comment-period.js`)
 * writes only Eagle's own fields onto them, and sync-out (`src/sync-out`) writes them on to Eagle.
 */

const commentPeriods = require('../../repositories/comment-periods');
const { constrainToProject, DELETED_CEILING } = require('../../repositories/documents');
const { admitParent, refusalCode, eagleRef } = require('../../helpers/parent-admit');
const { seedAcl, eagleReadUnder } = require('../../seed/transform');
const { mirrorError } = require('../../helpers/duplicate-id');
const syncOut = require('../../sync-out');
const { logger } = require('../../utils/logger');
const { auditEvent } = require('../../utils/audit');
const { upsertWithRetry } = require('./eagle-mirror');
const { cascadeToComments } = require('./comment-period');
const { levelOfRead } = require('../../helpers/access-sql');

const LABEL = '[ENGAGE Comment Period Controller]';
const PUSHED_AT_FIELD = 'engagePushedAt';

// The read eagle-api stores on a published and an unpublished period, so the ACL cascade derives
// an ENGAGE row from `sources.engage.read` exactly as it derives an Eagle row from `sources.eagle.read`.
const PUBLISHED_READ = Object.freeze(['public', 'staff', 'sysadmin']);
const UNPUBLISHED_READ = Object.freeze(['staff', 'sysadmin']);

const TRACKING_ID_CLAIMED = 'TRACKING_ID_CLAIMED';

const engageRowId = (engagementId) => `engage-${engagementId}`;

/** `{ engagementId, engagement, pushedAt, trackingId }`, or `{ refusal: [code, message] }`. */
function engagePush(req) {
  const engagementId = String(req.params.engagementId);
  const body = req.body || {};
  const engagement = body.engagement;
  if (!engagement || typeof engagement !== 'object' || String(engagement.id ?? '') !== engagementId) {
    return { refusal: ['ENGAGEMENT_ID_MISMATCH', 'body.engagement.id must match the :engagementId in the path'] };
  }
  const pushedAt = typeof body.pushedAt === 'string' ? Date.parse(body.pushedAt) : NaN;
  if (!Number.isFinite(pushedAt)) {
    return { refusal: ['PUSHED_AT_INVALID', 'body.pushedAt must be an ISO 8601 time'] };
  }
  const trackingId = engagement.trackingId == null || engagement.trackingId === ''
    ? null
    : String(engagement.trackingId);
  // The tracking id becomes a row id and an Eagle URL segment, so it must be an Eagle ObjectId.
  if (trackingId && !eagleRef(trackingId)) {
    return { refusal: ['TRACKING_ID_INVALID', 'body.engagement.trackingId must be an Eagle comment period id'] };
  }
  return { engagementId, engagement, pushedAt, trackingId };
}

/** The row this engagement writes to: already tied to it, else the Eagle period it names, else its own. */
async function readTarget({ engagementId, trackingId }, projectId) {
  return await commentPeriods.readForWriteByEngagementId(engagementId, projectId)
    || (trackingId && await commentPeriods.readForWrite(trackingId, projectId))
    || await commentPeriods.readForWrite(engageRowId(engagementId), projectId);
}

/** The ENGAGE-owned fields written over `current`; everything Eagle owns rides through untouched. */
function engageItem({ engagementId, engagement, trackingId }, parent, current) {
  if (current && current.engagementId && String(current.engagementId) !== engagementId) {
    throw Object.assign(new Error('tracking id already tied to another engagement'),
      { refusal: TRACKING_ID_CLAIMED, claimedBy: String(current.engagementId), id: current.id });
  }
  const own = engagement.isPublished === true ? PUBLISHED_READ : UNPUBLISHED_READ;
  const capped = parent.kind === 'notification' ? seedAcl(own) : eagleReadUnder(own, parent.read);
  const isDeleted = engagement.isDeleted === true;
  const read = isDeleted ? constrainToProject(capped, DELETED_CEILING) : capped;
  const bannerUrl = engagement.bannerUrl || '';

  return {
    ...current,
    id: current ? current.id : engageRowId(engagementId),
    projectId: String(parent.id),
    sourceSystem: 'engage',
    engagementId,
    eagleProjectId: String(engagement.projectId),
    eagleId: (current && current.eagleId) || trackingId,
    isMet: true,
    metURL: engagement.metURL || '',
    metURLAdmin: engagement.metURLAdmin || '',
    bannerUrl,
    // The field eagle-public and the Eagle mirror render the banner from.
    metBannerImageUrl: bannerUrl,
    informationLabel: engagement.name || '',
    instructions: engagement.description || '',
    dateStarted: engagement.start || null,
    dateCompleted: engagement.end || null,
    isDeleted,
    isPublished: read.includes('public'),
    read,
    sources: { ...(current && current.sources), engage: { ...engagement, read: [...own] } }
  };
}

/** Queue the row for every sync-out consumer. A failure is logged, not answered: reconcile re-queues. */
async function enqueueQuietly(row) {
  try {
    return await syncOut.enqueue(row);
  } catch (err) {
    logger.error(`${LABEL} sync-out enqueue failed`,
      { id: row.id, engagementId: row.engagementId, projectId: row.projectId, error: err.message, stack: err.stack });
    return [];
  }
}

function refuseStale(req, res, { engagementId, pushedAt, current }) {
  const { engagePushedAt } = current;
  logger.info(`${LABEL} engage push refused, a newer push already landed`,
    { id: current.id, engagementId, pushedAt, engagePushedAt });
  auditEvent(req, {
    action: 'commentPeriod.push',
    outcome: 'ignored',
    targetType: 'commentPeriod',
    targetId: current.id,
    projectId: current.projectId,
    detail: { ignored: 'stale', sourceSystem: 'engage', engagementId, pushedAt, engagePushedAt }
  });
  return res.status(409).json({
    error: 'A newer push for this engagement has already been written.',
    code: 'STALE_PUSH', id: current.id, engagePushedAt
  });
}

/** `PUT /engage/engagements/:engagementId`. */
async function upsertFromEngage(req, res) {
  try {
    const push = engagePush(req);
    if (push.refusal) {
      const [code, error] = push.refusal;
      return res.status(400).json({ error, code });
    }
    const { engagementId, engagement, pushedAt } = push;

    const parent = await admitParent(engagement.projectId, { childId: push.trackingId });
    if (!parent) {
      return res.status(404).json({
        error: 'Parent project or notification not found', code: refusalCode(engagement.projectId)
      });
    }

    let written;
    try {
      written = await upsertWithRetry(
        commentPeriods,
        (current) => engageItem(push, parent, current),
        () => readTarget(push, parent.id),
        { pushedAt, pushedAtField: PUSHED_AT_FIELD }
      );
    } catch (err) {
      if (err.refusal !== TRACKING_ID_CLAIMED) throw err;
      logger.warn(`${LABEL} tracking id already tied to another engagement`,
        { engagementId, trackingId: push.trackingId, claimedBy: err.claimedBy, id: err.id });
      return res.status(409).json({
        error: 'body.engagement.trackingId names a period another engagement owns.',
        code: TRACKING_ID_CLAIMED
      });
    }

    if (written.status === 'conflict') {
      logger.warn(`${LABEL} engage push lost its etag race, asking for a retry`,
        { engagementId, projectId: parent.id });
      return res.status(503).json({ error: 'The record is being written by another request. Push it again.' });
    }
    if (written.ignored) return refuseStale(req, res, { engagementId, pushedAt, current: written.existing });

    const { saved, existing } = written;
    // Same partition move as the Eagle mirror: Cosmos leaves the old row behind.
    if (existing && String(existing.projectId) !== saved.projectId) {
      await commentPeriods.deleteById(existing.id, existing.projectId);
    }
    // Comments carry their own `read[]`, so a period that changed level re-derives them, as the mirror does.
    const moved = existing && levelOfRead(existing.read) !== levelOfRead(saved.read);
    const cascadeError = moved ? await cascadeToComments(saved) : null;

    auditEvent(req, {
      action: saved.isDeleted ? 'commentPeriod.delete' : 'commentPeriod.push',
      targetType: 'commentPeriod',
      targetId: saved.id,
      projectId: saved.projectId,
      detail: {
        sourceSystem: 'engage',
        engagementId,
        eagleId: saved.eagleId || null,
        adopted: Boolean(existing && existing.sourceSystem !== 'engage'),
        isPublishedFrom: existing ? existing.isPublished : null,
        isPublishedTo: saved.isPublished
      }
    });
    logger.info(`${LABEL} engage push written`,
      { id: saved.id, engagementId, projectId: saved.projectId, created: !existing, isDeleted: saved.isDeleted });

    const queued = await enqueueQuietly(saved);
    // The row is written and queued; only the comments under it lag behind its level.
    if (cascadeError) return res.status(500).json({ error: cascadeError, id: saved.id, queued });
    return res.status(existing ? 200 : 201).json({
      id: saved.id,
      engagementId,
      eagleId: saved.eagleId || null,
      engagePushedAt: saved.engagePushedAt,
      queued
    });
  } catch (err) {
    return mirrorError(res, err, 'engage comment period controller failed');
  }
}

module.exports = { upsertFromEngage };
