'use strict';

/**
 * The Eagle mirror for `ProjectNotification`. No parent caps the read: `associatedProjectId` often
 * names a project that does not exist yet, so the row keeps its own `read[]`.
 */

const notifications = require('../../repositories/notifications');
const updates = require('../../repositories/updates');
const { eagleBaseAcl } = require('../../seed/transform');
const { upsertKeepingDemiRows, pushHandler } = require('./eagle-mirror');

const { createdAtOf } = notifications;

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

/** Row for this push: by Eagle id, else a DEMI row sync-out sent under that id. */
async function readTarget(eagleId) {
  return await notifications.readForWrite(eagleId) || await notifications.readForWriteByEagleId(eagleId);
}

/**
 * Mirror one raw Eagle `ProjectNotification`, whoever asked — the push handler below or the
 * backfill (src/scripts/seed-public-reads.js). No parent, so nothing it can fail to resolve.
 * Throws `DUPLICATE_ID` when two DEMI rows name the Eagle id.
 *
 * @returns {Promise<{saved, existing}|{ignored, existing}|{status: 'conflict'}>}
 */
async function mirrorFromEagle(eagleId, doc, { pushedAt = null } = {}) {
  const read = eagleBaseAcl(doc.read);

  const written = await upsertKeepingDemiRows(notifications, eagleId, doc,
    (current) => mirrorItem(eagleId, doc, read, current),
    () => readTarget(eagleId), { pushedAt, label: 'Notification Controller' });
  // The Update parent gate caches every notification's read.
  updates.forgetParents();
  return written;
}

exports.mirrorFromEagle = mirrorFromEagle;

exports.upsertFromEagle = pushHandler({
  label: 'Notification Controller', action: 'notification.push', targetType: 'notification',
  mirror: mirrorFromEagle, failure: 'notification controller failed'
});
