'use strict';

/**
 * Chunk parent-field re-stamping, off the request that caused it. Producer and handler together:
 * the body shape has one reader and one writer. Wiki [[Search-Index-Reference]].
 *
 * The walk is proportional to the document (6k chunks is ~60 serial bulk calls), and eagle-api's
 * push client gives the whole request 10 seconds, so inline it times the push out and eagle-api
 * pushes again.
 *
 * The body carries IDS ONLY: the handler re-reads the row, so a redelivered or out-of-order
 * message stamps the current values. That is what makes retrying safe.
 */

const config = require('../config');
const { queueClientFor } = require('./queue-client');
const documents = require('../repositories/documents');
const chunks = require('../repositories/chunks');
const { systemAccess } = require('../helpers/access-sql');
const { logger } = require('../utils/logger');

/**
 * Whether the queue exists to send to: the NAME alone, the same setting `api/index.js` guards the
 * trigger on. A name with no storage account behind it is a broken deployment, so it surfaces as
 * an enqueue failure rather than reverting to the slow path this exists to avoid.
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
 * Ask for a document's chunks to be re-stamped.
 *
 * `projectId` is the document container's partition key, so carrying it turns the handler's read
 * into a single-partition point read instead of a cross-partition query. `attempt` is only written
 * for a retry: a redelivery is a NEW message whose `dequeueCount` starts at 1 again, so the count
 * that decides which attempt is the last has to travel in the body.
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
 * The body, back from the queue. An OBJECT is the normal case: the Node worker JSON-parses a queue
 * body before the handler sees it (`fromRpcTypedData`), so `String(message)` read
 * `[object Object]` and poisoned every message. Unreadable bodies throw so they reach the poison
 * queue instead of vanishing.
 */
function parseMessage(message) {
  let body = message;
  if (Buffer.isBuffer(message) || typeof message === 'string') {
    const text = Buffer.isBuffer(message) ? message.toString('utf8') : message;
    try {
      body = JSON.parse(text);
    } catch (err) {
      throw new Error(`chunk restamp message is not JSON: ${err.message}`, { cause: err });
    }
  }

  if (!body || typeof body !== 'object' || !body.documentId) {
    throw new Error('chunk restamp message carries no documentId');
  }
  return {
    documentId: String(body.documentId),
    // PRESENCE of the key, not its value: `''` is the real partition unlinked documents live in and
    // JSON `null` is another, so a falsy test — or `??`, which folds null into undefined — turns a
    // pinned read of either into a cross-partition scan. Only an absent key means "unknown".
    projectId: 'projectId' in body ? body.projectId : undefined,
    attempt: Number(body.attempt) || 1
  };
}

/**
 * First retry hides for this long; each further attempt doubles it. Seconds.
 *
 * Retry is done here rather than by letting the message reappear: host.json's
 * `visibilityTimeout` is one hour for every queue in the app (sized for the zip worker), so one
 * 429 would hide this message for an hour per attempt.
 */
const RETRY_VISIBILITY_SECONDS = 30;

/**
 * Re-stamp one document's chunks. NEVER SWALLOWS, unlike the inline call it replaces: the write is
 * long gone by now, so a failure is retried and then poisoned.
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

  // The token the flag was raised with says which edit this walk serves, and every operation is
  // guarded on it: a chunk a NEWER walk — or a newer ingest — already stamped keeps what it has and
  // comes back as `skippedNewer`. Without it the walk writes the values it read over anything, so a
  // slow message could put a superseded type back onto chunks that were already correct.
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
 * Take the document back off the reconcile line. The write raised the flag on the row itself
 * (`stampParentFieldsPending` in the document controller); a landed patch is the only thing that
 * clears it, so this is the one place that writes `false` — the queue handler after its walk, and
 * the inline path after its own.
 *
 * Guarded on the TOKEN the flag was raised with, not on the row's revision. An etag answers "has
 * anything written this row since I read it", so an extraction patch or a display-name push landing
 * mid-walk refused the clear, and the flag then stood until an operator ran
 * `backfill-chunk-parent-fields.js --pending`. The token answers the only question worth asking:
 * is the raised flag still the one this run walked for.
 *
 * A row flagged before the token existed carries none, and clears unconditionally — there is
 * nothing to compare, and leaving it raised forever is the state this replaced.
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
      documentId, projectId, attempt, error: sendErr.message, cause: err.message
    });
    return false;
  }
  logger.warn(
    `[chunk restamp] attempt failed ${documentId} (${attempt}/${maxAttempts}): ${err.message}`,
    { documentId, projectId, attempt, visibilityTimeout, error: err.message }
  );
  return true;
}

module.exports = { enabled, enqueue, parseMessage, run, clearPending };
