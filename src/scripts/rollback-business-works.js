'use strict';

// Undoes a business works load on test: `--rollback <batchId>` for the latest complete load batch,
// `--rollback-incomplete <batchId>` for a pending one whose lease expired. Output names project and document ids and counts only.

const crypto = require('crypto');
const { isDeepStrictEqual, parseArgs } = require('util');
const works = require('../repositories/works');
const projects = require('../repositories/projects');
const history = require('../repositories/project-staff-history');
const { deriveInputs } = require('../domain/works-derive');
const { testEnvironment } = require('./works-import-inputs');
const batches = require('./works-import-batch');
const { logger } = require('../utils/logger');

const OWNER = 'sheet';
const DOC_ACTIONS = new Set(['create', 'update', 'tombstone', 'marker']);
// Writes of a later batch that move a document's etag: a revert or reapply of a marker, or a rollback's undo.
const LATER_DOC_ACTIONS = new Set([...DOC_ACTIONS, 'remove', 'restore']);
const LATER_KINDS = new Set(['override', 'rollback']);
const PROJECT_ACTIONS = new Set(['addExternalId', 'appendHistory', 'closeHistory']);
const PROJECT_DONE = new Set(['removed', 'restored', 'unchanged', 'absent']);
const BACKUP_KEYS = ['backup', 'expect-backup-sha256', 'devbox-key', 'expect-devbox-fingerprint'];

const refuse = (message) => { throw new Error(message); };
const docKey = ({ projectId, id }) => `${projectId}|${id}`;
const stepKey = (action, target) => `${action}|${JSON.stringify(Object.entries(target).sort())}`;
const withoutSystem = doc => Object.fromEntries(Object.entries(doc).filter(([key]) => !key.startsWith('_')));
const sameValue = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** The repositories a rollback reads and writes; tests pass a fake. */
function liveDemi() {
  return {
    work: (projectId, id) => works.get(projectId, id),
    saveWork: (doc, options) => works.save(doc, options),
    removeWork: (target, options) => works.remove(target, options),
    removeExternalId: (projectId, pair) => history.removeExternalId(projectId, pair),
    removeHistory: (projectId, field, entryId, expectedSha256) => history.removeHistory(projectId, field, entryId, expectedSha256),
    restoreHistory: (projectId, field, prior, expectedSha256) => history.restoreHistory(projectId, field, prior, expectedSha256),
    patchDerived: projectId => projects.patchDerived(projectId, { inputsFor: deriveInputs })
  };
}

/** Each document the batch wrote, its entries in seq order, and the writtenEtag of the latest later write to it. */
function documentsOf(entries, laterEntries) {
  const docs = new Map();
  for (const entry of entries.filter(one => DOC_ACTIONS.has(one.action))) {
    const key = docKey(entry.target);
    if (!docs.has(key)) docs.set(key, { target: entry.target, entries: [] });
    docs.get(key).entries.push(entry);
  }
  for (const entry of laterEntries.filter(one => LATER_DOC_ACTIONS.has(one.action) && one.state === 'done')) {
    const doc = docs.get(docKey(entry.target));
    if (doc) doc.laterEtag = entry.writtenEtag;
  }
  return [...docs.values()];
}

/** The etag the document must carry, or `undefined` when an intent's write never landed (it still holds the etag before it). */
function expectedEtag(doc, current) {
  const last = doc.entries.at(-1);
  if (last.state === 'done') return doc.laterEtag !== undefined ? doc.laterEtag : last.writtenEtag;
  const before = doc.entries.length > 1 ? doc.entries.at(-2).writtenEtag : last.priorEtag;
  const now = current ? current._etag : null;
  return now === before && doc.entries.length === 1 ? undefined : now;
}

/** A created document is removed; one the backup holds is put back as it was, tombstones included. Resolves the written etag. */
async function undoDocument(demi, target, current, prior) {
  const result = prior
    ? await demi.saveWork(withoutSystem(prior), { owner: OWNER, etag: current._etag, existing: current })
    : await demi.removeWork(target, { owner: OWNER, etag: current._etag });
  if (result.status !== (prior ? 'written' : 'removed')) refuse(`undo of ${target.id} on project ${target.projectId} answered ${result.status}`);
  return prior ? result.etag ?? null : null;
}

/** One undo per document, all checked before any write: refused when one moved, is gone, is not the sheet's or has no copy to restore. */
async function documentSteps(demi, docs, priors, logged) {
  const steps = [];
  for (const doc of docs) {
    const { projectId, id } = doc.target;
    const where = `document ${id} on project ${projectId}`;
    const prior = priors.get(docKey(doc.target));
    if (!prior && doc.entries[0].priorEtag !== null) refuse(`the backup holds no prior copy of ${where}; nothing was undone`);
    const action = prior ? 'restore' : 'remove';
    const log = logged.get(stepKey(action, doc.target));
    if (log === 'done') continue;
    const current = await demi.work(projectId, id);
    // A resumed undo whose write landed: the document is gone, or holds the backup copy again.
    if (log === 'intent' && (prior ? current && isDeepStrictEqual(withoutSystem(current), withoutSystem(prior)) : !current)) continue;
    const expected = expectedEtag(doc, current);
    if (expected === undefined) continue;
    if (!current) refuse(`${where} is gone; nothing was undone`);
    if (works.ownerOf(current) !== OWNER) refuse(`${where} is not owned by ${OWNER}; nothing was undone`);
    if (current._etag !== expected) refuse(`${where} moved since the batch wrote it; nothing was undone`);
    steps.push({ action, target: doc.target, priorEtag: current._etag, run: () => undoDocument(demi, doc.target, current, prior) });
  }
  return steps;
}

/** Undo steps for the project entries the batch wrote, from the plan values and prior lists the backup holds. */
function projectSteps(demi, entries, backup, changed) {
  const priorProject = projectId => backup.projects.find(one => one.projectId === projectId) || {};
  const priorEntry = (projectId, field, entryId) => (priorProject(projectId)[field] || []).find(one => one.id === entryId) ||
    refuse(`the backup holds no prior copy of a ${field} entry on project ${projectId}`);
  const outcome = (projectId, status) => {
    if (status === 'changed') changed.add(projectId);
    else if (!PROJECT_DONE.has(status)) refuse(`a project entry undo on project ${projectId} answered ${status}`);
    return status;
  };
  const reopen = (projectId, field, close) => {
    const prior = priorEntry(projectId, field, close.id);
    const expected = history.historyEntrySha256({ ...prior, effectiveTo: close.effectiveTo });
    return async () => outcome(projectId, (await demi.restoreHistory(projectId, field, prior, expected)).status);
  };
  const steps = [];
  const removals = new Map();
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
      if (!wrote || held) continue;
      if (!removals.has(key)) {
        removals.set(key, []);
        steps.push({ action: 'removeExternalId', target: { projectId, system }, run: async () => {
          for (const one of removals.get(key)) outcome(projectId, (await demi.removeExternalId(projectId, { system, value: one })).status);
          return null;
        } });
      }
      if (!removals.get(key).some(one => sameValue(one, value))) removals.get(key).push(value);
      continue;
    }
    if (!wrote) continue;
    const one = planned.find(item => item.field === field && (item.entryId ?? item.entry?.id) === entryId) ||
      refuse(`the backup holds no ${entry.action} values for project ${projectId}`);
    if (entry.action === 'closeHistory') {
      const undo = reopen(projectId, field, { id: entryId, effectiveTo: one.effectiveTo });
      steps.push({ action: 'restoreHistory', target: entry.target, run: async () => { await undo(); return null; } });
      continue;
    }
    const sha = history.historyEntrySha256(one.entry);
    const undoClose = one.close ? reopen(projectId, field, one.close) : null;
    steps.push({ action: 'removeHistory', target: entry.target, run: async () => {
      const status = outcome(projectId, (await demi.removeHistory(projectId, field, entryId, sha)).status);
      // A kept staff-edited entry stays the open one, so the entry it closed stays closed.
      if (undoClose && status !== 'changed') await undoClose();
      return null;
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

/** Undoes `target` under its own write-ahead rollback batch (or resumes `resumed`) and re-derives; resolves the exit code. */
async function undoBatch(o, ctx, { target, entries, laterEntries, lease, resumed }) {
  const { demi, openBackup, now, write } = ctx;
  const expectSha256 = o['expect-backup-sha256'].toLowerCase();
  if (expectSha256 !== target.backupSha256) refuse('--expect-backup-sha256 is not the backup SHA-256 the batch recorded');
  const backup = await openBackup({
    sealedPath: o.backup, expectSha256, devboxKeyPath: o['devbox-key'],
    expectDevboxFingerprint: o['expect-devbox-fingerprint'], batchId: target.id, batchBackupSha256: target.backupSha256
  });
  if (!backup || backup.batchId !== target.id) refuse('the backup is not this batch\'s');
  const log = resumed ? await batches.listEntries(resumed.id) : [];
  const logged = new Map();
  for (const entry of log) if (logged.get(stepKey(entry.action, entry.target)) !== 'done') logged.set(stepKey(entry.action, entry.target), entry.state);

  const changed = new Set();
  const priors = new Map(backup.documents.map(doc => [docKey(doc), doc]));
  const steps = [
    ...await documentSteps(demi, documentsOf(entries, laterEntries), priors, logged),
    ...projectSteps(demi, entries, backup, changed).filter(step => logged.get(stepKey(step.action, step.target)) !== 'done')
  ];
  const header = resumed
    ? { item: withoutSystem(resumed), etag: resumed._etag }
    : await batches.createBatch(crypto.randomUUID(), { batchKind: 'rollback', targetBatchId: target.id }, now());
  const run = { batchId: header.item.id, lease, seq: log.length };
  for (const step of steps) {
    await batches.writeAhead(run, { target: step.target, action: step.action, priorEtag: step.priorEtag ?? null }, step.run, now());
  }

  const touched = [...new Set(entries.map(entry => entry.target.projectId))];
  const { counts, ok } = await rederive(demi, touched, lease, now);
  write(`batchId=${target.id}`);
  write(`rollbackBatchId=${header.item.id}`);
  write(`undone=${steps.length}`);
  write(`changed=${changed.size}`);
  changed.forEach(projectId => write(`changedProject=${projectId}`));
  Object.entries(counts).forEach(([status, n]) => write(`${status}=${n}`));
  write(`projects=${touched.length}`);
  if (!ok) return 1;
  await batches.markRolledBack(target, now());
  await batches.completeBatch(header, lease, now());
  lease.released = true;
  return 0;
}

/** Frees the lock unless the run completed; a failed release is logged so the first error stands. */
async function releaseQuietly(lease) {
  if (lease.released) return;
  try {
    await batches.releaseLock(lease);
  } catch (err) {
    logger.warn('[rollback-business-works] import lock release failed', { error: err.message });
  }
}

/** The pending rollback batch of `batchId` that a failed run left, or null. */
async function pendingRollbackOf(batchId) {
  return (await batches.batchesWithStatus('pending')).find(one => one.batchKind === 'rollback' && one.targetBatchId === batchId) || null;
}

/** The lock for undoing `batchId`: taken fresh, or taken over once expired when `batchId` or its pending rollback holds it. */
async function lockFor(batchId, resumed, now) {
  if (!resumed && !await batches.readLock()) return batches.takeLock(batchId, now);
  return batches.takeOverLock(batchId, now, [batchId, resumed?.id].filter(Boolean));
}

async function loadBatch(batchId, statuses, message) {
  const batch = await batches.readBatch(batchId);
  return batch && batch.batchKind === 'load' && statuses.includes(batch.status) ? batch : refuse(message);
}

async function rollback(o, ctx) {
  const batchId = o.rollback;
  const resumed = await pendingRollbackOf(batchId);
  const lease = await lockFor(batchId, resumed, ctx.now());
  try {
    const target = resumed
      ? await loadBatch(batchId, ['complete', 'rolledBack'], 'the pending rollback names a batch that is not a load')
      : await batches.latestCompleteBatch('load');
    if (!target || target.id !== batchId) refuse('--rollback acts only on the latest complete load batch');
    const later = (await batches.batchesWithStatus('complete')).filter(one => LATER_KINDS.has(one.batchKind) && one.startedAt > target.startedAt);
    const laterEntries = [];
    for (const one of later) laterEntries.push(...await batches.listEntries(one.id));
    return await undoBatch(o, ctx, { target, entries: await batches.listEntries(batchId), laterEntries, lease, resumed });
  } finally {
    await releaseQuietly(lease);
  }
}

async function rollbackIncomplete(o, ctx) {
  const batchId = o['rollback-incomplete'];
  const resumed = await pendingRollbackOf(batchId);
  const statuses = resumed ? ['pending', 'rolledBack'] : ['pending'];
  const message = '--rollback-incomplete acts only on a pending load batch';
  await loadBatch(batchId, statuses, message);
  const lease = await batches.takeOverLock(batchId, ctx.now(), [batchId, resumed?.id].filter(Boolean));
  try {
    const target = await loadBatch(batchId, statuses, message);
    return await undoBatch(o, ctx, { target, entries: await batches.listEntries(batchId), laterEntries: [], lease, resumed });
  } finally {
    await releaseQuietly(lease);
  }
}

const BACKUP_OPTIONS = Object.fromEntries(BACKUP_KEYS.map(name => [name, { type: 'string' }]));
// One entry per mode: its flags, the ones it needs, and its runner, which resolves the exit code.
const MODES = {
  rollback: { options: { rollback: { type: 'string' }, ...BACKUP_OPTIONS }, required: ['rollback', ...BACKUP_KEYS], run: rollback },
  'rollback-incomplete': {
    options: { 'rollback-incomplete': { type: 'string' }, ...BACKUP_OPTIONS }, required: ['rollback-incomplete', ...BACKUP_KEYS], run: rollbackIncomplete
  }
};

const HELP = [
  'Usage: rollback-business-works.js <mode> --backup <sealed> --expect-backup-sha256 <hex> --devbox-key <pem>',
  '         --expect-devbox-fingerprint <hex>',
  'Modes:',
  '  --rollback <batchId>             undo the latest complete load batch',
  '  --rollback-incomplete <batchId>  undo a pending load batch whose lease expired',
  'A failed run leaves its rollback batch pending; the same command resumes it.',
  'Export WORKS_READ and WORKS_READ_SOURCES with the API\'s values first: the devbox shell has no app settings.'
];

function optionsOf(argv) {
  const options = Object.assign({ help: { type: 'boolean' } }, ...Object.values(MODES).map(mode => mode.options));
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options, strict: true, allowPositionals: false }));
  } catch {
    refuse('unknown or malformed option; see --help');
  }
  if (values.help) return { help: true };
  const named = Object.keys(MODES).filter(name => values[name] !== undefined);
  if (named.length !== 1) refuse(`name exactly one mode: ${Object.keys(MODES).map(name => `--${name}`).join(', ')}`);
  const mode = MODES[named[0]];
  const stray = Object.keys(values).find(key => !Object.hasOwn(mode.options, key));
  if (stray) refuse(`--${stray} does not apply to --${named[0]}`);
  const missing = mode.required.find(key => typeof values[key] !== 'string' || values[key] === '');
  if (missing) refuse(`--${named[0]} needs --${missing}`);
  return { mode, o: values };
}

/** Resolves the exit code. @param {object} [deps] test seam {write, demi, openBackup, now} */
async function run(argv, { write = line => process.stdout.write(`${line}\n`), demi = liveDemi(), openBackup, now = Date.now } = {}) {
  const { help, mode, o } = optionsOf(argv);
  if (help) {
    HELP.forEach(write);
    return 0;
  }
  testEnvironment();
  requireDeriveEnv();
  return mode.run(o, { demi, openBackup, now, write });
}

/** Refuses unless the API's derive settings are exported; the config defaults would derive from other works than the API reads. */
function requireDeriveEnv(env = process.env) {
  const unset = ['WORKS_READ', 'WORKS_READ_SOURCES'].find(name => !env[name]?.trim());
  if (unset) refuse(`${unset} is not set`);
}

/** The command line; the backup reader loads only when a mode opens a backup. */
function main(argv) {
  return run(argv, { openBackup: args => require('./works-import-backup').openBackup(args) });
}

module.exports = { run, main, liveDemi, requireDeriveEnv };

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, (err) => {
    // No stack: a frame can carry backup values; messages name ids and counts only.
    logger.error('[rollback-business-works] failed', { error: err.message, code: err.code });
    process.exitCode = 1;
  });
}
