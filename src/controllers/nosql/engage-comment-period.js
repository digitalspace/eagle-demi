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
const { eagleReadUnder } = require('../../seed/transform');
const { DUPLICATE_ID } = require('../../helpers/duplicate-id');
const { serverError } = require('../../helpers/response');
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

// ENGAGE formats its dates as UTC wall time with no zone, 'YYYY-MM-DD HH:MM:SS'.
const ZONELESS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/** ISO UTC with a `Z`, null for no date, undefined when the value is not a date. Zone-less text is UTC. */
function utcIso(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  const ms = Date.parse(ZONELESS.test(text) ? `${text.replace(' ', 'T')}Z` : text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** `{ engagementId, engagement, pushedAt, trackingId, start, end }`, or `{ refusal: [code, message] }`. */
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
  const start = utcIso(engagement.start);
  const end = utcIso(engagement.end);
  if (start === undefined || end === undefined) {
    return { refusal: ['PUSHED_DATES_INVALID', 'body.engagement.start and end must be dates, UTC when they carry no zone'] };
  }
  // Without a URL the Eagle copy cannot be matched to this row, so only a draft or a delete may lack one.
  if (engagement.isPublished === true && engagement.isDeleted !== true && !engagement.metURL) {
    return { refusal: ['METURL_REQUIRED', 'body.engagement.metURL is required on a published engagement'] };
  }
  return { engagementId, engagement, pushedAt, trackingId, start, end };
}

/**
 * The row this engagement writes to: already tied to it (in any partition, so a project move finds
 * it), else the Eagle period it names, else its own.
 */
async function readTarget({ engagementId, trackingId }, projectId) {
  return await commentPeriods.readForWriteByEngagementId(engagementId, projectId)
    || (trackingId && await commentPeriods.readForWrite(trackingId, projectId))
    || await commentPeriods.readForWrite(engageRowId(engagementId), projectId);
}

/** The ENGAGE-owned fields written over `current`; everything Eagle owns rides through untouched. */
function engageItem({ engagementId, engagement, trackingId, start, end }, parent, current) {
  if (current && current.engagementId && String(current.engagementId) !== engagementId) {
    throw Object.assign(new Error('tracking id already tied to another engagement'),
      { refusal: TRACKING_ID_CLAIMED, claimedBy: String(current.engagementId), id: current.id });
  }
  const own = engagement.isPublished === true ? PUBLISHED_READ : UNPUBLISHED_READ;
  const capped = eagleReadUnder(own, parent.read);
  const isDeleted = engagement.isDeleted === true;
  const read = isDeleted ? constrainToProject(capped, DELETED_CEILING) : capped;
  const projectId = String(parent.id);
  const moved = Boolean(current) && String(current.projectId) !== projectId;

  return {
    ...current,
    id: current ? current.id : engageRowId(engagementId),
    projectId,
    // Names the partition a move leaves behind, so a failed delete there reads as a move, not a duplicate.
    ...(moved ? { movedFromProjectId: String(current.projectId) } : {}),
    // Every write raises it, even one that changes nothing sync-out sends: sync-out sends what it has not sent.
    syncVersion: (current && Number.isInteger(current.syncVersion) ? current.syncVersion : 0) + 1,
    dateAdded: (current && current.dateAdded) || new Date().toISOString(),
    sourceSystem: 'engage',
    engagementId,
    eagleProjectId: String(engagement.projectId),
    eagleId: (current && current.eagleId) || trackingId,
    isMet: true,
    metURL: engagement.metURL || '',
    metURLAdmin: engagement.metURLAdmin || '',
    // The field eagle-public and the Eagle mirror render the banner from.
    metBannerImageUrl: engagement.bannerUrl || '',
    informationLabel: engagement.name || '',
    instructions: engagement.description || '',
    dateStarted: start,
    dateCompleted: end,
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
    // Engagements under a notification still go to Eagle from ENGAGE directly.
    if (parent.kind === 'notification') {
      return res.status(422).json({
        error: 'Engagements under a project notification are not taken yet.', code: 'PARENT_KIND_UNSUPPORTED'
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
      return res.status(422).json({
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
    const queued = await enqueueQuietly(saved);
    // Same partition move as the Eagle mirror: Cosmos leaves the old row behind. The new row is marked,
    // so a copy this fails to remove reads as a half-finished move, not a duplicate.
    if (existing && String(existing.projectId) !== saved.projectId) {
      try {
        await commentPeriods.deleteById(existing.id, existing.projectId);
      } catch (err) {
        logger.error(`${LABEL} old partition copy not removed after a project move`,
          { id: saved.id, engagementId, from: existing.projectId, to: saved.projectId, error: err.message });
      }
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
    // 500, not the mirror's 409: ENGAGE reads a 409 as "already current" and stops.
    if (err && err.code === DUPLICATE_ID) {
      return res.status(500).json({ error: 'This engagement is stored more than once. Nothing was written.', code: DUPLICATE_ID });
    }
    return serverError(res, err, 'engage comment period controller failed');
  }
}

module.exports = { upsertFromEngage };
