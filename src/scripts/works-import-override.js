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
    const doc = { ...withoutSystem(current), active };
    delete doc.deactivatedBy;
    writes.push({ projectId, current, doc });
  }
  return writes;
}

/** Sets `active` on the markers of the projects `o` names, under the import lock; ctx `ownerOf` is works.js's. */
async function setOverride(o, ctx, active) {
  const { demi, now, write } = ctx;
  const projectIds = await projectsOf(o);
  const batchId = crypto.randomUUID();
  const lease = await batches.takeLock(batchId, now());
  try {
    const writes = await markerWrites(ctx, projectIds, active);
    const batch = await batches.createBatch(batchId, { batchKind: 'override', active }, now());
    const run = { batchId, lease, seq: 0 };
    for (const { projectId, current, doc } of writes) {
      await batches.writeAhead(run, { target: { projectId, id: OVERRIDE_MARKER_ID }, action: 'marker', priorEtag: current._etag }, async () => {
        const result = await demi.saveWork(doc, { owner: OWNER, etag: current._etag, existing: current });
        return result.status === 'written' ? result.etag : refuse(`the marker write on project ${projectId} answered ${result.status}`);
      }, now());
    }
    const { counts, ok } = await rederive(demi, projectIds, lease, now);
    // Complete even when the count check fails: the marker writes all landed, and a pending batch blocks every run.
    await batches.completeBatch(batch, lease, now());
    lease.released = true;
    write(`batchId=${batchId}`);
    write(`markers=${writes.length}`);
    writeCounts(write, counts, projectIds.length);
    return ok ? 0 : 1;
  } finally {
    await batches.releaseQuietly(lease);
  }
}

const revertOverride = (o, ctx) => setOverride(o, ctx, false);
const reapplyOverride = (o, ctx) => setOverride(o, ctx, true);

module.exports = { revertOverride, reapplyOverride };
