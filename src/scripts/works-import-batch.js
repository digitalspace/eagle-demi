'use strict';

// The works loader's import lock, ImportBatch header and write-ahead ImportBatchEntry items, all in `lists`.
// None carries `read[]`, so no caller-facing lists read returns them, as with the catalog items.

const cosmos = require('../db/cosmos-nosql');

const CONTAINER = 'lists';
const KINDS = Object.freeze({ LOCK: 'ImportLock', BATCH: 'ImportBatch', ENTRY: 'ImportBatchEntry' });
const LOCK_ID = 'import-lock';
const LEASE_MS = 2 * 60 * 60 * 1000;
const RENEW_EVERY = 100;
const ACTIONS = Object.freeze(['create', 'update', 'tombstone', 'marker', 'addExternalId', 'appendHistory', 'closeHistory', 'derive',
  'remove', 'restore', 'removeExternalId', 'removeHistory', 'restoreHistory']);
// Each target names a document, a project list entry or an id system; never a sourceKey, number or staff value.
const TARGET_SHAPES = Object.freeze([['id', 'projectId'], ['entryId', 'field', 'projectId'], ['projectId', 'system']]);

const refuse = (message) => { throw new Error(message); };

const lockItem = (batchId, expiresAt) => ({ kind: KINDS.LOCK, id: LOCK_ID, batchId, expiresAt });

function leaseLost(message, cause) {
  return Object.assign(new Error(message, cause && { cause }), { code: 'LEASE_LOST' });
}

/** Takes the lock for `batchId`; refused while any lock item exists, expired or not, or any batch is pending. */
async function takeLock(batchId, now = Date.now()) {
  if (await readLock()) refuse('the import lock exists, expired or not');
  if ((await batchIdsWithStatus('pending')).length) refuse('an ImportBatch is pending');
  const expiresAt = new Date(now + LEASE_MS).toISOString();
  try {
    const created = await cosmos.create(CONTAINER, lockItem(batchId, expiresAt));
    return { batchId, etag: created._etag, expiresAt, writes: 0 };
  } catch (err) {
    if (err.code === 409) refuse('the import lock exists, expired or not');
    throw err;
  }
}

/** The lock item with its `_etag`; null when absent. */
async function readLock() {
  return cosmos.readItem(CONTAINER, LOCK_ID, KINDS.LOCK);
}

/** Takes over an expired lock held by one of `heldBy` (replace under its etag, one taker wins), or creates it when absent. */
async function takeOverLock(batchId, now = Date.now(), heldBy = [batchId]) {
  const lock = await readLock();
  if (lock) {
    const expires = Date.parse(lock.expiresAt);
    if (Number.isNaN(expires)) refuse('the import lock has no readable expiry');
    if (!heldBy.includes(lock.batchId)) refuse('the import lock belongs to another batch');
    if (now < expires) refuse('the import lease is fresh');
  }
  const expiresAt = new Date(now + LEASE_MS).toISOString();
  try {
    const taken = lock
      ? await cosmos.replace(CONTAINER, LOCK_ID, KINDS.LOCK, lockItem(batchId, expiresAt), lock._etag)
      : await cosmos.create(CONTAINER, lockItem(batchId, expiresAt));
    return { batchId, etag: taken._etag, expiresAt, writes: 0 };
  } catch (err) {
    if ([404, 409, 412].includes(err.code)) refuse('another run took the import lock');
    throw err;
  }
}

/** Run before each write: stops on a passed local expiry, and renews under the lock's etag every RENEW_EVERY writes. */
async function beforeWrite(lease, now = Date.now()) {
  if (now >= Date.parse(lease.expiresAt)) throw leaseLost('the import lease expired');
  if (lease.writes > 0 && lease.writes % RENEW_EVERY === 0) {
    const expiresAt = new Date(now + LEASE_MS).toISOString();
    let renewed;
    try {
      renewed = await cosmos.replace(CONTAINER, LOCK_ID, KINDS.LOCK, lockItem(lease.batchId, expiresAt), lease.etag);
    } catch (err) {
      throw leaseLost('the import lease renewal failed', err);
    }
    Object.assign(lease, { etag: renewed._etag, expiresAt });
  }
  lease.writes += 1;
}

/** The `pending` ImportBatch header, `batchKind` 'load' unless `fields` names another; a load's `fields` hold refs, hashes and the backup's name. */
async function createBatch(batchId, fields, now = Date.now()) {
  const item = { batchKind: 'load', ...fields, kind: KINDS.BATCH, id: batchId, status: 'pending', startedAt: new Date(now).toISOString() };
  const created = await cosmos.create(CONTAINER, item);
  return { item, etag: created._etag };
}

/** Marks the batch complete under its etag, then deletes the lock under the lease's etag. */
async function completeBatch(batch, lease, now = Date.now()) {
  await cosmos.replace(CONTAINER, batch.item.id, KINDS.BATCH,
    { ...batch.item, status: 'complete', completedAt: new Date(now).toISOString() }, batch.etag);
  await releaseLock(lease);
}

/** Deletes the lock under the lease's etag; a run that stops before its first write leaves no lock behind. */
async function releaseLock(lease) {
  await cosmos.remove(CONTAINER, LOCK_ID, KINDS.LOCK, { etag: lease.etag });
}

/** The ImportBatch header with its `_etag`; null when absent. */
async function readBatch(batchId) {
  return cosmos.readItem(CONTAINER, batchId, KINDS.BATCH);
}

async function batchIdsWithStatus(status) {
  const ids = await cosmos.query(CONTAINER, {
    query: 'SELECT VALUE c.id FROM c WHERE c.status = @status', parameters: [{ name: '@status', value: status }]
  }, { partitionKey: KINDS.BATCH });
  return ids.items;
}

/** Every header of `status`, earliest completion first; batches are few, so one id query, then a point read each. */
async function batchesWithStatus(status) {
  const headers = (await Promise.all((await batchIdsWithStatus(status)).map(readBatch))).filter(Boolean);
  return headers.sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)));
}

/** The latest `complete` batch of `batchKind`, or null. */
async function latestCompleteBatch(batchKind = 'load') {
  return (await batchesWithStatus('complete')).filter(batch => batch.batchKind === batchKind).at(-1) || null;
}

/** The batch's entries by seq, point reads up to the highest seq stored; refused when one in between is missing. */
async function listEntries(batchId) {
  const max = await cosmos.query(CONTAINER, {
    query: 'SELECT VALUE MAX(c.seq) FROM c WHERE c.batchId = @batchId', parameters: [{ name: '@batchId', value: batchId }]
  }, { partitionKey: KINDS.ENTRY });
  const count = max.items[0] ?? 0;
  const entries = await Promise.all(Array.from({ length: count }, (_, n) => cosmos.readItem(CONTAINER, `${batchId}:${n + 1}`, KINDS.ENTRY)));
  if (entries.some(entry => !entry)) refuse(`batch ${batchId} is missing an entry below seq ${count}`);
  return entries;
}

/** Marks the batch `rolledBack` under the etag `batch` was read with. */
async function markRolledBack(batch, now = Date.now()) {
  const { _etag: etag, ...item } = batch;
  await cosmos.replace(CONTAINER, item.id, KINDS.BATCH, { ...item, status: 'rolledBack', rolledBackAt: new Date(now).toISOString() }, etag);
}

function checkedTarget(target) {
  const keys = Object.keys(target || {}).sort().join();
  const shaped = TARGET_SHAPES.some(shape => shape.join() === keys) &&
    Object.values(target).every(value => typeof value === 'string' && value !== '');
  return shaped ? { ...target } : refuse('an ImportBatchEntry target must be {projectId, id}, {projectId, field, entryId} or {projectId, system}');
}

/**
 * Records the intent entry, runs `write` (resolving the written etag), then marks the entry done.
 * `run` is `{batchId, lease, seq}`; `seq` counts up across the batch.
 */
async function writeAhead(run, { target, action, priorEtag = null }, write, now = Date.now()) {
  if (!ACTIONS.includes(action)) refuse(`unknown ImportBatchEntry action ${action}`);
  const entry = { target: checkedTarget(target), action, priorEtag };
  await beforeWrite(run.lease, now);
  run.seq += 1;
  const item = { kind: KINDS.ENTRY, id: `${run.batchId}:${run.seq}`, batchId: run.batchId, seq: run.seq, ...entry, state: 'intent' };
  const created = await cosmos.create(CONTAINER, item);
  const writtenEtag = await write();
  await cosmos.replace(CONTAINER, item.id, KINDS.ENTRY, { ...item, writtenEtag: writtenEtag ?? null, state: 'done' }, created._etag);
  return writtenEtag;
}

module.exports = {
  CONTAINER, KINDS, LOCK_ID, LEASE_MS, RENEW_EVERY, ACTIONS,
  takeLock, takeOverLock, beforeWrite, releaseLock, createBatch, completeBatch, writeAhead,
  readLock, readBatch, batchesWithStatus, latestCompleteBatch, listEntries, markRolledBack
};
