'use strict';

/**
 * The Eagle mirror for `RecentActivity`; staff writes go through domain/updates.js. eagle-notify hears
 * of a publication once and of its withdrawal; `notifiedAt` is the claim (repositories/updates.js).
 */

const updates = require('../../repositories/updates');
const {
  readParent, ownRead, hasNoRead, updateRead, inheritsParentRead, isPublicParent
} = require('../../helpers/update-parent');
const { resolveAccess, levelOfRead } = require('../../helpers/access-sql');
const { logger } = require('../../utils/logger');
const notify = require('../../services/notify');
const documents = require('../../repositories/documents');
const { toIsoOrNull } = require('../../seed/transform');
const { plainTextOf } = require('../../helpers/html-entities');
const { refId, upsertKeepingDemiRows, pushHandler } = require('./eagle-mirror');

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
function mirrorItem(eagleId, doc, read, existing) {
  return {
    id: eagleId,
    eagleId,
    projectId: doc.project ? String(doc.project) : null,
    headline: doc.headline ?? null,
    content: doc.content,
    type: doc.type ?? null,
    // Always a boolean: the pinned sort and the C&E filter drop or mismatch a row lacking the field.
    pinned: doc.pinned === true,
    complianceAndEnforcement: doc.complianceAndEnforcement === true,
    dateAdded: doc.dateAdded,
    dateUpdated: doc.dateUpdated,
    // The rest of eagle-public's News model. `pcp` and `projectNotification` arrive as bare Mongo
    // references, so they are stored as ids for the reader to resolve.
    notificationName: doc.notificationName || null,
    contentUrl: doc.contentUrl || null,
    documentUrl: doc.documentUrl || null,
    pcp: refId(doc.pcp),
    projectNotification: refId(doc.projectNotification),
    // The Updates fields, stored as sent bar image text. The `shortHeadline`/`summary` fallbacks are
    // the reader's, so an edit to `headline` or `content` never leaves a stale copy here.
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
    // `read` is `helpers/update-parent:updateRead`; `sources.eagle.read` keeps Eagle's own minus
    // compliance, uncapped (null when Eagle sent none), for the project cascade to re-derive from.
    isPublished: read.includes('public'),
    read,
    // A Cosmos write REPLACES the item, so the claim is carried across. Eagle's own `notifiedAt`
    // seeds an empty claim, so an update Eagle already announced is not announced again.
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
 * Mirror one raw Eagle `RecentActivity` for the push or the backfill, never announcing; throws
 * `DUPLICATE_ID` when two DEMI rows name the Eagle id. The rebuild after a lost race keeps the claim.
 *
 * @returns {Promise<{saved, existing}|{ignored, existing}|{status: 'conflict'}>}
 */
function mirrorFromEagle(eagleId, doc, { pushedAt = null } = {}) {
  return upsertKeepingDemiRows(updates, eagleId, doc,
    // The parent is read per attempt, so a retry after a lost race caps against its ACL as it is
    // then. A parent DEMI does not hold yet caps nothing; the search read gates on it again.
    async (current) => {
      const parent = await readParent(refId(doc.project));
      // Stored stripped in `sources.eagle` too, so the project cascade re-derives from it.
      const own = ownRead(doc.read);
      const read = updateRead(doc, parent);
      if (parent && inheritsParentRead(doc)) {
        logger.debug('[Update Controller] update with no read inherits parent read', {
          id: eagleId, parentId: parent.id, kind: parent.kind, to: read
        });
      } else if (levelOfRead(read) < levelOfRead(own)) {
        logger.debug('[Update Controller] read capped by parent', {
          id: eagleId, parentId: parent.id, kind: parent.kind, from: own, to: read
        });
      }
      // Missing is stored as null and `[]` as `[]`: with no status, only null inherits (`inheritsParentRead`).
      return mirrorItem(eagleId, { ...doc, read: hasNoRead(doc) ? null : own }, read, current);
    },
    // Unfiltered: a row with no `read` or a compartment token is still there to be replaced. Else a DEMI row
    // sync-out sent under the id.
    async () => await updates.readForWrite(eagleId) || await updates.readForWriteByEagleId(eagleId),
    { pushedAt, label: 'Update Controller' }
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
exports.upsertFromEagle = pushHandler({
  label: 'Update Controller', action: 'update.push', targetType: 'update', mirror: mirrorFromEagle,
  projectScoped: true,
  // A stale push never gets here, so the newer push did the announce. A DEMI row's echo changes nothing DEMI
  // owns; the announce timer mails its publish and its withdrawal, and sync-out's call does not wait on eagle-notify.
  after: async ({ saved, existing }) => {
    if (!(existing && existing.sourceSystem === 'demi')) await announce(saved, existing);
  },
  failure: 'update controller failed'
});
