'use strict';

/**
 * Project notification controller — the Eagle mirror for `ProjectNotification`, and the only writer
 * of `notifications`.
 *
 * No parent to constrain against: `associatedProjectId` points at a project that often does not
 * exist yet — that is the point of a notification — so the row keeps its own `read[]`.
 */

const notifications = require('../../repositories/notifications');
const { seedAcl } = require('../../seed/transform');
const { systemAccess } = require('../../helpers/access-sql');
const { serverError } = require('../../helpers/response');
const { auditEvent } = require('../../utils/audit');
const { eaglePush, upsertWithRetry } = require('./eagle-mirror');

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
    notificationReceivedDate: doc.notificationReceivedDate || null,
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

exports.upsertFromEagle = async (req, res) => {
  try {
    const push = eaglePush(req);
    if (!push) {
      return res.status(400).json({ error: 'body.doc._id must match the :eagleId in the path' });
    }
    const { eagleId, doc } = push;

    const read = seedAcl(doc.read);

    const { saved, existing } = await upsertWithRetry(
      notifications,
      (current) => mirrorItem(eagleId, doc, read, current),
      () => notifications.getById(systemAccess(), eagleId)
    );

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
