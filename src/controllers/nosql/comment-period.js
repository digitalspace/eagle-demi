'use strict';

/**
 * Comment period controller — the Eagle mirror for `CommentPeriod`, and the only writer of
 * `commentPeriods`.
 *
 * A period may never out-rank its project: `constrainToProject` takes the LOWER of the two levels,
 * so a period Eagle published under a project Eagle has taken down is stored private here. That is
 * the same rule `seed/transform.js` applies to documents, and it is what stops an unpublished
 * project's engagement tab from being readable through this container.
 *
 * A PERIOD MAY ALSO HANG OFF A `ProjectNotification`. Eagle's `project` reference holds either id,
 * and a notification is not a project: it carries no ACL a child could out-rank, so such a period
 * keeps its own `read[]` verbatim and is partitioned under the notification's own id — the same
 * two rules `seed/transform.js` and the document mirror apply to a notification-parented document.
 * `helpers/parent-admit` is the one place that tells the two parents apart.
 *
 * A COMMENT FOLLOWS ITS PERIOD ONLY BECAUSE THIS WRITES IT DOWN. `/search?dataset=Comment` filters
 * on the comment's own stored `read[]` and never re-reads the period, so every level change here
 * is re-derived onto the comments below it. That is the opposite of a chunk, which is gated by a
 * live read of its parent document.
 *
 * A DELETE is a push like any other. eagle-api hard-deletes a period (`findOneAndDelete`), which
 * leaves nothing to re-read, so it pushes the record it just removed with `isDeleted: true`. DEMI
 * never hard-deletes it in return — the takedown convention is narrow and flag, so staff and the
 * reconcile still see what Eagle no longer holds. The row goes to level 2 with `isDeleted: true`,
 * and its comments follow.
 *
 * WHAT MAY UNDO THAT: only another eagle-api push of the same record. Nothing inside DEMI clears
 * the flag, and the project ACL cascade cannot republish the row past it — the raw Eagle copy
 * beside it still says `public`, so `helpers/acl-cascade` gates on the flag rather than on the
 * copy. Mongo does not reuse an ObjectId, so a later push under this id is Eagle holding a record
 * again, which is the one thing that should bring it back.
 */

const commentPeriods = require('../../repositories/comment-periods');
const comments = require('../../repositories/comments');
const { constrainToProject } = require('../../repositories/documents');
const { admitParent } = require('../../helpers/parent-admit');
const { seedAcl } = require('../../seed/transform');
const { systemAccess, levelOfRead } = require('../../helpers/access-sql');
// The widest a deleted period may be stored at, and the ceiling the cascade later re-derives it
// under: one value, so the two cannot drift apart.
const { DELETED_CEILING } = require('../../helpers/acl-cascade');
const { serverError } = require('../../helpers/response');
const { logger } = require('../../utils/logger');
const { auditEvent } = require('../../utils/audit');
const { eaglePush, upsertWithRetry } = require('./eagle-mirror');

/** The mirror row: the fields eagle-public renders, plus the raw Eagle record behind them. */
function mirrorItem(eagleId, doc, projectId, read, existing) {
  return {
    id: eagleId,
    eagleId,
    // The DEMI project id, as `documents` stores it — not the Eagle one, so both project-partitioned
    // containers answer a scoped caller on the same value. On a notification-parented period this
    // is the notification's OWN id, which is what `documents` partitions those under and what
    // eagle-public already sends as its `project` filter.
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

    // Eagle no longer holds this record. It is a fact about the row, not an ACL: `read` above is
    // what hides it, this is what says why, and it is what stops a cascade widening it again.
    isDeleted: doc.isDeleted === true,

    // read[] is authoritative and isPublished mirrors it (ADR-004), as every other mirror does.
    isPublished: read.includes('public'),
    read,
    sources: { ...(existing && existing.sources), eagle: doc }
  };
}

/**
 * Mirror one raw Eagle `CommentPeriod`, whoever asked — the push handler below or the backfill
 * (src/scripts/seed-public-reads.js). NULL when the parent is in neither container: a push answers
 * that with a 404, a backfill counts it and moves on.
 *
 * @param {object} [parentRow] the admitted parent, when the caller already holds it — the shape
 *   `helpers/parent-admit` returns. A row without `kind` is read as a project, which is what every
 *   stored project row is.
 * @returns {Promise<{saved: object, existing: object|null, cascadeError: string|null}|null>}
 */
async function mirrorFromEagle(eagleId, doc, parentRow) {
  const parent = parentRow || await admitParent(doc.project);
  if (!parent) return null;

  // A notification carries no ACL a period could out-rank, so there is nothing to narrow against
  // and the period keeps what Eagle published it as.
  const own = seedAcl(doc.read);
  const constrained = parent.kind === 'notification'
    ? own
    : constrainToProject(own, parent.read);
  // Both ceilings, lower wins: the parent's, and level 2 once Eagle has deleted the record.
  const read = doc.isDeleted === true
    ? constrainToProject(constrained, DELETED_CEILING)
    : constrained;

  const { saved, existing } = await upsertWithRetry(
    commentPeriods,
    (current) => mirrorItem(eagleId, doc, parent.id, read, current),
    () => commentPeriods.getById(systemAccess(), eagleId)
  );

  // A period whose parent changed lands in a NEW partition, and Cosmos leaves the old row
  // behind — still listable under the old parent. Same removal as the document mirror.
  if (existing && String(existing.projectId) !== saved.projectId) {
    await commentPeriods.deleteById(existing.id, existing.projectId);
  }

  // WHENEVER THE LEVEL MOVED, not only on a delete. A comment is gated by its own stored `read[]`
  // and nothing re-reads its period at query time — unlike a chunk, which derives from its parent
  // document in the search branch — so a period Eagle unpublished leaves every comment under it
  // readable until they are re-derived here.
  const moved = !existing || levelOfRead(existing.read) !== levelOfRead(saved.read);
  const cascadeError = moved ? await cascadeToComments(saved) : null;

  return { saved, existing, cascadeError };
}

/**
 * Re-derive the comments of one period from the period's new ACL.
 *
 * The same derivation a project publish runs, one level down: `deriveAcls` takes the lower of each
 * comment's own upstream ACL and the ceiling passed in, so it narrows on an unpublish and restores
 * on a re-publish without ever widening a comment Eagle itself kept private.
 *
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

exports.upsertFromEagle = async (req, res) => {
  try {
    const push = eaglePush(req);
    if (!push) {
      return res.status(400).json({ error: 'body.doc._id must match the :eagleId in the path' });
    }
    const { eagleId, doc } = push;

    const mirrored = await mirrorFromEagle(eagleId, doc);
    if (!mirrored) return res.status(404).json({ error: 'Parent project not found' });
    const { saved, existing, cascadeError } = mirrored;

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
    return serverError(res, err, 'comment period controller failed');
  }
};
