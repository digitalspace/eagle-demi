'use strict';

// `--rederive <batchId>` and `--rederive <batchId> --unflip` of rollback-business-works.js. The flip probe reads the
// public project route anonymously, as eagle-public does.

const config = require('../config');
const batches = require('./works-import-batch');
const { rederive, requireDeriveEnv, writeCounts } = require('./works-rollback-steps');

// Test only: business works stay on test, so there is no prod entry.
const API_BASE = Object.freeze({ test: 'https://demi-api-fc-test.azurewebsites.net/api' });
const PROBE_TIMEOUT_MS = 30 * 1000;
const FLIP_SOURCES = Object.freeze(['track', 'sheet']);
const WORK_ACTIONS = new Set(['create', 'update']);

const refuse = (message) => { throw new Error(message); };

/** global fetch with a timeout; tests pass their own. */
const timedFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });

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
  return new Set(body.works.map(work => work && work.workId));
}

/** The response body as JSON; refused, naming only the project and status, unless it is this project with a works list. */
async function bodyOf(res, projectId) {
  const body = await res.json().catch(() => null);
  if (!body || typeof body !== 'object') refuse(`the probe of project ${projectId} answered ${res.status} with no JSON body`);
  if (String(body.id) !== String(projectId) || !Array.isArray(body.works)) refuse(`the probe of project ${projectId} answered ${res.status} with no works of that project`);
  return body;
}

/**
 * The first public batch project whose batch sheet works a sheet read shows (a reverted marker shows none), read with no
 * Authorization header; resolves `{projectId, shown}`, the ones the response holds, or `{none}` saying why there is none.
 */
async function probe({ demi, fetchFn, env }, entries) {
  const base = API_BASE[env] || refuse(`no API base for ${env}`);
  let none = 'no public project';
  for (const [projectId, ids] of sheetWorkIds(entries)) {
    const row = await demi.project(projectId);
    if (!row || !Array.isArray(row.read) || !row.read.includes('public')) continue;
    none = 'no probe-able project';
    const readable = new Set(await demi.readWorkIds(row, FLIP_SOURCES));
    const expected = ids.filter(id => readable.has(id));
    if (!expected.length) continue;
    const res = await fetchFn(`${base}/projects/${encodeURIComponent(projectId)}`, { headers: { Accept: 'application/json' }, redirect: 'error' });
    if (!res.ok) refuse(`the probe of project ${projectId} answered ${res.status}`);
    const held = workIdsOf(await bodyOf(res, projectId));
    return { projectId, shown: expected.filter(id => held.has(id)) };
  }
  return { none };
}

/** The lock for `batchId`: taken fresh, or taken over once a run of this batch left it expired. */
async function lockFor(batchId, now) {
  if (!await batches.readLock()) return batches.takeLock(batchId, now);
  if ((await batches.batchesWithStatus('pending')).length) refuse('an ImportBatch is pending');
  return batches.takeOverLock(batchId, now, [batchId]);
}

/**
 * Re-derives every project of a complete load batch with WORKS_READ_SOURCES. Without --unflip sheet must be in it and
 * the probe must show a batch sheet work; with --unflip sheet must not be and the probe must show none.
 */
async function rederiveBatch(o, ctx) {
  const { demi, now, write } = ctx;
  const batchId = o.rederive;
  const unflip = o.unflip === true;
  requireDeriveEnv();
  if (unflip && config.worksReadSources.includes('sheet')) refuse('--unflip needs WORKS_READ_SOURCES without sheet');
  if (!unflip && !(config.worksRead && config.worksReadSources.includes('sheet'))) refuse('--rederive needs WORKS_READ=true and sheet in WORKS_READ_SOURCES');
  const batch = await batches.readBatch(batchId);
  if (!batch || batch.batchKind !== 'load' || batch.status !== 'complete') refuse('--rederive acts only on a complete load batch');
  const entries = await batches.listEntries(batchId);

  const seen = await probe(ctx, entries);
  if (seen.none) write(`flipProbe=${seen.none}`);
  else if (!unflip && !seen.shown.length) refuse(`the probe of project ${seen.projectId} holds no sheet work of the batch; nothing was re-derived`);
  else if (unflip && seen.shown.length) refuse(`the probe of project ${seen.projectId} still holds ${seen.shown.length} sheet works of the batch; nothing was re-derived`);
  else write(`flipProbe=${seen.projectId}`);

  const projectIds = [...new Set(entries.map(entry => entry.target.projectId))];
  const lease = await lockFor(batchId, now());
  try {
    const { counts, ok } = await rederive(demi, projectIds, lease, now);
    write(`batchId=${batchId}`);
    writeCounts(write, counts, projectIds.length);
    return ok ? 0 : 1;
  } finally {
    await batches.releaseQuietly(lease);
  }
}

module.exports = { API_BASE, rederiveBatch, timedFetch };
