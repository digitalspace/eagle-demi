'use strict';

/**
 * Sync-out: DEMI-owned rows written to other systems, one queue message per consumer.
 *
 * A consumer is `{ name, enabled(), wants(row), send(row, { update }) }`. The message carries ids
 * only; the worker re-reads the row, so a redelivered or late message sends the current state.
 * `engagePushedAt` is the version: a row whose `syncOut[name].sentVersion` is at or past it is not
 * sent again.
 */

const queues = require('../jobs/queue-client');
const commentPeriods = require('../repositories/comment-periods');
const { writeGuarded } = require('../helpers/etag-write');
const { logger } = require('../utils/logger');
const settings = require('./settings');

const consumers = [
  require('./eagle')
];

/** First retry hides this long, doubling per attempt. host.json's hour-long default is the zip worker's. */
const RETRY_VISIBILITY_SECONDS = 30;

function queueClient() {
  return queues.queueClientFor({ name: settings.queue, setting: 'SYNC_OUT_QUEUE', feature: 'sync-out' });
}

async function send(message, options = undefined) {
  // host.json `messageEncoding: "none"`: the body is the JSON text itself.
  await queueClient().sendMessage(JSON.stringify(message), options);
}

/** Queue one message per enabled consumer that wants this row. */
async function enqueue(row) {
  const wanted = consumers.filter(c => c.enabled() && c.wants(row));
  for (const consumer of wanted) {
    await send({ consumer: consumer.name, id: String(row.id), projectId: row.projectId ?? null, attempt: 1 });
  }
  return wanted.map(c => c.name);
}

function parseMessage(message) {
  let body = message;
  if (Buffer.isBuffer(message) || typeof message === 'string') {
    const text = Buffer.isBuffer(message) ? message.toString('utf8') : message;
    try {
      body = JSON.parse(text);
    } catch (err) {
      throw new Error(`sync-out message is not JSON: ${err.message}`, { cause: err });
    }
  }
  if (!body || typeof body !== 'object' || !body.consumer || !body.id) {
    throw new Error('sync-out message carries no consumer or id');
  }
  return {
    consumer: String(body.consumer),
    id: String(body.id),
    projectId: body.projectId ?? null,
    attempt: Number(body.attempt) || 1
  };
}

const versionMs = (value) => (value ? Date.parse(value) : NaN);

/** True when `sentVersion` is at or past `version`; an unparseable version is never current. */
function isCurrent(sentVersion, version) {
  const sent = versionMs(sentVersion);
  const wanted = versionMs(version);
  return Number.isFinite(sent) && Number.isFinite(wanted) && sent >= wanted;
}

/**
 * Etag-guarded write of one row. `mutate(current)` returns the item to store, or null to leave it.
 * Rebuilds from the stored row after each lost race; throws once every try has lost.
 */
async function updateRow(id, projectId, mutate) {
  const reread = () => commentPeriods.readForWrite(id, projectId);
  const result = await writeGuarded({
    existing: await reread(),
    reread,
    attempt: async (current) => {
      if (!current) return { status: 'missing', row: null };
      const item = mutate(current);
      if (!item) return { status: 'unchanged', row: current };
      return { status: 'saved', row: await commentPeriods.upsert(item, current) };
    }
  });
  if (result.status === 'conflict') {
    throw new Error(`sync-out could not write row ${id}: every try lost to a concurrent writer`);
  }
  return result;
}

function recordOutcome(consumer, row, outcome) {
  return updateRow(row.id, row.projectId, (current) => {
    const previous = (current.syncOut && current.syncOut[consumer]) || {};
    // A later delivery already recorded a newer send; never move the version back.
    if (isCurrent(previous.sentVersion, outcome.sentVersion) && previous.sentVersion !== outcome.sentVersion) {
      return null;
    }
    const entry = outcome.status === 'failed'
      ? { ...previous, status: 'failed', error: outcome.error, failedAt: outcome.at }
      : { sentVersion: outcome.sentVersion, sentAt: outcome.at, status: outcome.status, error: null };
    return { ...current, syncOut: { ...current.syncOut, [consumer]: entry } };
  });
}

async function requeue(message, maxAttempts, err) {
  const visibilityTimeout = RETRY_VISIBILITY_SECONDS * 2 ** (message.attempt - 1);
  try {
    await send({ ...message, attempt: message.attempt + 1 }, { visibilityTimeout });
  } catch (sendErr) {
    logger.error('[sync-out] retry could not be queued', {
      ...message, error: sendErr.message, cause: err.message
    });
    return false;
  }
  logger.warn(`[sync-out] attempt failed ${message.consumer} ${message.id} ` +
    `(${message.attempt}/${maxAttempts}): ${err.message}`, { ...message, visibilityTimeout, error: err.message });
  return true;
}

/**
 * One delivery. Throws only on the last attempt, so the message reaches the poison queue; earlier
 * failures re-queue with a doubled delay and complete the original.
 *
 * @param {object} [delivery] `attempt` is the message's `dequeueCount`, `maxAttempts` the ceiling.
 */
async function run(message, { attempt: dequeueCount = 1, maxAttempts = settings.maxAttempts } = {}) {
  const parsed = parseMessage(message);
  const attempt = Math.max(parsed.attempt, dequeueCount);
  const job = { ...parsed, attempt };

  // Already failed its last attempt and was recorded; only the queue can poison it now.
  if (parsed.attempt >= maxAttempts && dequeueCount > 1) {
    throw new Error(`sync-out ${job.consumer} for row ${job.id} already failed its last attempt`);
  }

  const consumer = consumers.find(c => c.name === job.consumer);
  if (!consumer) throw new Error(`sync-out has no consumer named ${job.consumer}`);
  if (!consumer.enabled()) {
    logger.info('[sync-out] consumer disabled, message dropped', job);
    return { skipped: 'disabled' };
  }

  const row = await commentPeriods.readForWrite(job.id, job.projectId);
  if (!row) {
    logger.warn('[sync-out] row not found, message dropped', job);
    return { skipped: 'missing' };
  }
  const version = row.engagePushedAt;
  if (isCurrent(row.syncOut && row.syncOut[consumer.name] && row.syncOut[consumer.name].sentVersion, version)) {
    return { skipped: 'current' };
  }

  try {
    const result = await consumer.send(row, {
      update: (mutate) => updateRow(row.id, row.projectId, mutate)
    });
    const status = (result && result.status) || 'sent';
    await recordOutcome(consumer.name, row, { status, sentVersion: version, at: new Date().toISOString() });
    return { status, ...(result && result.eagleId ? { eagleId: result.eagleId } : {}) };
  } catch (err) {
    if (attempt < maxAttempts && await requeue(job, maxAttempts, err)) {
      return { retryQueued: attempt + 1 };
    }
    if (attempt >= maxAttempts) {
      try {
        await recordOutcome(consumer.name, row, {
          status: 'failed', error: err.message, sentVersion: version, at: new Date().toISOString()
        });
      } catch (recordErr) {
        logger.error('[sync-out] could not record failure', { ...job, error: recordErr.message });
      }
      // Poison alert matches this prefix; logged only on the delivery that will poison.
      logger.error(`[sync-out] job failed ${job.consumer} ${job.id}: ${err.message}`, {
        ...job, engagementId: row.engagementId, error: err.message, stack: err.stack
      });
    }
    throw err;
  }
}

/** `storageQueue` trigger handler. */
function workerHandler(message, context) {
  const dequeueCount = Number(context && context.triggerMetadata && context.triggerMetadata.dequeueCount) || 1;
  return run(message, { attempt: dequeueCount, maxAttempts: settings.maxAttempts });
}

module.exports = { enqueue, workerHandler, consumers, run, RETRY_VISIBILITY_SECONDS };
