'use strict';

/**
 * Comment period controller — the Eagle mirror for `CommentPeriod`, and the only writer of
 * `commentPeriods`.
 *
 * A period may never out-rank its project: `constrainToProject` takes the LOWER of the two levels,
 * so a period Eagle published under a project Eagle has taken down is stored private here. That is
 * the same rule `seed/transform.js` applies to documents, and it is what stops an unpublished
 * project's engagement tab from being readable through this container.
 */

const commentPeriods = require('../../repositories/comment-periods');
const projects = require('../../repositories/projects');
const { constrainToProject } = require('../../repositories/documents');
const { seedAcl } = require('../../seed/transform');
const { systemAccess } = require('../../helpers/access-sql');
const { serverError } = require('../../helpers/response');
const { auditEvent } = require('../../utils/audit');
const { eaglePush, upsertWithRetry, refId } = require('./eagle-mirror');

/** The mirror row: the fields eagle-public renders, plus the raw Eagle record behind them. */
function mirrorItem(eagleId, doc, projectId, read, existing) {
  return {
    id: eagleId,
    eagleId,
    // The DEMI project id, as `documents` stores it — not the Eagle one, so both project-partitioned
    // containers answer a scoped caller on the same value.
    projectId: String(projectId),
    sourceSystem: 'eagle',

    dateStarted: doc.dateStarted || null,
    dateCompleted: doc.dateCompleted || null,
    dateAdded: doc.dateAdded || null,
    isMet: doc.isMet === true,
    metURL: doc.metURL || '',
    informationLabel: doc.informationLabel || '',
    instructions: doc.instructions || '',
    openHouses: Array.isArray(doc.openHouses) ? doc.openHouses : [],
    relatedDocuments: Array.isArray(doc.relatedDocuments) ? doc.relatedDocuments : [],
    commentTip: doc.commentTip || '',

    // read[] is authoritative and isPublished mirrors it (ADR-004), as every other mirror does.
    isPublished: read.includes('public'),
    read,
    sources: { ...(existing && existing.sources), eagle: doc }
  };
}

/**
 * Mirror one raw Eagle `CommentPeriod`, whoever asked — the push handler below or the backfill
 * (src/scripts/seed-public-reads.js). NULL when the parent project is not in DEMI: a push answers
 * that with a 404, a backfill counts it and moves on.
 *
 * @param {object} [parentRow] the DEMI project row, when the caller already holds it
 * @returns {Promise<{saved: object, existing: object|null}|null>}
 */
async function mirrorFromEagle(eagleId, doc, parentRow) {
  // systemAccess on every read: the mirror must find a private parent and a private existing row.
  const parentEagleId = refId(doc.project);
  const parent = parentRow || (parentEagleId
    ? await projects.getByEagleId(systemAccess(), parentEagleId)
    : null);
  if (!parent) return null;

  const read = constrainToProject(seedAcl(doc.read), parent.read);

  const { saved, existing } = await upsertWithRetry(
    commentPeriods,
    (current) => mirrorItem(eagleId, doc, parent.id, read, current),
    () => commentPeriods.getById(systemAccess(), eagleId)
  );

  // A period whose project changed lands in a NEW partition, and Cosmos leaves the old row
  // behind — still listable under the old project. Same removal as the document mirror.
  if (existing && String(existing.projectId) !== saved.projectId) {
    await commentPeriods.deleteById(existing.id, existing.projectId);
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
    if (!mirrored) return res.status(404).json({ error: 'Parent project not found' });
    const { saved, existing } = mirrored;

    auditEvent(req, {
      action: 'commentPeriod.push',
      targetType: 'commentPeriod',
      targetId: saved.id,
      projectId: saved.projectId,
      detail: {
        eagleId,
        isPublishedFrom: existing ? existing.isPublished : null,
        isPublishedTo: saved.isPublished
      }
    });

    return res.json({ id: saved.id, action: 'upsert' });
  } catch (err) {
    return serverError(res, err, 'comment period controller failed');
  }
};
