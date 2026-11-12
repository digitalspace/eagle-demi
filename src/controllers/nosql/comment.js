'use strict';

/**
 * Eagle mirror for `Comment`, the only writer of `comments`; a comment never out-ranks its period.
 * `author` is stored and withheld by the catalog. No email is mirrored, and none may be added.
 */

const comments = require('../../repositories/comments');
const commentPeriods = require('../../repositories/comment-periods');
const { eagleReadUnder } = require('../../seed/transform');
const { systemAccess, canRead } = require('../../helpers/access-sql');
const { DUPLICATE_ID } = require('../../helpers/duplicate-id');
const { logger } = require('../../utils/logger');
const {
  eagleRef, badRefReason, classify, warnNotAdmitted, refusalCode
} = require('../../helpers/parent-admit');
const { upsertKeepingDemiRows, pushHandler } = require('./eagle-mirror');

/** Eagle's staff-side review fields. */
function staffFields(doc) {
  return {
    datePosted: doc.datePosted || null,
    eaoNotes: doc.eaoNotes || null,
    proponentNotes: doc.proponentNotes || null,
    proponentStatus: doc.proponentStatus || null,
    publishedNotes: doc.publishedNotes || null,
    rejectedNotes: doc.rejectedNotes || null,
    rejectedReason: doc.rejectedReason || null,
    valuedComponents: Array.isArray(doc.valuedComponents) ? doc.valuedComponents.map(String) : []
  };
}

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
    ...staffFields(doc),

    isPublished: read.includes('public'),
    read,
    sources: { ...(existing && existing.sources), eagle: doc }
  };
}

/** Sources whose periods are stored under their own id with the Eagle id in `eagleId`: `engage-<id>`, or a DEMI UUID. */
const OWNED_PERIOD_SOURCES = new Set(['engage', 'demi']);

/**
 * A period ENGAGE or DEMI created, found by its Eagle id. Held to the same system read as `getById`,
 * so a sealed or read-less period still refuses its comments.
 */
async function ownedPeriodByEagleId(eagleId, child) {
  let row;
  try {
    row = await commentPeriods.readForWriteByEagleId(eagleId);
  } catch (err) {
    if (err.code !== DUPLICATE_ID) throw err;
    logger.error('[Comment Controller] comment period Eagle id stored on more than one row',
      { eagleId, ...child, error: err.message });
    // Not the mirror's 409: a duplicate here is DEMI's fault, never a stale push.
    throw new Error(`comment period ${eagleId} is stored on more than one row`, { cause: err });
  }
  if (!row || !OWNED_PERIOD_SOURCES.has(row.sourceSystem)) return null;
  return canRead(row, systemAccess(), commentPeriods.PARTITION_FIELD) ? row : null;
}

/**
 * The DEMI period a comment hangs off, or null after one `parent not admitted` warn. A miss costs
 * one extra unfiltered read, made before the 404, to log `missing` or `hidden`.
 */
async function admitPeriod(ref, childId) {
  const child = { childId: eagleRef(childId) };
  const periodEagleId = eagleRef(ref);
  if (!periodEagleId) {
    warnNotAdmitted(child, { period: badRefReason(ref) });
    return null;
  }
  const period = await commentPeriods.getById(systemAccess(), periodEagleId, undefined, { includeDeleted: true })
    || await ownedPeriodByEagleId(periodEagleId, child);
  if (!period) {
    const reason = await classify(() => commentPeriods.readForWrite(periodEagleId), {
      eagleId: periodEagleId,
      container: commentPeriods.CONTAINER,
      partitionField: commentPeriods.PARTITION_FIELD
    });
    warnNotAdmitted({ eagleId: periodEagleId, ...child }, { period: reason });
  }
  return period;
}

/**
 * Mirror one raw Eagle `Comment` (push or backfill); null when its period is not in DEMI.
 * @param {object} [periodRow] the DEMI period row, when the caller holds it; saves a read each.
 * @returns {Promise<{saved: object, existing: object|null}|{ignored: string, existing: object}
 *   |null>}
 */
async function mirrorFromEagle(eagleId, doc, periodRow, { pushedAt = null } = {}) {
  const period = periodRow || await admitPeriod(doc.period, eagleId);
  if (!period) return null;

  // The period's own ACL is already constrained to its project, so one constrain here carries
  // both ceilings.
  const read = eagleReadUnder(doc.read, period.read);

  const written = await upsertKeepingDemiRows(comments, eagleId, doc,
    (current) => mirrorItem(eagleId, doc, period, read, current),
    // Else a DEMI row sync-out sent under the id.
    async () => await comments.readForWrite(eagleId, period.id) || await comments.readForWriteByEagleId(eagleId, period.id),
    // Eagle numbers every comment while eagle-api takes writes, so a DEMI row takes its number (sync-out/kinds.js).
    { pushedAt, label: 'Comment Controller', fromEagle: Number.isInteger(doc.commentId) ? { commentId: doc.commentId } : {} }
  );
  // Nothing was written, so the partition cleanup below has nothing to clean up after.
  if (written.status === 'conflict' || written.ignored) return written;
  const { saved, existing } = written;

  // A comment moved to another period lands in a NEW partition; the old row would stay listable
  // under the old period. Same removal as the document mirror.
  if (existing && String(existing.periodId) !== saved.periodId) {
    await comments.deleteById(existing.id, existing.periodId);
  }

  return { saved, existing };
}

exports.mirrorFromEagle = mirrorFromEagle;
exports.staffFields = staffFields;

exports.upsertFromEagle = pushHandler({
  label: 'Comment Controller', action: 'comment.push', targetType: 'comment', projectScoped: true,
  mirror: (eagleId, doc, options) => mirrorFromEagle(eagleId, doc, undefined, options),
  refuse: (mirrored, doc, res) => !mirrored
    && res.status(404).json({ error: 'Parent comment period not found', code: refusalCode(doc.period) }),
  detail: (saved, existing, eagleId) => ({
    eagleId,
    periodId: saved.periodId,
    isPublishedFrom: existing ? existing.isPublished : null,
    isPublishedTo: saved.isPublished
  }),
  failure: 'comment controller failed'
});
