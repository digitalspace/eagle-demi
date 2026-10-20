'use strict';

/**
 * The Eagle mirror for `ProjectNotification`. No parent caps the read: `associatedProjectId` often
 * names a project that does not exist yet, so the row keeps its own `read[]`.
 */

const notifications = require('../../repositories/notifications');
const updates = require('../../repositories/updates');
const { eagleBaseAcl } = require('../../seed/transform');
const { serverError } = require('../../helpers/response');
const { auditEvent } = require('../../utils/audit');
const {
  eaglePush, upsertWithRetry, ignoreStalePush, pushConflict
} = require('./eagle-mirror');

const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** When Eagle created the row, from its ObjectId; Eagle's model has no date-added field. */
function createdAtOf(eagleId) {
  const id = String(eagleId);
  return OBJECT_ID.test(id) ? new Date(parseInt(id.slice(0, 8), 16) * 1000).toISOString() : null;
}

function mirrorItem(eagleId, doc, read, existing) {
  return {
    id: eagleId,
    eagleId,
    sourceSystem: 'eagle',

    name: doc.name || null,
    type: doc.type || null,
    subType: doc.subType || null,
    proponent: doc.proponent || null,
    nature: doc.nature || null,
    region: doc.region || null,
    location: doc.location || null,
    decision: doc.decision || null,
    decisionDate: doc.decisionDate || null,
    // Never null: the list sorts on it, and Cosmos cannot continue a page from a null sort value.
    notificationReceivedDate: doc.notificationReceivedDate ||
      (existing && existing.notificationReceivedDate) || createdAtOf(eagleId) || new Date().toISOString(),
    trigger: doc.trigger || null,
    description: doc.description || null,
    centroid: Array.isArray(doc.centroid) ? doc.centroid : [],
    notificationThresholdValue: doc.notificationThresholdValue ?? null,
    notificationThresholdUnits: doc.notificationThresholdUnits || null,
    associatedProjectId: doc.associatedProjectId || null,
    associatedProjectName: doc.associatedProjectName || null,

    pcp: doc.pcp || 'none',
    isMet: doc.isMet === true,
    metURL: doc.metURL || '',
    dateStarted: doc.dateStarted || null,
    dateCompleted: doc.dateCompleted || null,

    isPublished: read.includes('public'),
    read,
    sources: { ...(existing && existing.sources), eagle: doc }
  };
}

/**
 * Mirror one raw Eagle `ProjectNotification`, whoever asked — the push handler below or the
 * backfill (src/scripts/seed-public-reads.js). No parent, so nothing it can fail to resolve.
 *
 * @returns {Promise<{saved: object, existing: object|null}>}
 */
async function mirrorFromEagle(eagleId, doc, { pushedAt = null } = {}) {
  const read = eagleBaseAcl(doc.read);

  const written = await upsertWithRetry(
    notifications,
    (current) => mirrorItem(eagleId, doc, read, current),
    () => notifications.readForWrite(eagleId),
    { pushedAt }
  );
  // The Update parent gate caches every notification's read.
  updates.forgetParents();
  return written;
}

exports.mirrorFromEagle = mirrorFromEagle;

exports.upsertFromEagle = async (req, res) => {
  try {
    const push = eaglePush(req);
    if (!push) {
      return res.status(400).json({ error: 'body.doc._id must match the :eagleId in the path' });
    }
    const { eagleId, doc, pushedAt } = push;

    const written = await mirrorFromEagle(eagleId, doc, { pushedAt });
    if (written.status === 'conflict') {
      return pushConflict(res, { label: 'Notification Controller', eagleId });
    }
    const { saved, existing, ignored } = written;
    if (ignored) {
      return ignoreStalePush(req, res, {
        label: 'Notification Controller', action: 'notification.push',
        targetType: 'notification', current: existing, pushedAt
      });
    }

    auditEvent(req, {
      action: 'notification.push',
      targetType: 'notification',
      targetId: saved.id,
      detail: {
        eagleId,
        isPublishedFrom: existing ? existing.isPublished : null,
        isPublishedTo: saved.isPublished
      }
    });

    return res.json({ id: saved.id, action: 'upsert' });
  } catch (err) {
    return serverError(res, err, 'notification controller failed');
  }
};
