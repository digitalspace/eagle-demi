'use strict';

/**
 * Off the request: the walk scales with the document (6k chunks is ~60 bulk calls) and eagle-api's
 * push allows 10 s. The body carries ids only, so a redelivery stamps the current values.
 */

const config = require('../config');
const { queueClientFor } = require('./queue-client');
const documents = require('../repositories/documents');
const chunks = require('../repositories/chunks');
const { systemAccess } = require('../helpers/access-sql');
const { logger } = require('../utils/logger');
const { queueBody } = require('../utils/queue-message');

/**
 * The name alone, as `api/index.js` guards the trigger: a name with no storage account behind it
 * fails the enqueue instead of falling back to the slow inline path.
 */
function enabled() {
  return Boolean(config.chunkRestampQueue);
}

function queueClient() {
  return queueClientFor({
    name: config.chunkRestampQueue,
    setting: 'CHUNK_RESTAMP_QUEUE',
    feature: 'chunk re-stamping'
  });
}

/**
 * `projectId` is the partition key, so the handler can point-read. A retry is a new message whose
 * `dequeueCount` restarts at 1, so `attempt` travels in the body.
 *
 * @param {object} [options] `sendMessage` options — `visibilityTimeout`, in seconds, for a retry.
 */
async function enqueue({ documentId, projectId, attempt = 1 }, options = undefined) {
  // `messageEncoding: "none"` (host.json) applies to every queue in this app, so the body is the
  // JSON text itself — base64 on this side would reach the trigger undecodable.
  await queueClient().sendMessage(JSON.stringify({
    documentId: String(documentId),
    projectId: projectId === undefined || projectId === null ? null : String(projectId),
    ...(attempt > 1 ? { attempt } : {})
  }), options);
}

/**
 * The Node worker JSON-parses a queue body before the handler sees it, so an object is normal.
 * Unreadable bodies throw so they reach the poison queue instead of vanishing.
 */
function parseMessage(message) {
  const body = queueBody(message, 'chunk restamp');
  if (!body || typeof body !== 'object' || !body.documentId) {
    throw new Error('chunk restamp message carries no documentId');
  }
  return {
    documentId: String(body.documentId),
    // Presence, not value: `''` and `null` are both real partitions, so a falsy test or `??` turns
    // a pinned read into a cross-partition scan. Only an absent key means "unknown".
    projectId: 'projectId' in body ? body.projectId : undefined,
    attempt: Number(body.attempt) || 1
  };
}

/**
 * Seconds, doubled per attempt. Retried here because host.json's `visibilityTimeout` is one hour for
 * every queue (sized for the zip worker), so letting the message reappear costs an hour per 429.
 */
const RETRY_VISIBILITY_SECONDS = 30;

/**
 * Never swallows: the write has finished, so a failure is retried and then poisoned.
 *
 * @param {object} [delivery] `attempt` is this message's `dequeueCount`, `maxAttempts` host.json's
 *                            `maxDequeueCount`; api/index.js reads both off the trigger.
 */
async function run(message, { attempt: dequeueCount = 1, maxAttempts = 1 } = {}) {
  const { documentId, projectId, attempt: carried } = parseMessage(message);
  // `carried` counts retries this job sent itself, `dequeueCount` redeliveries of THIS message.
  // Either reaching the ceiling is the last attempt.
  const attempt = Math.max(carried, dequeueCount);

  // A spent message is thrown straight back: only the queue can poison it, and only after
  // `maxDequeueCount` deliveries, so redoing the walk would spend the same minutes on a dead job.
  if (carried >= maxAttempts && dequeueCount > 1) {
    throw new Error(
      `chunk restamp for document ${documentId} already failed its last attempt; this delivery ` +
      'is only spending the message into the poison queue');
  }

  try {
    return await restamp(documentId, projectId);
  } catch (err) {
    if (attempt < maxAttempts && await requeue({ documentId, projectId, attempt, maxAttempts, err })) {
      // Returning completes the ORIGINAL message: the retry is the new one on its short hide.
      return { documentId, patched: 0, failed: 0, retryQueued: attempt + 1 };
    }
    if (attempt >= maxAttempts) {
      // The literal string the poison alert matches (azure/modules/observability.bicep), logged
      // only on the delivery that will poison.
      logger.error(`[chunk restamp] job failed ${documentId}: ${err.message}`, {
        documentId, projectId, attempt, error: err.message, stack: err.stack
      });
    }
    throw err;
  }
}

async function restamp(documentId, projectId) {
  const access = systemAccess();
  // Taken before the read, so it is the delivery instant: the walk serves values that are at least
  // this new, and a row carrying no pending token has nothing better to offer.
  const deliveredAt = new Date().toISOString();

  // Re-read rather than trust the message: this is what makes a redelivered or out-of-order
  // message stamp the CURRENT values instead of an older edit's.
  const document = await documents.getById(access, documentId, projectId);
  if (!document) {
    // Purged between the write and the pickup. Its chunks went with it, and a retry cannot bring
    // the row back, so this is a completed message rather than a failed one.
    logger.warn('[chunk restamp] document no longer exists, nothing to re-stamp', {
      documentId, projectId
    });
    return { documentId, patched: 0, failed: 0 };
  }

  // Every patch is guarded on the flag's token, so a chunk a newer walk or ingest already stamped
  // keeps its values and comes back as `skippedNewer` instead of getting superseded ones.
  const stampedAt = typeof document.parentFieldsPendingAt === 'string'
    ? document.parentFieldsPendingAt
    : deliveredAt;
  const result = await chunks.setParentFieldsForDocument(access, documentId, document, { stampedAt });
  // `skippedNewer` is an outcome, not a shortfall: those chunks are newer than this walk.
  logger.info('[chunk restamp] chunks re-stamped', {
    documentId, projectId, stampedAt,
    patched: result.succeeded, failed: result.failed, skippedNewer: result.skippedNewer
  });

  if (result.failed > 0) {
    throw new Error(
      `chunk parent-field patch failed for ${result.failed} of ` +
      `${result.succeeded + result.failed} chunks of document ${documentId}`
    );
  }

  await clearPending(document);

  return { documentId, patched: result.succeeded, failed: result.failed };
}

/**
 * The only writer of `false`. Guarded on the flag's token, not the etag, so unrelated writes mid-walk
 * cannot block the clear; a row flagged with no token clears unconditionally.
 */
async function clearPending(document) {
  const pendingAt = document.parentFieldsPendingAt;
  const guard = typeof pendingAt === 'string' ? { pendingAt } : undefined;
  const result = await documents.setParentFieldsPending(
    document.id, document.projectId, false, guard);

  if (result.status === 'conflict') {
    // A newer parent-field change owns the flag, and it has a re-stamp of its own that will clear
    // it. Nothing to retry, and nothing wrong: info, not warn.
    logger.info('[chunk restamp] a newer parent-field change owns the flag, left raised', {
      documentId: document.id, projectId: document.projectId, pendingAt
    });
  } else if (result.status === 'missing') {
    // The row went between the walk and the clear. Its chunks went with it.
    logger.warn('[chunk restamp] document gone before the pending flag could be cleared', {
      documentId: document.id, projectId: document.projectId, reason: result.reason
    });
  }
  return result;
}

/** Send the same ids back on a short hide. False when that failed, and the caller then throws so
 *  the host's own redelivery is what retries. */
async function requeue({ documentId, projectId, attempt, maxAttempts, err }) {
  const visibilityTimeout = RETRY_VISIBILITY_SECONDS * 2 ** (attempt - 1);
  try {
    await enqueue({ documentId, projectId, attempt: attempt + 1 }, { visibilityTimeout });
  } catch (sendErr) {
    logger.error('[chunk restamp] retry could not be queued', {
      documentId, projectId, attempt, error: sendErr.message, stack: sendErr.stack, cause: err.message
    });
    return false;
  }
  logger.warn(
    `[chunk restamp] attempt failed ${documentId} (${attempt}/${maxAttempts}): ${err.message}`,
    { documentId, projectId, attempt, visibilityTimeout, error: err.message, stack: err.stack }
  );
  return true;
}

module.exports = { enabled, enqueue, parseMessage, run, clearPending };
