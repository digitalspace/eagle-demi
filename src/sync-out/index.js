'use strict';

/**
 * Sync-out: DEMI-owned rows written to other systems, one queue message per consumer.
 *
 * A consumer is `{ name, enabled(), wants(row), send(row, { update }) }`. The message carries ids
 * only; the worker re-reads the row, so a redelivered or late message sends the current state.
 * `syncVersion` is the version, raised by every ENGAGE ingest write: a row whose
 * `syncOut[name].sentVersion` is at or past it is not sent again.
 */

const queues = require('../jobs/queue-client');
const commentPeriods = require('../repositories/comment-periods');
const { writeGuarded } = require('../helpers/etag-write');
const { logger } = require('../utils/logger');
const settings = require('../config').syncOut;

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

/**
 * Queue one message per enabled consumer that wants this row. `{ repair: true }` marks a reconcile
 * re-send, which a delivery never drops as an already-failed redelivery.
 */
async function enqueue(row, { repair = false } = {}) {
  const wanted = consumers.filter(c => c.enabled() && c.wants(row));
  for (const consumer of wanted) {
    await send({
      consumer: consumer.name, id: String(row.id), projectId: row.projectId ?? null, attempt: 1,
      ...(repair ? { repair: true } : {})
    });
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
    attempt: Number(body.attempt) || 1,
    ...(body.resend === true ? { resend: true } : {}),
    ...(body.repair === true ? { repair: true } : {})
  };
}

const versionOf = (row) => (Number.isInteger(row.syncVersion) ? row.syncVersion : 0);

/** True when `sentVersion` is at or past `version`; a cleared or missing sentVersion is never current. */
function isCurrent(sentVersion, version) {
  return Number.isInteger(sentVersion) && sentVersion >= version;
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

/**
 * Store the outcome on the row. Resolves to `{ row, superseded }`: the row as stored afterwards (null
 * when it is gone), and whether a failure was left unrecorded because the row has moved past it.
 */
async function recordOutcome(consumer, row, outcome) {
  let superseded = false;
  const result = await updateRow(row.id, row.projectId, (current) => {
    const previous = (current.syncOut && current.syncOut[consumer.name]) || {};
    if (outcome.status === 'failed') {
      // A newer send already landed, or another delivery is mid-create: that settles the row, not this failure.
      superseded = isCurrent(previous.sentVersion, outcome.version) || Boolean(consumer.inFlight && consumer.inFlight(previous));
      if (superseded) return null;
      const entry = { ...previous, status: 'failed', error: outcome.error, failedAt: outcome.at,
        failedVersion: outcome.version };
      return { ...current, syncOut: { ...current.syncOut, [consumer.name]: entry } };
    }
    // A later delivery already recorded a newer send; never move the version back.
    if (previous.sentVersion > outcome.version) return null;
    const entry = { ...previous, ...outcome.record, sentVersion: outcome.version, sentAt: outcome.at,
      status: outcome.status, error: null };
    return { ...current, syncOut: { ...current.syncOut, [consumer.name]: entry } };
  });
  return { row: result.row, superseded };
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

const messageText = (message) => (Buffer.isBuffer(message) ? message.toString('utf8') : String(message));

/**
 * The last attempt failed: record it, park the message in the poison queue, write the alert line once.
 * `job`, `consumer` and `row` are null when the failure came before they were known.
 */
async function giveUp({ message, job, consumer, row, version }, err) {
  const fields = { ...(job || { message: messageText(message).slice(0, 500) }), error: err.message };
  if (consumer && row) {
    try {
      const { superseded } = await recordOutcome(consumer, row, {
        status: 'failed', error: err.message, version, at: new Date().toISOString()
      });
      if (superseded) {
        logger.warn(`[sync-out] last attempt failed ${job.consumer} ${job.id}, but a newer send or a ` +
          `create in flight settles the row: ${err.message}`, fields);
        return { skipped: 'superseded' };
      }
    } catch (recordErr) {
      logger.error('[sync-out] could not record failure', { ...fields, recordError: recordErr.message });
    }
  }
  const poison = `${settings.queue}-poison`;
  try {
    await queues.queueClientFor({ name: poison, setting: 'SYNC_OUT_QUEUE', feature: 'sync-out' })
      .sendMessage(job ? JSON.stringify(job) : messageText(message));
  } catch (poisonErr) {
    logger.error(`[sync-out] could not move the message to ${poison}`, { ...fields, poisonError: poisonErr.message });
  }
  // The poison alert matches this prefix; written once per message, after it is parked.
  logger.error(`[sync-out] job failed ${job ? job.consumer : '?'} ${job ? job.id : '?'}: ${err.message}`, {
    ...fields, engagementId: row ? row.engagementId : null, stack: err.stack
  });
  return { failed: err.message };
}

/**
 * One delivery. Earlier failures re-queue with a doubled delay and complete the original. The last
 * attempt never throws, wherever it failed: it records the failure and moves the message to the poison
 * queue itself, so the alert line is written exactly once.
 *
 * @param {object} [delivery] `attempt` is the message's `dequeueCount`, `maxAttempts` host.json's
 *   `maxDequeueCount`; api/index.js reads both.
 */
async function run(message, { attempt: dequeueCount = 1, maxAttempts = 1 } = {}) {
  const state = { message, job: null, consumer: null, row: null, version: 0 };
  try {
    const parsed = parseMessage(message);
    const job = state.job = { ...parsed, attempt: Math.max(parsed.attempt, dequeueCount) };

    const consumer = consumers.find(c => c.name === job.consumer);
    if (!consumer) throw new Error(`sync-out has no consumer named ${job.consumer}`);
    if (!consumer.enabled()) {
      logger.info('[sync-out] consumer disabled, message dropped', job);
      return { skipped: 'disabled' };
    }
    state.consumer = consumer;

    const row = await commentPeriods.readForWrite(job.id, job.projectId);
    if (!row) {
      logger.warn('[sync-out] row not found, message dropped', job);
      return { skipped: 'missing' };
    }
    state.row = row;
    const version = state.version = versionOf(row);
    const entry = (row.syncOut && row.syncOut[consumer.name]) || {};

    // The host redelivered a last attempt that already gave up, e.g. the worker died before completing
    // it. A resend or repair message is a fresh request, never that.
    const fresh = job.resend || job.repair;
    if (!fresh && job.attempt >= maxAttempts && dequeueCount > 1 && entry.status === 'failed' &&
      entry.failedVersion === version) {
      logger.warn(`[sync-out] ${job.consumer} ${job.id} already failed at version ${version}, redelivery dropped`, job);
      return { skipped: 'failed' };
    }
    if (!job.resend && isCurrent(entry.sentVersion, version)) return { skipped: 'current' };

    const result = await consumer.send(row, {
      update: (mutate) => updateRow(row.id, row.projectId, mutate)
    });
    const status = (result && result.status) || 'sent';
    const { row: stored } = await recordOutcome(consumer, row,
      { status, version, record: result && result.record, at: new Date().toISOString() });
    // A write landed while this one was sending, so what reached the consumer may be older than the row.
    // Another delivery may already have recorded that newer version, so the follow-up sends regardless.
    if (stored && versionOf(stored) > version) {
      await send({ consumer: job.consumer, id: job.id, projectId: stored.projectId ?? null, attempt: 1, resend: true });
    }
    return { status, ...(result && result.eagleId ? { eagleId: result.eagleId } : {}) };
  } catch (err) {
    const attempt = state.job ? state.job.attempt : dequeueCount;
    if (attempt < maxAttempts) {
      if (state.job && await requeue(state.job, maxAttempts, err)) return { retryQueued: attempt + 1 };
      throw err;
    }
    return giveUp(state, err);
  }
}

module.exports = { enqueue, consumers, run, RETRY_VISIBILITY_SECONDS };
