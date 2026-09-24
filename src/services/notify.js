'use strict';

/**
 * eagle-notify push — "an Update was published", and its retraction.
 *
 * DEMI owns Updates, so DEMI is what tells the subscription service one went public. Nothing here
 * throws: every send resolves an OUTCOME, and the caller decides from it whether a later tick may
 * try again.
 *
 * Dark when either setting is missing, which is every environment not yet wired to eagle-notify.
 */

const config = require('../config');
const { logger } = require('../utils/logger');
const { decodeEntities, plainTextOf } = require('../helpers/html-entities');

const TIMEOUT_MS = 10000;
const ATTEMPTS = 2;
const EXCERPT_CHARS = 500;
const SUMMARY_CHARS = 280;

/**
 * What one send came to. REJECTED is a 4xx: eagle-notify refused the body, and the same body would
 * be refused again. FAILED is a 5xx or no answer at all, which a later attempt may get past.
 */
const OUTCOME = Object.freeze({ SENT: 'sent', REJECTED: 'rejected', FAILED: 'failed' });

function configured() {
  return Boolean(config.notifyApiBase && config.notifyApiKey);
}

/** Markup to plain text. Tags go first, so `&lt;b&gt;` written as text survives as `<b>`. */
function plainText(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** The update's HTML content as the plain lead-in a notification quotes. */
function excerptOf(content) {
  return plainText(content).slice(0, EXCERPT_CHARS);
}

/**
 * Where a reader lands. With reader links on, the update's own page: `item.id` is the Eagle `_id`
 * eagle-public's `/updates/:id` reads back through `RecentActivity` `and[_id]`. Otherwise the
 * project page, or the news page for a site-wide update.
 */
function urlFor(item) {
  if (config.notifyUpdateReaderLinks) return `${config.linkBaseUrl}/updates/${item.id}`;
  return item.projectId
    ? `${config.linkBaseUrl}/p/${item.projectId}/project-details`
    : `${config.linkBaseUrl}/news`;
}

/** The identity fields both the publish and the cancel carry — one update, one event. */
function eventFor(item) {
  return {
    kind: 'project-updated',
    serviceName: item.projectId ? `project:${item.projectId}` : 'eao:updates',
    title: item.headline,
    idempotencyKey: item.id
  };
}

async function post(body) {
  if (!configured()) return OUTCOME.SENT;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${config.notifyApiBase}/api/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-functions-key': config.notifyApiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (res.ok) return OUTCOME.SENT;
      // A 4xx is a bad request, not a blip: a retry sends the same rejected body again.
      if (res.status < 500) {
        logger.error('[notify] eagle-notify refused the event', {
          status: res.status, idempotencyKey: body.idempotencyKey
        });
        return OUTCOME.REJECTED;
      }
      logger.warn('[notify] eagle-notify errored', {
        status: res.status, attempt, idempotencyKey: body.idempotencyKey
      });
    } catch (err) {
      logger.warn('[notify] eagle-notify unreachable', {
        attempt, idempotencyKey: body.idempotencyKey, error: err.message
      });
    }
  }
  return OUTCOME.FAILED;
}

/**
 * The update's fallback summary: its first non-empty paragraph as plain text, cut at 280. No `<` or
 * `>` survives, not even one decoded from `&lt;`, so the summary can never carry a tag.
 */
function summaryOf(content) {
  const first = String(content || '')
    .split(/<\/(?:p|div|h[1-6]|blockquote|ul|ol)>|\n\s*\n/i)
    .map(plainTextOf)
    .find(Boolean);
  return (first || '').slice(0, SUMMARY_CHARS);
}

/**
 * The featured image as eagle-public links a document: DEMI's download route behind the site's own
 * `/demi-search` proxy, which redirects to a fresh presigned URL on every fetch.
 */
function imageUrlFor(document) {
  return `${config.linkBaseUrl}/demi-search/documents/${encodeURIComponent(document)}/download?redirect=1`;
}

/**
 * Announce one publication.
 *
 * `featuredImage` is passed apart from the row because only the caller can say whether anyone may
 * fetch it: the download route serves public documents only, so a non-public image is `null` here.
 */
async function updatePublished(item, projectName, featuredImage = null) {
  // Both or neither, and never without alt text: eagle-notify renders the image only as that pair.
  const image = featuredImage && featuredImage.document && featuredImage.alt ? featuredImage : null;
  return post({
    ...eventFor(item),
    id: item.id,
    url: urlFor(item),
    projectName: projectName || null,
    excerpt: excerptOf(item.content),
    // Only an editor-written one: the headline cut to 70 would stop mid-word.
    ...(item.shortHeadline ? { shortHeadline: item.shortHeadline } : {}),
    // Email readers cannot apply the contract fallback, so it is applied here.
    summary: item.summary || summaryOf(item.content),
    ...(image ? { featuredImageUrl: imageUrlFor(image.document), featuredImageAlt: image.alt } : {})
  });
}

async function updateCancelled(item) {
  return post({ ...eventFor(item), id: item.id, cancelled: true });
}

module.exports = {
  OUTCOME, configured, updatePublished, updateCancelled, excerptOf, summaryOf, urlFor
};
