'use strict';

// Consumer: `{ name, enabled(), wants(row), send(row, { update }) }`. Messages carry kind and ids only, so a
// late one sends the row as it is now; `sentVersion` at `syncVersion` is not resent; `{ status: 'held' }` records nothing.

const queues = require('../jobs/queue-client');
const { kindOf, versionOf, DEFAULT_KIND, COMMENT_PERIOD, DOCUMENT } = require('./kinds');
const { writeGuarded } = require('../helpers/etag-write');
const { logger } = require('../utils/logger');
const { isScanCleared } = require('../repositories/documents');
const settings = require('../config').syncOut;

// Keyed by kind: the comment period and document consumers are both named eagle.
const CONSUMERS_BY_KIND = Object.freeze({
  [COMMENT_PERIOD]: Object.freeze([require('./eagle')]),
  [DOCUMENT]: Object.freeze([require('./eagle-document')])
});
const consumers = Object.freeze(Object.values(CONSUMERS_BY_KIND).flat());

/** The consumers that send `kind`, one per name its registry entry lists; throws for a name with none here. */
function consumersOf(kind) {
  const own = CONSUMERS_BY_KIND[kind] || [];
  return kindOf(kind).consumers.map((name) => {
    const consumer = own.find(c => c.name === name);
    if (!consumer) throw new Error(`sync-out kind ${kind} names consumer ${name}, which has no entry for that kind`);
    return consumer;
  });
}

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
 * Queue one message per enabled consumer of `kind` that wants this row. `{ repair: true }` marks a
 * reconcile re-send, which a delivery never drops as an already-failed redelivery.
 */
async function enqueue(row, { repair = false, kind = DEFAULT_KIND } = {}) {
  const wanted = consumersOf(kind).filter(c => c.enabled() && c.wants(row));
  for (const consumer of wanted) {
    await send({
      kind, consumer: consumer.name, id: String(row.id), projectId: row.projectId ?? null, attempt: 1,
      ...(repair ? { repair: true } : {})
    });
  }
  return wanted.map(c => c.name);
}

/** `enqueue` for a write that has already landed: a failure is logged, not thrown, and reconcile re-queues. */
async function enqueueQuietly(row, { kind = DEFAULT_KIND } = {}) {
  try {
    // Through module.exports, so a test that stubs enqueue sees this call too.
    return await module.exports.enqueue(row, { kind });
  } catch (err) {
    logger.error('[sync-out] enqueue failed',
      { kind, id: row.id, projectId: row.projectId, error: err.message, stack: err.stack });
    return [];
  }
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
    // Messages queued before kinds existed name none; every one of them was a comment period.
    kind: body.kind == null ? DEFAULT_KIND : String(body.kind),
    consumer: String(body.consumer),
    id: String(body.id),
    projectId: body.projectId ?? null,
    attempt: Number(body.attempt) || 1,
    ...(body.resend === true ? { resend: true } : {}),
    ...(body.repair === true ? { repair: true } : {})
  };
}

/** True when `sentVersion` is at or past `version`; a cleared or missing sentVersion is never current. */
function isCurrent(sentVersion, version) {
  return Number.isInteger(sentVersion) && sentVersion >= version;
}

/**
 * Etag-guarded write of one row. `mutate(current)` returns the item to store, or null to leave it.
 * Rebuilds from the stored row after each lost race; throws once every try has lost.
 */
async function updateRow(repo, id, projectId, mutate) {
  const reread = () => repo.readForWrite(id, projectId);
  const result = await writeGuarded({
    existing: await reread(),
    reread,
    attempt: async (current) => {
      if (!current) return { status: 'missing', row: null };
      const item = mutate(current);
      if (!item) return { status: 'unchanged', row: current };
      return { status: 'saved', row: await repo.upsert(item, current) };
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
async function recordOutcome(repo, consumer, row, outcome) {
  let superseded = false;
  const result = await updateRow(repo, row.id, row.projectId, (current) => {
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
async function giveUp({ message, job, repo, consumer, row, version }, err) {
  const fields = { ...(job || { message: messageText(message).slice(0, 500) }), error: err.message };
  if (consumer && row) {
    try {
      const { superseded } = await recordOutcome(repo, consumer, row, {
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
 * One delivery; `attempt` is the host's `dequeueCount`, `maxAttempts` host.json's `maxDequeueCount`. The last
 * attempt never throws: it records the failure and parks the message itself, so the alert is written once.
 */
async function run(message, { attempt: dequeueCount = 1, maxAttempts = 1 } = {}) {
  const state = { message, job: null, repo: null, consumer: null, row: null, version: 0 };
  try {
    const parsed = parseMessage(message);
    const job = state.job = { ...parsed, attempt: Math.max(parsed.attempt, dequeueCount) };

    const kind = kindOf(job.kind);
    const consumer = consumersOf(job.kind).find(c => c.name === job.consumer);
    if (!consumer) {
      if (!consumers.some(c => c.name === job.consumer)) throw new Error(`sync-out has no consumer named ${job.consumer}`);
      throw new Error(`sync-out consumer ${job.consumer} does not send kind ${job.kind}`);
    }
    if (!consumer.enabled()) {
      logger.info('[sync-out] consumer disabled, message dropped', job);
      return { skipped: 'disabled' };
    }
    const repo = state.repo = kind.repo;
    state.consumer = consumer;

    const row = await repo.readForWrite(job.id, job.projectId);
    if (!row) {
      logger.warn('[sync-out] row not found, message dropped', job);
      return { skipped: 'missing' };
    }
    // Re-checked here as well as in wants(): the row may have changed since the message was queued.
    if (!isScanCleared(row)) {
      logger.warn('[sync-out] row not released by the intake scan, message dropped', job);
      return { skipped: 'unscanned' };
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
      update: (mutate) => updateRow(repo, row.id, row.projectId, mutate)
    });
    const status = (result && result.status) || 'sent';
    if (status === 'held') {
      logger.info(`[sync-out] ${job.consumer} held ${job.id}, version ${version} left unsent`, job);
      return { status };
    }
    const { row: stored } = await recordOutcome(repo, consumer, row,
      { status, version, record: result && result.record, at: new Date().toISOString() });
    // A write landed while this one was sending, so what reached the consumer may be older than the row.
    // Another delivery may already have recorded that newer version, so the follow-up sends regardless.
    if (stored && versionOf(stored) > version) {
      await send({
        kind: job.kind, consumer: job.consumer, id: job.id, projectId: stored.projectId ?? null, attempt: 1, resend: true
      });
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

module.exports = { enqueue, enqueueQuietly, consumers, consumersOf, run, updateRow, RETRY_VISIBILITY_SECONDS };
