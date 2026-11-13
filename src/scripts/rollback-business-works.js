'use strict';

// Undoes a business works load on test: `--rollback <batchId>` for the latest complete load batch,
// `--rollback-incomplete <batchId>` for a pending one whose lease expired. Output names project and document ids and counts only.

const { parseArgs } = require('util');
const works = require('../repositories/works');
const projects = require('../repositories/projects');
const history = require('../repositories/project-staff-history');
const { deriveInputs } = require('../domain/works-derive');
const { testEnvironment } = require('./works-import-inputs');
const batches = require('./works-import-batch');
const { logger } = require('../utils/logger');

const OWNER = 'sheet';
const DOC_ACTIONS = new Set(['create', 'update', 'tombstone', 'marker']);
const PROJECT_ACTIONS = new Set(['addExternalId', 'appendHistory', 'closeHistory']);
const PROJECT_UNDONE = new Set(['removed', 'restored', 'absent']);
const BACKUP_KEYS = ['backup', 'expect-backup-sha256', 'devbox-key', 'expect-devbox-fingerprint'];

const refuse = (message) => { throw new Error(message); };
const docKey = ({ projectId, id }) => `${projectId}|${id}`;
const withoutSystem = doc => Object.fromEntries(Object.entries(doc).filter(([key]) => !key.startsWith('_')));

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

/** Each document the batch wrote, its entries in seq order, and the writtenEtag of a later override batch's latest entry on it. */
function documentsOf(entries, laterEntries) {
  const docs = new Map();
  for (const entry of entries.filter(one => DOC_ACTIONS.has(one.action))) {
    const key = docKey(entry.target);
    if (!docs.has(key)) docs.set(key, { target: entry.target, entries: [] });
    docs.get(key).entries.push(entry);
  }
  for (const entry of laterEntries) {
    const doc = entry.target.id && entry.state === 'done' && docs.get(docKey(entry.target));
    if (doc) doc.overrideEtag = entry.writtenEtag;
  }
  return [...docs.values()];
}

/**
 * The etag `current` must carry, or `undefined` when the batch never wrote the document. An intent entry is read now:
 * its write landed when the document moved off the etag recorded before it.
 */
function expectedEtag(doc, current) {
  const last = doc.entries.at(-1);
  if (last.state === 'done') return doc.overrideEtag ?? last.writtenEtag;
  const before = doc.entries.length > 1 ? doc.entries.at(-2).writtenEtag : last.priorEtag;
  const now = current ? current._etag : null;
  return now === before && doc.entries.length === 1 ? undefined : now;
}

/** The documents to undo, each with its current copy; refuses before any write when one moved or is not the sheet's. */
async function checkedDocuments(demi, docs) {
  const checked = [];
  for (const doc of docs) {
    const { projectId, id } = doc.target;
    const current = await demi.work(projectId, id);
    const expected = expectedEtag(doc, current);
    if (expected === undefined) continue;
    if (current && works.ownerOf(current) !== OWNER) refuse(`document ${id} on project ${projectId} is not owned by ${OWNER}; nothing was undone`);
    if ((current ? current._etag : null) !== expected) refuse(`document ${id} on project ${projectId} moved since the batch wrote it; nothing was undone`);
    checked.push({ ...doc, current });
  }
  return checked;
}

/** A created document is removed; one the backup holds is put back as it was, tombstones included. */
async function undoDocument(demi, { target, current }, prior) {
  const result = prior
    ? await demi.saveWork(withoutSystem(prior), { owner: OWNER, etag: current._etag, existing: current })
    : await demi.removeWork(target, { owner: OWNER, etag: current._etag });
  if (result.status !== (prior ? 'written' : 'removed')) refuse(`undo of ${target.id} on project ${target.projectId} answered ${result.status}`);
}

/** The repository calls that undo one project entry, from the plan values the backup holds. */
function projectUndos(demi, entry, backup) {
  const { projectId, field, entryId, system } = entry.target;
  const planned = backup.projectEntries.filter(one => one.action === entry.action && one.projectId === projectId);
  const priorOf = (id) => {
    const project = (backup.projects || []).find(one => one.projectId === projectId) || {};
    return (project[field] || []).find(one => one.id === id) || refuse(`the backup holds no prior copy of a ${field} entry on project ${projectId}`);
  };
  const reopen = (id, effectiveTo) => {
    const prior = priorOf(id);
    return () => demi.restoreHistory(projectId, field, prior, history.historyEntrySha256({ ...prior, effectiveTo }));
  };
  if (entry.action === 'addExternalId') {
    return planned.filter(one => one.pair.system === system)
      .map(one => () => demi.removeExternalId(projectId, { system, value: one.pair.value }));
  }
  const one = planned.find(item => item.field === field && (item.entryId ?? item.entry?.id) === entryId) ||
    refuse(`the backup holds no ${entry.action} values for project ${projectId}`);
  if (entry.action === 'closeHistory') return [reopen(entryId, one.effectiveTo)];
  return [
    () => demi.removeHistory(projectId, field, entryId, history.historyEntrySha256(one.entry)),
    ...(one.close ? [reopen(one.close.id, one.close.effectiveTo)] : [])
  ];
}

/** `patchDerived` on each project; ok only when patched + unchanged is the project count, so missing and conflict are 0. */
async function rederive(demi, projectIds, lease, now) {
  const counts = { patched: 0, unchanged: 0, missing: 0, conflict: 0 };
  for (const projectId of projectIds) {
    await batches.beforeWrite(lease, now());
    const { status } = await demi.patchDerived(projectId);
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return { counts, ok: counts.patched + counts.unchanged === projectIds.length };
}

/** Undoes `entries` of `batch` under `lease`, marks it rolledBack, re-derives every touched project; resolves the exit code. */
async function undoBatch(o, ctx, { batch, entries, laterEntries = [], lease }) {
  const { demi, openBackup, now, write } = ctx;
  if (o['expect-backup-sha256'].toLowerCase() !== batch.backupSha256) refuse('--expect-backup-sha256 is not the backup SHA-256 the batch recorded');
  const backup = await openBackup({
    sealedPath: o.backup, expectSha256: o['expect-backup-sha256'].toLowerCase(), devboxKeyPath: o['devbox-key'],
    expectDevboxFingerprint: o['expect-devbox-fingerprint'], batchId: batch.id, batchBackupSha256: batch.backupSha256
  });
  if (!backup || backup.batchId !== batch.id) refuse('the backup is not this batch\'s');
  const docs = await checkedDocuments(demi, documentsOf(entries, laterEntries));
  const projectEntries = entries.filter(one => PROJECT_ACTIONS.has(one.action) && (one.state === 'intent' || one.writtenEtag !== null));
  if (projectEntries.length && !Array.isArray(backup.projectEntries)) refuse('the backup holds no projectEntries, so project entries cannot be undone');
  const undos = projectEntries.flatMap(entry => projectUndos(demi, entry, backup).map(call => ({ projectId: entry.target.projectId, call })));

  const priors = new Map((backup.documents || []).map(doc => [docKey(doc), doc]));
  for (const doc of docs) {
    await batches.beforeWrite(lease, now());
    await undoDocument(demi, doc, priors.get(docKey(doc.target)));
  }
  const changed = new Set();
  for (const { projectId, call } of undos) {
    await batches.beforeWrite(lease, now());
    const { status } = await call();
    if (status === 'changed') changed.add(projectId);
    else if (!PROJECT_UNDONE.has(status)) refuse(`a project entry undo on project ${projectId} answered ${status}`);
  }
  await batches.markRolledBack(batch, now());

  const touched = [...new Set(entries.map(entry => entry.target.projectId))];
  const { counts, ok } = await rederive(demi, touched, lease, now);
  write(`batchId=${batch.id}`);
  write(`documents=${docs.length}`);
  write(`projectEntries=${undos.length}`);
  write(`changed=${changed.size}`);
  changed.forEach(projectId => write(`changedProject=${projectId}`));
  Object.entries(counts).forEach(([status, n]) => write(`${status}=${n}`));
  write(`projects=${touched.length}`);
  return ok ? 0 : 1;
}

/** Frees the lock; a failed release is logged so the first error stands. */
async function releaseQuietly(lease) {
  try {
    await batches.releaseLock(lease);
  } catch (err) {
    logger.warn('[rollback-business-works] import lock release failed', { error: err.message });
  }
}

async function rollback(o, ctx) {
  const batchId = o.rollback;
  const lease = await batches.takeLock(batchId, ctx.now());
  try {
    const latest = await batches.latestCompleteBatch('load');
    if (!latest || latest.id !== batchId) refuse('--rollback acts only on the latest complete load batch');
    const later = (await batches.completeBatches()).filter(one => one.batchKind === 'override' && one.startedAt > latest.startedAt);
    const laterEntries = [];
    for (const one of later) laterEntries.push(...await batches.listEntries(one.id));
    return await undoBatch(o, ctx, { batch: latest, entries: await batches.listEntries(batchId), laterEntries, lease });
  } finally {
    await releaseQuietly(lease);
  }
}

async function rollbackIncomplete(o, ctx) {
  const batchId = o['rollback-incomplete'];
  const pending = async () => {
    const batch = await batches.readBatch(batchId);
    return batch && batch.batchKind === 'load' && batch.status === 'pending' ? batch : refuse('--rollback-incomplete acts only on a pending load batch');
  };
  await pending();
  const lease = await batches.takeOverLock(batchId, ctx.now());
  try {
    return await undoBatch(o, ctx, { batch: await pending(), entries: await batches.listEntries(batchId), lease });
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
  '  --rollback-incomplete <batchId>  undo a pending load batch whose lease expired'
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
  return mode.run(o, { demi, openBackup, now, write });
}

/** The command line; the backup reader loads only when a mode opens a backup. */
function main(argv) {
  return run(argv, { openBackup: args => require('./works-import-backup').openBackup(args) });
}

module.exports = { run, main, liveDemi };

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, (err) => {
    // No stack: a frame can carry backup values; messages name ids and counts only.
    logger.error('[rollback-business-works] failed', { error: err.message, code: err.code });
    process.exitCode = 1;
  });
}
