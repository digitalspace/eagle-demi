'use strict';

// `--rederive <batchId>` and `--rederive <batchId> --unflip` of rollback-business-works.js. The flip probe reads the
// public project route anonymously, as eagle-public does.

const config = require('../config');
const batches = require('./works-import-batch');
const { rederive, requireDeriveEnv } = require('./works-rollback-steps');

// Test only: business works stay on test, so there is no prod entry.
const API_BASE = Object.freeze({ test: 'https://demi-api-fc-test.azurewebsites.net/api' });
const PROBE_TIMEOUT_MS = 30 * 1000;
const FLIP_SOURCES = Object.freeze(['track', 'sheet']);
const WORK_ACTIONS = new Set(['create', 'update']);

const refuse = (message) => { throw new Error(message); };

/** global fetch with a timeout; tests pass their own. */
const timedFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });

/** Writes the count check's counts and the project count. */
function writeCounts(write, counts, projectCount) {
  Object.entries(counts).forEach(([status, n]) => write(`${status}=${n}`));
  write(`projects=${projectCount}`);
}

/** Sheet work ids the batch created or updated, by project. */
function sheetWorkIds(entries) {
  const byProject = new Map();
  for (const { target } of entries.filter(one => WORK_ACTIONS.has(one.action))) {
    byProject.set(target.projectId, [...(byProject.get(target.projectId) || []), target.id]);
  }
  return byProject;
}

/**
 * The `workId` of each work the public project read carries, composed from the works the API reads now. Not
 * `assessments[].workIds`: those are stored, so they keep sheet ids until this re-derive runs.
 */
function workIdsOf(body) {
  return new Set((Array.isArray(body.works) ? body.works : []).map(work => work && work.workId));
}

/**
 * The first batch project with a sheet work whose row `read` holds the public token, read anonymously (no
 * Authorization header); resolves `{projectId, shown}`, the batch's sheet work ids the response holds, or null.
 */
async function probe({ demi, fetchFn, env }, entries) {
  const base = API_BASE[env];
  for (const [projectId, ids] of sheetWorkIds(entries)) {
    const row = await demi.project(projectId);
    if (!row || !Array.isArray(row.read) || !row.read.includes('public')) continue;
    const res = await fetchFn(`${base}/projects/${encodeURIComponent(projectId)}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) refuse(`the probe of project ${projectId} answered ${res.status}`);
    const held = workIdsOf(await res.json());
    return { projectId, shown: ids.filter(id => held.has(id)) };
  }
  return null;
}

/**
 * Re-derives every project of a complete load batch. Without --unflip the probe must show a sheet work of the batch
 * and the derive reads Track and sheet; with it the probe must show none and the derive reads WORKS_READ_SOURCES.
 */
async function rederiveBatch(o, ctx) {
  const { demi, now, write } = ctx;
  const batchId = o.rederive;
  const unflip = o.unflip === true;
  requireDeriveEnv();
  if (unflip && config.worksReadSources.includes('sheet')) refuse('--unflip needs WORKS_READ_SOURCES without sheet');
  const batch = await batches.readBatch(batchId);
  if (!batch || batch.batchKind !== 'load' || batch.status !== 'complete') refuse('--rederive acts only on a complete load batch');
  const entries = await batches.listEntries(batchId);

  const seen = await probe(ctx, entries);
  if (!seen) write('flipProbe=no public project');
  else if (!unflip && !seen.shown.length) refuse(`the probe of project ${seen.projectId} holds no sheet work of the batch; nothing was re-derived`);
  else if (unflip && seen.shown.length) refuse(`the probe of project ${seen.projectId} still holds ${seen.shown.length} sheet works of the batch; nothing was re-derived`);
  else write(`flipProbe=${seen.projectId}`);

  const projectIds = [...new Set(entries.map(entry => entry.target.projectId))];
  const lease = await batches.takeLock(batchId, now());
  try {
    // Without --unflip the derive reads Track and sheet whatever WORKS_READ_SOURCES says.
    const deriving = unflip ? demi : { ...demi, patchDerived: projectId => demi.patchDerived(projectId, FLIP_SOURCES) };
    const { counts, ok } = await rederive(deriving, projectIds, lease, now);
    write(`batchId=${batchId}`);
    writeCounts(write, counts, projectIds.length);
    return ok ? 0 : 1;
  } finally {
    await batches.releaseQuietly(lease);
  }
}

module.exports = { API_BASE, rederiveBatch, timedFetch, writeCounts };
