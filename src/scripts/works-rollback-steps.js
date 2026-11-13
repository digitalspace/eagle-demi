'use strict';

// The rollback's project entry undos, its write-ahead log reading and the re-derive; rollback-business-works.js runs them.

const history = require('../repositories/project-staff-history');
const batches = require('./works-import-batch');
const { logger } = require('../utils/logger');

const PROJECT_ACTIONS = new Set(['addExternalId', 'appendHistory', 'closeHistory']);
const PROJECT_DONE = new Set(['removed', 'restored', 'unchanged', 'absent']);

const refuse = (message) => { throw new Error(message); };
/** `doc` without the Cosmos system keys (`_etag`, `_ts`, ...). */
const withoutSystem = doc => Object.fromEntries(Object.entries(doc).filter(([key]) => !key.startsWith('_')));
const stepKey = (action, target) => `${action}|${JSON.stringify(Object.entries(target).sort())}`;
const sameValue = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** Undo steps for the project entries the batch wrote, from the plan values and prior lists the backup holds. */
function projectSteps(demi, entries, backup) {
  const priorProject = projectId => backup.projects.find(one => one.projectId === projectId) || {};
  const priorEntry = (projectId, field, entryId) => (priorProject(projectId)[field] || []).find(one => one.id === entryId) ||
    refuse(`the backup holds no prior copy of a ${field} entry on project ${projectId}`);
  const outcome = (projectId, status) => {
    if (status !== 'changed' && !PROJECT_DONE.has(status)) refuse(`a project entry undo on project ${projectId} answered ${status}`);
    return status;
  };
  // Each step's entry records `changed` when staff's edit kept an entry, so a resumed run still reports the project.
  const recorded = statuses => ({ writtenEtag: null, result: statuses.includes('changed') ? 'changed' : 'undone' });
  const reopen = (projectId, field, close) => {
    const prior = priorEntry(projectId, field, close.id);
    const expected = history.historyEntrySha256({ ...prior, effectiveTo: close.effectiveTo });
    return async () => outcome(projectId, (await demi.restoreHistory(projectId, field, prior, expected)).status);
  };
  const steps = [];
  const removing = new Set();
  const seen = new Map();
  for (const entry of entries.filter(one => PROJECT_ACTIONS.has(one.action))) {
    const { projectId, field, entryId, system } = entry.target;
    const planned = backup.projectEntries.filter(one => one.action === entry.action && one.projectId === projectId);
    // A done entry with no written etag found the row already holding it, so it wrote nothing.
    const wrote = entry.state === 'intent' || entry.writtenEtag !== null;
    if (entry.action === 'addExternalId') {
      const key = `${projectId}|${system}`;
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      const value = planned.filter(one => one.pair.system === system)[n]?.pair.value ?? refuse(`the backup holds no addExternalId values for project ${projectId}`);
      const held = (priorProject(projectId).externalIds || []).some(one => one.system === system && sameValue(one.value, value));
      const valueKey = `${key}|${value.toLowerCase()}`;
      if (!wrote || held || removing.has(valueKey)) continue;
      removing.add(valueKey);
      steps.push({ action: 'removeExternalId', target: { projectId, system }, run: async () =>
        recorded([outcome(projectId, (await demi.removeExternalId(projectId, { system, value })).status)]) });
      continue;
    }
    if (!wrote) continue;
    const one = planned.find(item => item.field === field && (item.entryId ?? item.entry?.id) === entryId) ||
      refuse(`the backup holds no ${entry.action} values for project ${projectId}`);
    if (entry.action === 'closeHistory') {
      const undo = reopen(projectId, field, { id: entryId, effectiveTo: one.effectiveTo });
      steps.push({ action: 'restoreHistory', target: entry.target, run: async () => recorded([await undo()]) });
      continue;
    }
    const sha = history.historyEntrySha256(one.entry);
    const undoClose = one.close ? reopen(projectId, field, one.close) : null;
    steps.push({ action: 'removeHistory', target: entry.target, run: async () => {
      const status = outcome(projectId, (await demi.removeHistory(projectId, field, entryId, sha)).status);
      // A kept staff-edited entry stays the open one, so the entry it closed stays closed.
      return recorded(undoClose && status !== 'changed' ? [status, await undoClose()] : [status]);
    } });
  }
  return steps;
}

/** `patchDerived` on every project, a throw counted as conflict; ok only when patched + unchanged is the project count. */
async function rederive(demi, projectIds, lease, now) {
  const counts = { patched: 0, unchanged: 0, missing: 0, conflict: 0 };
  for (const projectId of projectIds) {
    await batches.beforeWrite(lease, now());
    let status;
    try {
      ({ status } = await demi.patchDerived(projectId));
    } catch (err) {
      logger.warn('[rollback-business-works] patchDerived failed', { projectId, code: err.code });
      status = 'conflict';
    }
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return { counts, ok: counts.patched + counts.unchanged === projectIds.length };
}

/** Writes the count check's counts and the project count. */
function writeCounts(write, counts, projectCount) {
  Object.entries(counts).forEach(([status, n]) => write(`${status}=${n}`));
  write(`projects=${projectCount}`);
}

/** Refuses unless the API's derive settings are exported; the config defaults would derive from other works than the API reads. */
function requireDeriveEnv(env = process.env) {
  const unset = ['WORKS_READ', 'WORKS_READ_SOURCES'].find(name => !env[name]?.trim());
  if (unset) refuse(`${unset} is not set`);
}

/** Per step key: how many of its entries are done and whether one is an intent. */
function loggedOf(log) {
  const logged = new Map();
  for (const entry of log) {
    const key = stepKey(entry.action, entry.target);
    const seen = logged.get(key) || { done: 0, intent: false };
    if (entry.state === 'done') seen.done += 1;
    else seen.intent = true;
    logged.set(key, seen);
  }
  return logged;
}

/** The intent entries no later entry of the same step finished. */
function openSteps(log) {
  return log.filter((entry, index) => entry.state === 'intent' &&
    !log.slice(index + 1).some(later => later.state === 'done' && stepKey(later.action, later.target) === stepKey(entry.action, entry.target)));
}

module.exports = { withoutSystem, stepKey, projectSteps, rederive, loggedOf, openSteps, requireDeriveEnv, writeCounts };
