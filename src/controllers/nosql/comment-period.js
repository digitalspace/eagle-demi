'use strict';

// The Eagle echo path for `CommentPeriod`. A period never out-ranks its project
// (`constrainToProject` keeps the lower level), so an unpublished project hides its periods.

// A `ProjectNotification` parent has no ACL to out-rank: the period keeps its own `read[]` minus
// compliance, partitioned under the notification id. `helpers/parent-admit` tells the parents apart.

// Comments are gated on their own stored `read[]`, never on the period's, so every level change
// here is re-derived onto them.

// Eagle sends a hard delete as a push with `isDeleted: true`; DEMI flags it and narrows to level 2.
// Only a later push of the same id clears the flag: Mongo never reuses an ObjectId.

// A row ENGAGE or DEMI owns takes only the Eagle id, raw copy and staff fields its owner does not
// write (`KEPT_FROM_ECHO`): an Eagle push is often the echo of what DEMI sent.

const commentPeriods = require('../../repositories/comment-periods');
const comments = require('../../repositories/comments');
// The widest a deleted period may be stored at, and the ceiling the cascade later re-derives it
// under: one value, so the two cannot drift apart.
const { constrainToProject, DELETED_CEILING } = require('../../repositories/documents');
const { admitParent, refusalCode } = require('../../helpers/parent-admit');
const { eagleBaseAcl, eagleReadUnder } = require('../../seed/transform');
const { systemAccess, sameAccess } = require('../../helpers/access-sql');
const { mirrorError } = require('../../helpers/duplicate-id');
const { logger } = require('../../utils/logger');
const { auditEvent } = require('../../utils/audit');
const {
  eaglePush, upsertWithRetry, ignoreStalePush, pushConflict
} = require('./eagle-mirror');

/** Staff fields an Eagle echo leaves alone, by the `sourceSystem` that writes them. */
const KEPT_FROM_ECHO = Object.freeze({
  engage: ['metURLAdmin'],
  demi: ['metURLAdmin', 'commentIdCount', 'milestone', 'dateUpdated']
});
const ownedElsewhere = (row) => Boolean(row) && Object.hasOwn(KEPT_FROM_ECHO, row.sourceSystem);

/** Eagle's staff-side period fields. Also what src/scripts/backfill-eagle-staff-fields.js copies. */
function staffFields(doc) {
  const list = (v) => (Array.isArray(v) ? v : []);
  return {
    ceaaAdditionalText: doc.ceaaAdditionalText || '',
    ceaaInformationLabel: doc.ceaaInformationLabel || '',
    ceaaRelatedDocuments: doc.ceaaRelatedDocuments || '',
    classificationRoles: list(doc.classificationRoles),
    classifiedPercent: doc.classifiedPercent ?? null,
    commenterRoles: list(doc.commenterRoles),
    commentIdCount: doc.commentIdCount ?? null,
    dateCompletedEst: doc.dateCompletedEst || null,
    dateStartedEst: doc.dateStartedEst || null,
    dateUpdated: doc.dateUpdated || null,
    downloadRoles: list(doc.downloadRoles),
    isClassified: doc.isClassified ?? null,
    isResolved: doc.isResolved ?? null,
    isVetted: doc.isVetted || '',
    metURLAdmin: doc.metURLAdmin || '',
    milestone: doc.milestone ? String(doc.milestone) : null,
    periodType: doc.periodType || '',
    phase: doc.phase || '',
    phaseName: doc.phaseName || '',
    publishedPercent: doc.publishedPercent ?? null,
    rangeOption: doc.rangeOption || '',
    rangeType: doc.rangeType || '',
    resolvedPercent: doc.resolvedPercent ?? null,
    userCan: doc.userCan || '',
    vettedPercent: doc.vettedPercent ?? null,
    vettingRoles: list(doc.vettingRoles)
  };
}

/** The mirror row: the fields eagle-public renders, plus the raw Eagle record behind them. */
function mirrorItem(eagleId, doc, projectId, read, existing) {
  return {
    id: eagleId,
    eagleId,
    // DEMI project id (or a notification parent's own id), as `documents` partitions, so both
    // containers answer a scoped caller on the value eagle-public sends as `project`.
    projectId: String(projectId),
    sourceSystem: 'eagle',

    dateStarted: doc.dateStarted || null,
    dateCompleted: doc.dateCompleted || null,
    dateAdded: doc.dateAdded || null,
    isMet: doc.isMet === true,
    metURL: doc.metURL || '',
    // The Engage banner the project overview renders beside `metURL`. Without it the callout has
    // no image at all.
    metBannerImageUrl: doc.metBannerImageUrl || '',
    informationLabel: doc.informationLabel || '',
    instructions: doc.instructions || '',
    // What eagle-public's comment period card and comments page render as the period's blurb.
    additionalText: doc.additionalText || '',
    openHouses: Array.isArray(doc.openHouses) ? doc.openHouses : [],
    relatedDocuments: Array.isArray(doc.relatedDocuments) ? doc.relatedDocuments : [],
    commentTip: doc.commentTip || '',
    ...staffFields(doc),

    // Flag, never remove: staff and reconcile still see what Eagle dropped. `helpers/acl-cascade`
    // checks this flag, not the raw copy, because the Eagle copy still says public.
    isDeleted: doc.isDeleted === true,

    // read[] is authoritative and isPublished mirrors it (ADR-004), as every other mirror does.
    isPublished: read.includes('public'),
    read,
    sources: { ...(existing && existing.sources), eagle: doc }
  };
}

/** The Eagle echo applied to a row ENGAGE or DEMI owns. */
function eagleOwnedOnto(current, eagleId, doc) {
  // Delete of an old Eagle id that sync-out dropped to recreate the period under a new project:
  // the row stays tied to its new id.
  if (doc.isDeleted === true && current.eagleId !== eagleId) return current;
  const staff = staffFields(doc);
  for (const field of KEPT_FROM_ECHO[current.sourceSystem]) delete staff[field];
  return { ...current, ...staff, eagleId, sources: { ...current.sources, eagle: doc } };
}

/**
 * Row for this push: by Eagle id, else an ENGAGE or DEMI row tied to it in any partition, else an
 * unclaimed ENGAGE row on the same URL. A delete never claims a row by URL.
 */
async function readTarget(eagleId, doc, projectId) {
  return await commentPeriods.readForWrite(eagleId, projectId)
    || await commentPeriods.readForWriteByEagleId(eagleId, projectId)
    || (doc.isDeleted !== true && await commentPeriods.readForWriteEngageByMetUrl(doc.metURL, projectId))
    || null;
}

/**
 * Mirror one raw Eagle `CommentPeriod` for the push handler or src/scripts/seed-public-reads.js; null
 * when the parent is missing (push answers 404, backfill counts it). `ignored` (stale, dropped-by-sync-out) wrote nothing.
 * @param {object} [parentRow] the admitted parent from `helpers/parent-admit`; no `kind` = project
 * @returns {Promise<{saved, existing, cascadeError}|{ignored, existing}|null>}
 */
async function mirrorFromEagle(eagleId, doc, parentRow, { pushedAt = null } = {}) {
  const parent = parentRow || await admitParent(doc.project, { childId: eagleId });
  if (!parent) return null;

  // A notification carries no ACL a period could out-rank, so there is nothing to narrow against
  // and the period keeps what Eagle published it as.
  const constrained = parent.kind === 'notification' ? eagleBaseAcl(doc.read) : eagleReadUnder(doc.read, parent.read);
  // Both ceilings, lower wins: the parent's, and level 2 once Eagle has deleted the record.
  const read = doc.isDeleted === true
    ? constrainToProject(constrained, DELETED_CEILING)
    : constrained;

  // An unknown delete is tombstoned, so a create that arrives after it lands staff-only, not live. The
  // one exception is the echo of sync-out deleting the old Eagle period of an ENGAGE project move.
  if (doc.isDeleted === true && !await readTarget(eagleId, doc, parent.id)) {
    const mover = await commentPeriods.readForWriteEngageByDroppedEagleId(eagleId);
    if (mover) {
      logger.info('[Comment Period Controller] eagle delete of a period sync-out dropped in a project move, ignored',
        { eagleId, projectId: parent.id, rowId: mover.id });
      return { ignored: 'dropped-by-sync-out', existing: null };
    }
    logger.info('[Comment Period Controller] eagle delete for a period DEMI does not hold, tombstoned',
      { eagleId, projectId: parent.id });
  }

  const written = await upsertWithRetry(
    commentPeriods,
    (current) => (ownedElsewhere(current)
      ? eagleOwnedOnto(current, eagleId, doc)
      : mirrorItem(eagleId, doc, parent.id, read, current)),
    () => readTarget(eagleId, doc, parent.id),
    { pushedAt }
  );
  // Nothing was written, so neither the partition cleanup nor the cascade below has anything to
  // answer for — the newer push settled both, or no write landed at all.
  if (written.status === 'conflict' || written.ignored) return written;
  const { saved, existing } = written;
  if (ownedElsewhere(existing)) {
    logger.info('[Comment Period Controller] eagle push kept to Eagle fields on a row it does not own',
      { eagleId, id: saved.id, projectId: saved.projectId, sourceSystem: existing.sourceSystem });
  }

  // A period whose parent changed lands in a NEW partition, and Cosmos leaves the old row
  // behind — still listable under the old parent. Same removal as the document mirror.
  if (existing && String(existing.projectId) !== saved.projectId) {
    await commentPeriods.deleteById(existing.id, existing.projectId);
  }

  // Any read change, not only a delete: nothing re-reads the period at query time, so its
  // comments stay readable until re-derived here.
  const moved = !existing || !sameAccess(existing.read, saved.read);
  const cascadeError = moved ? await cascadeToComments(saved) : null;

  return { saved, existing, cascadeError };
}

/**
 * Re-derive one period's comments from its new ACL: the lower of each comment's own ACL and the
 * period's, so it narrows and restores but never widens a comment Eagle kept private.
 * @returns {Promise<string|null>} an error message the caller must 500 with, or null
 */
async function cascadeToComments(period) {
  const counts = { periodId: period.id, projectId: period.projectId };
  try {
    const cascade = await comments.setAclForPeriod(systemAccess(), period.id, period.read);
    if (cascade.failed > 0) {
      logger.error('[Comment Period Controller] comment ACL cascade partially failed',
        { ...counts, comments: cascade.succeeded, commentsFailed: cascade.failed });
      return 'Comment period mirrored, but its comments were not fully updated.';
    }
    logger.info('[Comment Period Controller] comment ACL cascade',
      { ...counts, comments: cascade.succeeded });
    return null;
  } catch (cascadeErr) {
    logger.error('[Comment Period Controller] comment ACL cascade failed',
      { ...counts, error: cascadeErr.message });
    return 'Comment period mirrored, but its comments were not updated.';
  }
}

exports.mirrorFromEagle = mirrorFromEagle;
exports.cascadeToComments = cascadeToComments;
exports.staffFields = staffFields;

exports.upsertFromEagle = async (req, res) => {
  try {
    const push = eaglePush(req);
    if (!push) {
      return res.status(400).json({ error: 'body.doc._id must match the :eagleId in the path' });
    }
    const { eagleId, doc, pushedAt } = push;

    const mirrored = await mirrorFromEagle(eagleId, doc, undefined, { pushedAt });
    if (!mirrored) {
      return res.status(404).json({
        error: 'Parent project or notification not found', code: refusalCode(doc.project)
      });
    }
    if (mirrored.status === 'conflict') {
      return pushConflict(res, { label: 'Comment Period Controller', eagleId });
    }
    const { saved, existing, cascadeError, ignored } = mirrored;
    if (ignored === 'dropped-by-sync-out') return res.json({ id: eagleId, action: 'ignored' });
    if (ignored) {
      return ignoreStalePush(req, res, {
        label: 'Comment Period Controller', action: 'commentPeriod.push',
        targetType: 'commentPeriod',
        current: existing, projectId: existing.projectId, pushedAt
      });
    }

    auditEvent(req, {
      action: saved.isDeleted ? 'commentPeriod.delete' : 'commentPeriod.push',
      targetType: 'commentPeriod',
      targetId: saved.id,
      projectId: saved.projectId,
      detail: {
        eagleId,
        isPublishedFrom: existing ? existing.isPublished : null,
        isPublishedTo: saved.isPublished
      }
    });

    // The row is already narrowed; what failed is the comments under it. eagle-api does not await
    // this push, so the 500 is for the log and the reconcile, not for a retry.
    if (cascadeError) return res.status(500).json({ error: cascadeError });

    return res.json({ id: saved.id, action: saved.isDeleted ? 'delete' : 'upsert' });
  } catch (err) {
    return mirrorError(res, err, 'comment period controller failed');
  }
};
