'use strict';

const updates = require('../repositories/updates');
const { readParent, isPublicParent } = require('../helpers/update-parent');
const { resolveAccess } = require('../helpers/access-sql');
const { logger } = require('../utils/logger');
const notify = require('../services/notify');
const documents = require('../repositories/documents');

const EMAIL_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif']);
const EMAIL_IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif']);

/**
 * The featured image, only when public (the email links the public download route) and a type every
 * mail client renders: classic Outlook breaks on WebP. The extension stands in for a missing MIME type.
 */
async function publicImage(item) {
  const image = item.featuredImage;
  if (!image || !image.document) return null;
  // An anonymous caller's read, the same predicate the download route applies to the email reader.
  const doc = await documents.getById(resolveAccess({}), image.document);
  if (!doc) return null;
  const mime = String(doc.mimeType || '').toLowerCase();
  if (mime ? EMAIL_IMAGE_MIMES.has(mime) : EMAIL_IMAGE_EXTS.has(doc.fileExt)) return image;
  logger.info('[Update Controller] featured image not email-safe, email goes without it', {
    id: item.id, type: mime || doc.fileExt || null
  });
  return null;
}

/**
 * Did DEMI claim this update's email? Any DEMI claim is cancelled, since an unanswered send may have
 * gone out; a claim with no marker predates the bookkeeping and has nothing to cancel.
 */
function announcedByDemi(row) {
  return Boolean(row) && row.notifiedBy === updates.NOTIFIED_BY.DEMI;
}

/**
 * Send a claimed row and record the outcome. A refusal (4xx) keeps the claim and is never retried;
 * a send with no answer keeps it too, and the timer takes the lease over once it runs out.
 */
async function sendClaimed(claimed, now, parent) {
  const outcome = await notify.updatePublished(claimed, parent ? parent.name : null, await publicImage(claimed));
  if (outcome === notify.OUTCOME.SENT) {
    await updates.markNotify(claimed.id, 'notifySentAt', now);
  } else if (outcome === notify.OUTCOME.REJECTED) {
    await updates.markNotify(claimed.id, 'notifyFailedAt', now);
  } else if (claimed.notifyAttempts >= updates.NOTIFY_MAX_ATTEMPTS) {
    logger.error('[Update Controller] notify gave up', { id: claimed.id, attempts: claimed.notifyAttempts });
  }
}

/**
 * Tell eagle-notify what changed, if anything did. Never throws: the mirrored record outranks the
 * notification. A `publishDate` moved later after the email sends nothing, now or then.
 */
async function announce(item, existing, now = new Date().toISOString()) {
  // Not configured: claim NOTHING. A claim taken while dark would suppress the first real
  // notification once the environment is wired up.
  if (!notify.configured()) return;

  try {
    if (item.isPublished) {
      // Not due yet: src/scripts/announce-updates.js announces it once its publishDate passes.
      if (!updates.isLive(item, null, now)) return;
      // Old news, as a bulk repush carries it: mirrored, never claimed, never emailed.
      if (!updates.isInNotifyWindow(item, now)) {
        logger.debug('[Update Controller] notify skipped, older than the notify window', {
          id: item.id, publishDate: item.publishDate
        });
        return;
      }
      // Read fresh before the claim: a parent unpublished since the push must not be emailed. Marked,
      // not claimed, so the timer stops listing it until a push or cascade clears the mark.
      const parent = item.projectId ? await readParent(item.projectId) : null;
      if (item.projectId && !isPublicParent(parent)) {
        const reason = parent ? 'parent-not-public' : 'parent-missing';
        logger.debug('[Update Controller] notify skipped', { id: item.id, projectId: item.projectId, reason });
        await updates.markNotifySkipped(item.id, now, reason);
        return;
      }
      const claimed = await updates.claimForNotify(item.id, now);
      if (claimed) await sendClaimed(claimed, now, parent);
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

// The scheduled announce (src/scripts/announce-updates.js) goes through the same claim.
module.exports = { announce };
