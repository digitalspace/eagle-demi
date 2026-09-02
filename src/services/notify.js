'use strict';

/**
 * eagle-notify push — "an Update was published", and its retraction.
 *
 * DEMI owns Updates, so DEMI is what tells the subscription service one went public. Nothing here
 * throws: a failure resolves `false` so the caller can release its claim and let the next push
 * retry.
 *
 * Dark when either setting is missing, which is every environment not yet wired to eagle-notify.
 */

const config = require('../config');
const { logger } = require('../utils/logger');

const TIMEOUT_MS = 10000;
const ATTEMPTS = 2;
const EXCERPT_CHARS = 500;

function configured() {
  return Boolean(config.notifyApiBase && config.notifyApiKey);
}

/** The update's HTML content as the plain lead-in a notification quotes. */
function excerptOf(content) {
  return String(content || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, EXCERPT_CHARS);
}

/** Where a reader lands. No project means the update is site-wide, so the news page. */
function urlFor(projectId) {
  return projectId
    ? `${config.linkBaseUrl}/p/${projectId}/project-details`
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
  if (!configured()) return true;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${config.notifyApiBase}/api/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-functions-key': config.notifyApiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (res.ok) return true;
      // A 4xx is a bad request, not a blip: a retry sends the same rejected body again.
      if (res.status < 500) {
        logger.error('[notify] eagle-notify refused the event', {
          status: res.status, idempotencyKey: body.idempotencyKey
        });
        return false;
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
  return false;
}

async function updatePublished(item, projectName) {
  return post({
    ...eventFor(item),
    url: urlFor(item.projectId),
    projectName: projectName || null,
    excerpt: excerptOf(item.content)
  });
}

async function updateCancelled(item) {
  return post({ ...eventFor(item), cancelled: true });
}

module.exports = { configured, updatePublished, updateCancelled, excerptOf, urlFor };
