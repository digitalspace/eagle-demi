'use strict';

/**
 * Update controller — the Eagle mirror for `RecentActivity`, and the only writer of `updates`.
 *
 * DEMI owns Updates, so the publish transition is DEMI's to announce: eagle-notify is told once
 * per update, and told again when an update DEMI announced is withdrawn. `notifiedAt` is the claim
 * that makes "once" true across concurrent pushes and timer runs — see repositories/updates.js.
 */

const updates = require('../../repositories/updates');
const projects = require('../../repositories/projects');
const notifications = require('../../repositories/notifications');
const { pickParent } = require('../../helpers/parent-admit');
const { resolveAccess, systemAccess } = require('../../helpers/access-sql');
const { serverError } = require('../../helpers/response');
const { logger } = require('../../utils/logger');
const { auditEvent } = require('../../utils/audit');
const notify = require('../../services/notify');
const documents = require('../../repositories/documents');
const { toIsoOrNull } = require('../../seed/transform');
const { plainTextOf } = require('../../helpers/html-entities');
const {
  eaglePush, refId, upsertWithRetry, ignoreStalePush, pushConflict
} = require('./eagle-mirror');

/** The project or notification an update announces, by name, for the email's label. */
async function parentName(item) {
  if (!item.projectId) return null;
  // Same precedence as every other parent lookup: an update whose `projectId` is really a
  // `ProjectNotification` id must be labelled with the notification, not with the Track project
  // that happens to carry that id in `eagleId`.
  const [project, notification] = await Promise.all([
    projects.getByEagleId(systemAccess(), item.projectId),
    notifications.getById(systemAccess(), item.projectId)
  ]);
  const parent = pickParent(project, notification);
  const named = parent && parent.kind === 'notification' ? notification : project;
  return named ? named.name : null;
}

/**
 * The featured image, only when anyone may fetch it: the email links DEMI's download route, which
 * serves public documents alone. The document id is the Eagle `_id`, as in `featuredImage.document`.
 */
async function publicImage(item) {
  const image = item.featuredImage;
  if (!image || !image.document) return null;
  // An anonymous caller's read, the same predicate the download route applies to the email reader.
  return (await documents.getById(resolveAccess({}), image.document)) ? image : null;
}

/**
 * Did DEMI claim this update's email? A claim whose send got no answer may still have gone out, so
 * any DEMI claim is cancelled. A claim with no marker predates the bookkeeping and counts as a
 * backfill: nothing to cancel.
 */
function announcedByDemi(row) {
  return Boolean(row) && row.notifiedBy === updates.NOTIFIED_BY.DEMI;
}

/**
 * Send a claimed row and record the outcome. A refusal (4xx) keeps the claim and is never retried;
 * a send with no answer keeps it too, and the timer takes the lease over once it runs out.
 */
async function sendClaimed(claimed, now) {
  const outcome = await notify.updatePublished(claimed, await parentName(claimed), await publicImage(claimed));
  if (outcome === notify.OUTCOME.SENT) {
    await updates.markNotify(claimed.id, 'notifySentAt', now);
  } else if (outcome === notify.OUTCOME.REJECTED) {
    await updates.markNotify(claimed.id, 'notifyFailedAt', now);
  } else if (claimed.notifyAttempts >= updates.NOTIFY_MAX_ATTEMPTS) {
    logger.error('[Update Controller] notify gave up', { id: claimed.id, attempts: claimed.notifyAttempts });
  }
}

/**
 * Tell eagle-notify what changed, if anything did. Never throws and never fails the push: a
 * mirrored record is worth keeping even when the notification does not land.
 *
 * Moving `publishDate` into the future after the email went out sends nothing: no cancellation,
 * and no second email once the new date passes.
 */
async function announce(item, existing, now = new Date().toISOString()) {
  // Not configured: claim NOTHING. A claim taken while dark would suppress the first real
  // notification once the environment is wired up.
  if (!notify.configured()) return;

  try {
    if (item.isPublished) {
      // Not due yet: src/scripts/announce-updates.js announces it once its publishDate passes.
      if (!updates.isLive(item, null, now)) return;
      const claimed = await updates.claimForNotify(item.id, now);
      if (claimed) await sendClaimed(claimed, now);
      return;
    }

    // Once per withdrawal of a DEMI announcement. The claim stays: re-publishing never emails again.
    // A send with no answer stays unmarked for the timer to retry; a refusal is final, like a send's.
    if (announcedByDemi(existing) && !existing.notifyCancelledAt) {
      const outcome = await notify.updateCancelled(item);
      if (outcome !== notify.OUTCOME.FAILED) await updates.markNotify(item.id, 'notifyCancelledAt', now);
    }
  } catch (err) {
    logger.error('[Update Controller] notify failed', {
      id: item.id, error: err.message, stack: err.stack
    });
  }
}

/** The send bookkeeping, carried across a whole-item write. `incr` needs a number to start from. */
function notifyState(existing) {
  const state = {};
  for (const field of updates.NOTIFY_STATE_FIELDS) {
    state[field] = existing && existing[field] !== undefined ? existing[field] : null;
  }
  state.notifyAttempts = state.notifyAttempts || 0;
  return state;
}

// The limits the Update form enforces, held here too so a direct push cannot exceed them.
const MAX_IMAGES = 5;
const CAPTION_CHARS = 300;
const CREDIT_CHARS = 150;

/** An image reference. Its text is rendered on a public page, so markup is stripped here, the one writer. */
function imageOf(image) {
  return {
    document: refId(image.document),
    alt: plainTextOf(image.alt),
    caption: plainTextOf(image.caption).slice(0, CAPTION_CHARS) || null,
    credit: plainTextOf(image.credit).slice(0, CREDIT_CHARS) || null
  };
}

/** The gallery, in display order; an entry with no document has nothing to show and is dropped. */
function imagesOf(images) {
  if (!Array.isArray(images)) return [];
  return images.filter(image => image && image.document).slice(0, MAX_IMAGES).map(imageOf);
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
    // The rest of what eagle-public's News model reads. `pcp` and `projectNotification` arrive as
    // bare Mongo references — eagle-api populates them only in its own aggregate — so they are
    // stored as ids and resolved, if ever, by the reader.
    notificationName: doc.notificationName || null,
    contentUrl: doc.contentUrl || null,
    documentUrl: doc.documentUrl || null,
    pcp: refId(doc.pcp),
    projectNotification: refId(doc.projectNotification),
    // The Updates fields (PUBLIC-159). Stored as sent, except image text, stored as plain text; the
    // `shortHeadline`/`summary` fallbacks are the reader's, so an edit to `headline` or `content`
    // never leaves a stale copy here.
    category: doc.category || null,
    subject: doc.subject || null,
    shortHeadline: doc.shortHeadline || null,
    summary: doc.summary || null,
    featuredImage: doc.featuredImage && doc.featuredImage.document ? imageOf(doc.featuredImage) : null,
    images: imagesOf(doc.images),
    attachments: Array.isArray(doc.attachments) ? doc.attachments.map(refId).filter(Boolean) : [],
    regions: Array.isArray(doc.regions) ? doc.regions.map(String) : [],
    location: doc.location || null,
    // Rendered as a link on a public page, so anything but http(s) is dropped here too.
    engagementUrl: /^https?:\/\//i.test(doc.engagementUrl || '') ? doc.engagementUrl : null,
    status: doc.status || null,
    // Normalised to ISO text: the publish gate compares it as a string, and the index as a date.
    // Never absent: the gate and every sort on it read `publishDate` alone.
    publishDate: toIsoOrNull(doc.publishDate) || toIsoOrNull(doc.dateAdded),
    // Stored beside `isPublished` rather than folded into it: `read[]` is what governs visibility
    // and `active` is Eagle's own flag, which the News model renders.
    active: doc.active === true,
    // read[] is authoritative and isPublished mirrors it (ADR-004), as the project and document
    // mirrors do. `active` is the fallback for a record pushed without an ACL.
    isPublished: read ? read.includes('public') : doc.active === true,
    read: doc.read,
    // A Cosmos write REPLACES the item, so the claim has to be carried across or every push of
    // a published update notifies again. Eagle's own `notifiedAt` (set by its backfill on old rows)
    // seeds an empty claim, so an update Eagle already announced is never announced again.
    notifiedAt: (existing && existing.notifiedAt) || toIsoOrNull(doc.notifiedAt),
    // Who holds the claim, carried with it. DEMI cancels only what it sent itself.
    notifiedBy: existing && existing.notifiedAt
      ? existing.notifiedBy || null
      : (toIsoOrNull(doc.notifiedAt) ? updates.NOTIFIED_BY.EAGLE : null),
    ...notifyState(existing),
    sources: { ...(existing && existing.sources), eagle: doc }
  };
}

/**
 * Mirror one raw Eagle `RecentActivity`, whoever asked — the push handler below or the backfill
 * (src/scripts/seed-public-reads.js). It does NOT announce: `announce` is the push handler's,
 * because a backfill is history rather than news.
 *
 * The rebuild `upsertWithRetry` does after a lost race is what keeps `notifiedAt` honest: carried
 * from a stale read it would hand back a claim another push is holding.
 *
 * @returns {Promise<{saved: object, existing: object|null}|{ignored: string, existing: object}>}
 */
function mirrorFromEagle(eagleId, doc, { pushedAt = null } = {}) {
  return upsertWithRetry(
    updates,
    (current) => mirrorItem(eagleId, doc, current),
    // Unfiltered: a row with no `read` or a compartment token is still there to be replaced.
    () => updates.readForWrite(eagleId),
    { pushedAt }
  );
}

exports.mirrorFromEagle = mirrorFromEagle;
// The scheduled announce (src/scripts/announce-updates.js) goes through the same claim.
exports.announce = announce;

/**
 * Receive one Update pushed by eagle-api, keyed by its Eagle `_id`.
 *
 * The body carries the RAW Eagle record, exactly as the project and document mirrors do.
 */
exports.upsertFromEagle = async (req, res) => {
  try {
    const push = eaglePush(req);
    if (!push) {
      return res.status(400).json({ error: 'body.doc._id must match the :eagleId in the path' });
    }
    const { eagleId, doc, pushedAt } = push;

    const written = await mirrorFromEagle(eagleId, doc, { pushedAt });
    if (written.status === 'conflict') {
      return pushConflict(res, { label: 'Update Controller', eagleId });
    }
    const { saved, existing, ignored } = written;
    // Nothing was written, so there is nothing to announce either — the newer push already did.
    if (ignored) {
      return ignoreStalePush(req, res, {
        label: 'Update Controller', action: 'update.push', targetType: 'update',
        current: existing, projectId: existing.projectId, pushedAt
      });
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
