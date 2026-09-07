'use strict';

/**
 * Comment controller — the Eagle mirror for `Comment`, and the only writer of `comments`.
 *
 * A comment may never out-rank its period, which may never out-rank its project, so a comment under
 * an unpublished period is stored private however Eagle's own `eaoStatus` reads.
 *
 * The submitter's name is stored and withheld, never dropped: `author` is at level 2 with the
 * `commentAttributed` predicate (src/vis/catalog/comments.js), so staff keep the attribution the
 * EAO needs while the public sees it only on a comment that was not submitted anonymously. NO EMAIL
 * IS MIRRORED — the Eagle Comment model has none, and nothing here may add one.
 */

const comments = require('../../repositories/comments');
const commentPeriods = require('../../repositories/comment-periods');
const { constrainToProject } = require('../../repositories/documents');
const { seedAcl } = require('../../seed/transform');
const { systemAccess } = require('../../helpers/access-sql');
const { serverError } = require('../../helpers/response');
const { auditEvent } = require('../../utils/audit');
const { eaglePush, upsertWithRetry, refId } = require('./eagle-mirror');

function mirrorItem(eagleId, doc, period, read, existing) {
  return {
    id: eagleId,
    eagleId,
    periodId: String(period.id),
    // Carried from the period rather than the comment: it is the axis a scoped caller is confined
    // to, and an Eagle comment does not hold one.
    projectId: String(period.projectId),
    sourceSystem: 'eagle',

    author: doc.author || null,
    comment: doc.comment || null,
    dateAdded: doc.dateAdded || null,
    dateUpdated: doc.dateUpdated || null,
    // Free text the commenter typed, and public: it is in eagle-api's own ALLOWED_FIELDS and its
    // `publicGet` runs the query as `['public']` (api/controllers/comment.js:19,80).
    location: doc.location || null,
    submittedCAC: doc.submittedCAC === true,
    // `!== false`, matching the Eagle model's default of TRUE: a comment that never set the flag is
    // anonymous, and storing `undefined` would leave the redactor's predicate deciding on absence.
    isAnonymous: doc.isAnonymous !== false,
    documents: Array.isArray(doc.documents) ? doc.documents.map(String) : [],
    commentId: doc.commentId ?? null,
    eaoStatus: doc.eaoStatus || null,

    isPublished: read.includes('public'),
    read,
    sources: { ...(existing && existing.sources), eagle: doc }
  };
}

/**
 * Mirror one raw Eagle `Comment`, whoever asked — the push handler below or the backfill
 * (src/scripts/seed-public-reads.js). NULL when the parent period is not in DEMI.
 *
 * @param {object} [periodRow] the DEMI comment-period row, when the caller already holds it. The
 *   backfill walks period by period, so it passes one and saves a read per comment.
 * @returns {Promise<{saved: object, existing: object|null}|null>}
 */
async function mirrorFromEagle(eagleId, doc, periodRow) {
  const periodEagleId = refId(doc.period);
  const period = periodRow || (periodEagleId
    ? await commentPeriods.getById(systemAccess(), periodEagleId)
    : null);
  if (!period) return null;

  // The period's own ACL is already constrained to its project, so one constrain here carries
  // both ceilings.
  const read = constrainToProject(seedAcl(doc.read), period.read);

  const { saved, existing } = await upsertWithRetry(
    comments,
    (current) => mirrorItem(eagleId, doc, period, read, current),
    () => comments.getById(systemAccess(), eagleId)
  );

  // A comment moved to another period lands in a NEW partition; the old row would stay listable
  // under the old period. Same removal as the document mirror.
  if (existing && String(existing.periodId) !== saved.periodId) {
    await comments.deleteById(existing.id, existing.periodId);
  }

  return { saved, existing };
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
    if (!mirrored) return res.status(404).json({ error: 'Parent comment period not found' });
    const { saved, existing } = mirrored;

    auditEvent(req, {
      action: 'comment.push',
      targetType: 'comment',
      targetId: saved.id,
      projectId: saved.projectId,
      detail: {
        eagleId,
        periodId: saved.periodId,
        isPublishedFrom: existing ? existing.isPublished : null,
        isPublishedTo: saved.isPublished
      }
    });

    return res.json({ id: saved.id, action: 'upsert' });
  } catch (err) {
    return serverError(res, err, 'comment controller failed');
  }
};
