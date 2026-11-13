'use strict';

// `--revert-override` and `--reapply-override` of rollback-business-works.js: turn the live sheet override marker of
// each named project off or on, in an override ImportBatch, then re-derive those projects. Track documents are never written.

const crypto = require('crypto');
const { OVERRIDE_MARKER_ID } = require('../domain/work-model');
const batches = require('./works-import-batch');
const { rederive } = require('./works-rollback-steps');
const { writeCounts } = require('./works-import-rederive');

const OWNER = 'sheet';

const refuse = (message) => { throw new Error(message); };
const withoutSystem = doc => Object.fromEntries(Object.entries(doc).filter(([key]) => !key.startsWith('_')));

/** `--project <id>`, or with `--all` every project whose marker the latest complete load batch wrote. */
async function projectsOf(o) {
  if (Boolean(o.project) === Boolean(o.all)) refuse('name one of --project <id> or --all');
  if (o.project) return [o.project];
  const latest = await batches.latestCompleteBatch('load');
  if (!latest) refuse('--all needs a complete load batch');
  const ids = (await batches.listEntries(latest.id)).filter(entry => entry.action === 'marker').map(entry => entry.target.projectId);
  return ids.length ? [...new Set(ids)] : refuse('the latest complete load batch wrote no marker');
}

/**
 * The live marker of each project, as read now; refuses before any write when one is absent or not the sheet's.
 * `deactivatedBy` goes, so a later load keeps a staff revert off (works-import-plan.js turns on only `'load'` ones).
 */
async function markerWrites({ demi, ownerOf }, projectIds, active) {
  const writes = [];
  for (const projectId of projectIds) {
    const current = await demi.work(projectId, OVERRIDE_MARKER_ID);
    if (!current) refuse(`project ${projectId} has no override marker; nothing was written`);
    if (ownerOf(current) !== OWNER) refuse(`the override marker on project ${projectId} is not owned by ${OWNER}; nothing was written`);
    if (current.active === active && current.deactivatedBy === undefined) continue;
    writes.push({ projectId, current, values: { active, deactivatedBy: null } });
  }
  return writes;
}

/** `current` with `values`; a null `deactivatedBy` is left out. */
function withValues(current, { active, deactivatedBy }) {
  const doc = { ...withoutSystem(current), active };
  delete doc.deactivatedBy;
  return deactivatedBy === null ? doc : { ...doc, deactivatedBy };
}

/**
 * A pending override batch `batchId` holding `writes`, each entry recording the marker's prior values; `fields` go
 * on the header. Resolves the header for completeBatch; a refused write leaves it pending, for --rollback-incomplete.
 */
async function writeMarkers({ demi, now }, { lease, batchId }, writes, fields) {
  const header = await batches.createBatch(batchId, { batchKind: 'override', ...fields }, now());
  const run = { batchId, lease, seq: 0 };
  for (const { projectId, current, values } of writes) {
    const prior = { active: current.active, deactivatedBy: current.deactivatedBy ?? null };
    await batches.writeAhead(run, { target: { projectId, id: OVERRIDE_MARKER_ID }, action: 'marker', priorEtag: current._etag, prior }, async () => {
      const result = await demi.saveWork(withValues(current, values), { owner: OWNER, etag: current._etag, existing: current });
      return result.status === 'written' ? result.etag : refuse(`the marker write on project ${projectId} answered ${result.status}`);
    }, now());
  }
  return header;
}

/** Re-derives `projectIds`, then completes `header` and frees the lock; complete even when the count check fails, as every write landed. */
async function deriveAndComplete({ demi, now, write }, header, lease, projectIds) {
  const { counts, ok } = await rederive(demi, projectIds, lease, now);
  await batches.completeBatch(header, lease, now());
  lease.released = true;
  writeCounts(write, counts, projectIds.length);
  return ok ? 0 : 1;
}

/** Sets `active` on the markers of the projects `o` names, under the import lock; ctx `ownerOf` is works.js's. */
async function setOverride(o, ctx, active) {
  const { now, write } = ctx;
  const projectIds = await projectsOf(o);
  const lease = await batches.takeLock(crypto.randomUUID(), now());
  try {
    const writes = await markerWrites(ctx, projectIds, active);
    const header = await writeMarkers(ctx, { lease, batchId: lease.batchId }, writes, { active });
    write(`batchId=${lease.batchId}`);
    write(`markers=${writes.length}`);
    return await deriveAndComplete(ctx, header, lease, projectIds);
  } finally {
    await batches.releaseQuietly(lease);
  }
}

/**
 * Whether the stopped batch's write on `current` landed: a done entry by its writtenEtag; an intent entry when the
 * marker left priorEtag and holds the batch's `active`. False also when the marker moved since.
 */
function landed(entry, current, batch) {
  if (!current) return false;
  if (entry.state === 'done') return current._etag === entry.writtenEtag;
  return current._etag !== entry.priorEtag && current.active === batch.active;
}

/**
 * `--rollback-incomplete` of an override batch: landed writes get their prior values back in a new complete override
 * batch, so a later --rollback expects its etags; a moved marker is kept and reported. Resolves the exit code.
 */
async function rollbackIncompleteOverride(ctx, batchId) {
  const pending = async () => {
    const batch = await batches.readBatch(batchId);
    return batch && batch.batchKind === 'override' && batch.status === 'pending' ? batch : refuse('--rollback-incomplete acts only on a pending batch');
  };
  await pending();
  const lease = await batches.takeOverLock(batchId, ctx.now());
  try {
    return await undoOverride(ctx, await pending(), lease);
  } finally {
    await batches.releaseQuietly(lease);
  }
}

async function undoOverride(ctx, batch, lease) {
  const { demi, now, write } = ctx;
  const entries = await batches.listEntries(batch.id);
  const writes = [];
  const moved = new Set();
  for (const entry of entries) {
    const { projectId, id } = entry.target;
    if (!entry.prior) refuse(`an entry on project ${projectId} records no prior marker values; nothing was undone`);
    const current = await demi.work(projectId, id);
    if (landed(entry, current, batch)) writes.push({ projectId, current, values: entry.prior });
    else if (entry.state === 'done' || current?._etag !== entry.priorEtag) moved.add(projectId);
  }
  const header = await writeMarkers(ctx, { lease, batchId: crypto.randomUUID() }, writes, { targetBatchId: batch.id });
  await batches.markBatch(batch, 'rolledBack', now());
  write(`batchId=${batch.id}`);
  write(`markers=${writes.length}`);
  write(`moved=${moved.size}`);
  moved.forEach(projectId => write(`movedProject=${projectId}`));
  return deriveAndComplete(ctx, header, lease, [...new Set(entries.map(entry => entry.target.projectId))]);
}

const revertOverride = (o, ctx) => setOverride(o, ctx, false);
const reapplyOverride = (o, ctx) => setOverride(o, ctx, true);

module.exports = { revertOverride, reapplyOverride, rollbackIncompleteOverride };
