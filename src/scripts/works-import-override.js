'use strict';

// `--revert-override` and `--reapply-override` of rollback-business-works.js: turn the live sheet override marker of
// each named project off or on, in an override ImportBatch, then re-derive those projects. Track documents are never written.

const crypto = require('crypto');
const { OVERRIDE_MARKER_ID } = require('../domain/work-model');
const batches = require('./works-import-batch');
const { stepKey, rederive, loggedOf, requireDeriveEnv } = require('./works-rollback-steps');
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

/** Writes the marker of `write` ahead, recording its prior values for --rollback-incomplete; resolves the written etag. */
function writeMarker(demi, run, { projectId, current, values }, now) {
  const prior = { active: current.active, deactivatedBy: current.deactivatedBy ?? null };
  return batches.writeAhead(run, { target: { projectId, id: OVERRIDE_MARKER_ID }, action: 'marker', priorEtag: current._etag, prior }, async () => {
    const result = await demi.saveWork(withValues(current, values), { owner: OWNER, etag: current._etag, existing: current });
    return result.status === 'written' ? result.etag : refuse(`the marker write on project ${projectId} answered ${result.status}`);
  }, now());
}

/**
 * Sets `active` on the markers of the projects `o` names, in an override batch under the import lock, then
 * re-derives them; ctx `ownerOf` is works.js's. A failed write leaves the batch pending for --rollback-incomplete.
 */
async function setOverride(o, ctx, active) {
  const { demi, now, write } = ctx;
  requireDeriveEnv();
  const projectIds = await projectsOf(o);
  const lease = await batches.takeLock(crypto.randomUUID(), now());
  try {
    const writes = await markerWrites(ctx, projectIds, active);
    const batchId = lease.batchId;
    const header = await batches.createBatch(batchId, { batchKind: 'override', active }, now());
    write(`batchId=${batchId}`);
    const run = { batchId, lease, seq: 0 };
    for (const one of writes) {
      try {
        await writeMarker(demi, run, one, now);
      } catch (err) {
        err.message = `${err.message}; override batch ${batchId} stays pending`;
        throw err;
      }
    }
    const { counts, ok } = await rederive(demi, projectIds, lease, now);
    // Complete even when the count check fails: every write landed, and a pending batch blocks every run.
    await batches.completeBatch(header, lease, now());
    lease.released = true;
    write(`markers=${writes.length}`);
    writeCounts(write, counts, projectIds.length);
    return ok ? 0 : 1;
  } finally {
    await batches.releaseQuietly(lease);
  }
}

/**
 * Whether the stopped batch's write on `current` landed: a done entry by its writtenEtag; an intent entry when the
 * marker left priorEtag and holds what the write sets (the batch's `active`, no `deactivatedBy`).
 */
function landed(entry, current, batch) {
  if (!current) return false;
  if (entry.state === 'done') return current._etag === entry.writtenEtag;
  return current._etag !== entry.priorEtag && current.active === batch.active && current.deactivatedBy === undefined;
}

const holds = (current, prior) => current.active === prior.active && (current.deactivatedBy ?? null) === prior.deactivatedBy;

/** Puts `values` back on the marker under the etag read before; resolves the written etag. */
async function restoreMarker(demi, current, values) {
  const { projectId } = current;
  const result = await demi.saveWork(withValues(current, values), { owner: OWNER, etag: current._etag, existing: current });
  return result.status === 'written' ? result.etag : refuse(`the marker restore on project ${projectId} answered ${result.status}`);
}

/** One restore step per landed marker write of `target`, all checked before any write; a moved marker is kept and reported. */
async function restoreSteps({ demi, ownerOf }, target, entries, logged, note) {
  const steps = [];
  const moved = new Set();
  for (const entry of entries.filter(one => one.action === 'marker')) {
    const { projectId, id } = entry.target;
    const log = logged.get(stepKey('restore', entry.target));
    if (log?.done) continue;
    const current = await demi.work(projectId, id);
    if (current && ownerOf(current) !== OWNER) refuse(`the override marker on project ${projectId} is not owned by ${OWNER}; ${note}`);
    // A resumed restore whose write landed is logged done with the etag it left, so a later rollback can chain on it.
    if (current && holds(current, entry.prior)) {
      if (log?.intent) steps.push({ target: entry.target, priorEtag: null, run: async () => current._etag });
      continue;
    }
    if (landed(entry, current, target)) steps.push({ target: entry.target, priorEtag: current._etag, run: () => restoreMarker(demi, current, entry.prior) });
    else if (entry.state === 'done' || current?._etag !== entry.priorEtag) moved.add(projectId);
  }
  return { steps, moved };
}

/**
 * `--rollback-incomplete` of a pending override batch `target`, as rollback-business-works.js undoes a load: restore
 * steps written ahead in a rollback batch (or resuming `resumed`), then the re-derive; `target` is marked rolledBack
 * only once the count check passes. Resolves the exit code.
 */
async function undoOverrideBatch(ctx, { target, entries, lease, resumed }) {
  const { demi, now, write } = ctx;
  const log = resumed ? await batches.listEntries(resumed.id) : [];
  const note = `this run wrote nothing${resumed ? `; rollback batch ${resumed.id} stays pending` : ''}`;
  const { steps, moved } = await restoreSteps(ctx, target, entries, loggedOf(log), note);
  const header = resumed
    ? { item: withoutSystem(resumed), etag: resumed._etag }
    : await batches.createBatch(crypto.randomUUID(), { batchKind: 'rollback', targetBatchId: target.id }, now());
  const run = { batchId: header.item.id, lease, seq: log.length };
  for (const step of steps) {
    try {
      await batches.writeAhead(run, { target: step.target, action: 'restore', priorEtag: step.priorEtag }, step.run, now());
    } catch (err) {
      err.message = `${err.message}; rollback batch ${header.item.id} stays pending`;
      throw err;
    }
  }
  const projectIds = [...new Set(entries.map(entry => entry.target.projectId))];
  const { counts, ok } = await rederive(demi, projectIds, lease, now);
  write(`batchId=${target.id}`);
  write(`rollbackBatchId=${header.item.id}`);
  write(`markers=${steps.length}`);
  write(`moved=${moved.size}`);
  moved.forEach(projectId => write(`movedProject=${projectId}`));
  writeCounts(write, counts, projectIds.length);
  if (!ok) return 1;
  await batches.markBatch(target, 'rolledBack', now());
  await batches.completeBatch(header, lease, now());
  lease.released = true;
  return 0;
}

const revertOverride = (o, ctx) => setOverride(o, ctx, false);
const reapplyOverride = (o, ctx) => setOverride(o, ctx, true);

module.exports = { revertOverride, reapplyOverride, undoOverrideBatch };
