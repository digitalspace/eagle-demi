'use strict';

/**
 * Update controller — the Eagle mirror for `RecentActivity`, and the only writer of `updates`.
 *
 * DEMI owns Updates, so the publish transition is DEMI's to announce: eagle-notify is told once
 * per publication, and told again when a published update is withdrawn. `notifiedAt` is the claim
 * that makes "once" true across concurrent pushes — see repositories/updates.js.
 */

const updates = require('../../repositories/updates');
const projects = require('../../repositories/projects');
const { systemAccess } = require('../../helpers/access-sql');
const { serverError } = require('../../helpers/response');
const { logger } = require('../../utils/logger');
const { auditEvent } = require('../../utils/audit');
const notify = require('../../services/notify');

/**
 * Tell eagle-notify what changed, if anything did.
 *
 * Never throws and never fails the push: a mirrored record is worth keeping even when the
 * notification does not land, and a failed send leaves the claim in the state the next push
 * retries from — released for a publication, still held for a cancellation.
 */
async function announce(item, existing) {
  // Not configured: claim NOTHING. A claim taken while dark would suppress the first real
  // notification once the environment is wired up.
  if (!notify.configured()) return;

  try {
    if (item.isPublished) {
      const claimed = await updates.claimForNotify(item.id, new Date().toISOString());
      if (!claimed) return;

      const project = item.projectId
        ? await projects.getByEagleId(systemAccess(), item.projectId)
        : null;
      const pushed = await notify.updatePublished(item, project ? project.name : null);
      if (!pushed) await updates.releaseNotify(item.id);
      return;
    }

    if (existing && existing.notifiedAt) {
      // Release only once the cancellation is out. Keeping the claim on a failed send is what makes
      // the next unpublish push try again.
      const sent = await notify.updateCancelled(item);
      if (sent) await updates.releaseNotify(item.id);
    }
  } catch (err) {
    logger.error('[Update Controller] notify failed', {
      id: item.id, error: err.message, stack: err.stack
    });
  }
}

/** The mirror row: the raw Eagle record, plus what DEMI already holds about it. */
function mirrorItem(eagleId, doc, existing) {
  const read = Array.isArray(doc.read) ? doc.read : null;
  return {
    id: eagleId,
    eagleId,
    projectId: doc.project ? String(doc.project) : null,
    headline: doc.headline,
    content: doc.content,
    type: doc.type,
    pinned: doc.pinned,
    dateAdded: doc.dateAdded,
    dateUpdated: doc.dateUpdated,
    // read[] is authoritative and isPublished mirrors it (ADR-004), as the project and document
    // mirrors do. `active` is the fallback for a record pushed without an ACL.
    isPublished: read ? read.includes('public') : doc.active === true,
    read: doc.read,
    // A Cosmos write REPLACES the item, so the claim has to be carried across or every push of
    // a published update notifies again.
    notifiedAt: (existing && existing.notifiedAt) || null,
    sources: { ...(existing && existing.sources), eagle: doc }
  };
}

/** 409 (created behind us) and 412 (etag moved) both mean: somebody else wrote this row. */
const raced = (err) => [409, 412].includes(err.code || err.statusCode);

/**
 * Receive one Update pushed by eagle-api, keyed by its Eagle `_id`.
 *
 * The body carries the RAW Eagle record, exactly as the project and document mirrors do.
 */
exports.upsertFromEagle = async (req, res) => {
  try {
    const eagleId = String(req.params.eagleId);
    const doc = req.body && req.body.doc;
    if (!doc || String(doc._id || '') !== eagleId) {
      return res.status(400).json({ error: 'body.doc._id must match the :eagleId in the path' });
    }

    // systemAccess: the mirror must find a row it is about to republish while that row is private.
    let existing = await updates.getById(systemAccess(), eagleId);

    let saved;
    try {
      saved = await updates.upsert(mirrorItem(eagleId, doc, existing), existing);
    } catch (err) {
      // The row moved between the read and the write, so the `notifiedAt` carried above is stale
      // and writing it would hand back a claim another push is holding. Re-read, write again.
      if (!raced(err)) throw err;
      existing = await updates.getById(systemAccess(), eagleId);
      saved = await updates.upsert(mirrorItem(eagleId, doc, existing), existing);
    }

    auditEvent(req, {
      action: 'update.push',
      targetType: 'update',
      targetId: saved.id,
      projectId: saved.projectId,
      detail: {
        eagleId,
        isPublishedFrom: existing ? existing.isPublished : null,
        isPublishedTo: saved.isPublished
      }
    });

    await announce(saved, existing);

    return res.json({ id: saved.id, action: 'upsert' });
  } catch (err) {
    return serverError(res, err, 'update controller failed');
  }
};
