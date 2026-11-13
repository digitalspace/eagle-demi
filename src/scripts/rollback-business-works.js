'use strict';

// Undoes or adjusts a business works load on test; HELP lists the modes. Output names project and document ids and counts only.

const crypto = require('crypto');
const { isDeepStrictEqual, parseArgs } = require('util');
const works = require('../repositories/works');
const projects = require('../repositories/projects');
const history = require('../repositories/project-staff-history');
const { systemAccess } = require('../helpers/access-sql');
const { deriveInputs, loadWorks } = require('../domain/works-derive');
const { testEnvironment } = require('./works-import-inputs');
const batches = require('./works-import-batch');
const { withoutSystem, stepKey, projectSteps, rederive, loggedOf, openSteps, requireDeriveEnv } = require('./works-rollback-steps');
const { rederiveBatch, timedFetch, writeCounts } = require('./works-import-rederive');
const { revertOverride, reapplyOverride, undoOverrideBatch } = require('./works-import-override');
const { logger } = require('../utils/logger');

const OWNER = 'sheet';
const DOC_ACTIONS = new Set(['create', 'update', 'tombstone', 'marker']);
// Writes of a later batch that move a document's etag: a revert or reapply of a marker, or a rollback's undo.
const LATER_DOC_ACTIONS = new Set([...DOC_ACTIONS, 'remove', 'restore']);
const LATER_KINDS = new Set(['override', 'rollback']);
// An abandoned rollback's done undos still moved etags, so later batches include it.
const LATER_STATUSES = ['complete', 'abandoned'];
const BACKUP_KEYS = ['backup', 'expect-backup-sha256', 'devbox-key', 'expect-devbox-fingerprint'];

const refuse = (message) => { throw new Error(message); };
const docKey = ({ projectId, id }) => `${projectId}|${id}`;
const endedAt = batch => String(batch.completedAt ?? batch.abandonedAt);

/** `doc` without the keys works.save copies from the document it replaces: system keys, `source`, `owner` and the adopt fields. */
function asSaved(doc) {
  const { source: _source, owner: _owner, provenance, ...rest } = withoutSystem(doc);
  const { adoptedBy: _by, adoptedAt: _at, ...kept } = provenance || {};
  return { ...rest, provenance: kept };
}

/** The repositories a rollback reads and writes; tests pass a fake. */
function liveDemi() {
  return {
    work: (projectId, id) => works.get(projectId, id),
    saveWork: (doc, options) => works.save(doc, options),
    removeWork: (target, options) => works.remove(target, options),
    removeExternalId: (projectId, pair) => history.removeExternalId(projectId, pair),
    removeHistory: (projectId, field, entryId, expectedSha256) => history.removeHistory(projectId, field, entryId, expectedSha256),
    restoreHistory: (projectId, field, prior, expectedSha256) => history.restoreHistory(projectId, field, prior, expectedSha256),
    project: projectId => projects.getById(systemAccess(), projectId),
    readWorkIds: async (row, sources) => (await loadWorks(row, { sources })).worksForDerive.map(work => work.workId),
    patchDerived: projectId => projects.patchDerived(projectId, { inputsFor: deriveInputs })
  };
}

/** Each document `targetId` wrote, its entries in seq order, and the latest later write to it, flagged when an earlier undo of `targetId` made it. */
function documentsOf(entries, laterEntries, targetId) {
  const docs = new Map();
  for (const entry of entries.filter(one => DOC_ACTIONS.has(one.action))) {
    const key = docKey(entry.target);
    if (!docs.has(key)) docs.set(key, { target: entry.target, entries: [] });
    docs.get(key).entries.push(entry);
  }
  for (const entry of laterEntries.filter(one => LATER_DOC_ACTIONS.has(one.action) && one.state === 'done')) {
    const doc = docs.get(docKey(entry.target));
    if (doc) Object.assign(doc, { laterEtag: entry.writtenEtag, undoneBefore: entry.undoes === targetId });
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
async function documentSteps(demi, docs, { priors, logged, note }) {
  const steps = [];
  for (const doc of docs) {
    const { projectId, id } = doc.target;
    const where = `document ${id} on project ${projectId}`;
    const prior = priors.get(docKey(doc.target));
    if (!prior && doc.entries[0].priorEtag !== null) refuse(`the backup holds no prior copy of ${where}; ${note}`);
    const action = prior ? 'restore' : 'remove';
    const log = logged.get(stepKey(action, doc.target));
    if (log?.done) continue;
    const current = await demi.work(projectId, id);
    const landed = prior ? current && isDeepStrictEqual(asSaved(current), asSaved(prior)) : !current;
    // A resumed undo whose write landed is logged done with the etag it left, so a later rollback can chain on it.
    if (log?.intent && landed) {
      steps.push({ action, target: doc.target, priorEtag: null, run: async () => (current ? current._etag : null) });
      continue;
    }
    if (doc.undoneBefore && (prior ? current && current._etag === doc.laterEtag : !current)) continue;
    const expected = expectedEtag(doc, current);
    if (expected === undefined) continue;
    if (!current) refuse(`${where} is gone; ${note}`);
    if (works.ownerOf(current) !== OWNER) refuse(`${where} is not owned by ${OWNER}; ${note}`);
    if (current._etag !== expected) refuse(`${where} moved since the batch wrote it; ${note}`);
    steps.push({ action, target: doc.target, priorEtag: current._etag, run: () => undoDocument(demi, doc.target, current, prior) });
  }
  return steps;
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
  const logged = loggedOf(log);
  const changed = new Set(log.filter(entry => entry.state === 'done' && entry.result === 'changed').map(entry => entry.target.projectId));
  const pending = resumed ? `; rollback batch ${resumed.id} stays pending` : '';
  const note = `this run wrote nothing${pending}`;

  const priors = new Map(backup.documents.map(doc => [docKey(doc), doc]));
  const nth = new Map();
  const steps = [
    ...await documentSteps(demi, documentsOf(entries, laterEntries, target.id), { priors, logged, note }),
    // Steps of one key run in order, so the first `done` of them finished in an earlier run.
    ...projectSteps(demi, entries, backup).filter((step) => {
      const key = stepKey(step.action, step.target);
      const n = nth.get(key) ?? 0;
      nth.set(key, n + 1);
      return n >= (logged.get(key)?.done ?? 0);
    })
  ];
  const header = resumed
    ? { item: withoutSystem(resumed), etag: resumed._etag }
    : await batches.createBatch(crypto.randomUUID(), { batchKind: 'rollback', targetBatchId: target.id }, now());
  const run = { batchId: header.item.id, lease, seq: log.length };
  for (const step of steps) {
    try {
      await batches.writeAhead(run, { target: step.target, action: step.action, priorEtag: step.priorEtag ?? null }, async () => {
        const answer = await step.run();
        if (answer?.result === 'changed') changed.add(step.target.projectId);
        return answer;
      }, now());
    } catch (err) {
      err.message = `${err.message}; rollback batch ${header.item.id} stays pending`;
      throw err;
    }
  }

  const touched = [...new Set(entries.map(entry => entry.target.projectId))];
  const { counts, ok } = await rederive(demi, touched, lease, now);
  write(`batchId=${target.id}`);
  write(`rollbackBatchId=${header.item.id}`);
  write(`undone=${steps.length}`);
  write(`changed=${changed.size}`);
  changed.forEach(projectId => write(`changedProject=${projectId}`));
  writeCounts(write, counts, touched.length);
  if (!ok) return 1;
  await batches.markBatch(target, 'rolledBack', now());
  await batches.completeBatch(header, lease, now());
  lease.released = true;
  return 0;
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

/** The pending rollback read again under the lock; refused when another run started or finished one meanwhile. */
async function stillResumed(batchId, resumed) {
  const now = await pendingRollbackOf(batchId);
  if ((now?.id ?? null) !== (resumed?.id ?? null)) refuse('another run changed the pending rollback of this batch; this run wrote nothing');
  return now;
}

async function loadBatch(batchId, statuses, message, batchKind = 'load') {
  const batch = await batches.readBatch(batchId);
  return batch && batch.batchKind === batchKind && statuses.includes(batch.status) ? batch : refuse(message);
}

/** Done entries of the override and rollback batches that started after `target`, in the order they ended; a rollback's carry `undoes`. */
async function laterEntriesOf(target) {
  const headers = (await Promise.all(LATER_STATUSES.map(status => batches.batchesWithStatus(status)))).flat()
    .filter(one => LATER_KINDS.has(one.batchKind) && one.startedAt > target.startedAt)
    .sort((a, b) => endedAt(a).localeCompare(endedAt(b)));
  const entries = [];
  for (const one of headers) {
    const undoes = one.batchKind === 'rollback' ? one.targetBatchId : null;
    entries.push(...(await batches.listEntries(one.id)).map(entry => ({ ...entry, undoes })));
  }
  return entries;
}

async function rollback(o, ctx) {
  requireDeriveEnv();
  const batchId = o.rollback;
  const seen = await pendingRollbackOf(batchId);
  const lease = await lockFor(batchId, seen, ctx.now());
  try {
    const resumed = await stillResumed(batchId, seen);
    const target = resumed
      ? await loadBatch(batchId, ['complete', 'rolledBack'], 'the pending rollback names a batch that is not a load')
      : await batches.latestCompleteBatch('load');
    if (!target || target.id !== batchId) refuse('--rollback acts only on the latest complete load batch');
    return await undoBatch(o, ctx, { target, entries: await batches.listEntries(batchId), laterEntries: await laterEntriesOf(target), lease, resumed });
  } finally {
    await batches.releaseQuietly(lease);
  }
}

async function rollbackIncomplete(o, ctx) {
  requireDeriveEnv();
  const batchId = o['rollback-incomplete'];
  // An override batch is undone from the prior values its entries hold, so it takes no backup.
  const kind = (await batches.readBatch(batchId))?.batchKind === 'override' ? 'override' : 'load';
  const missingKey = BACKUP_KEYS.find(key => !o[key]);
  if (kind === 'override' && BACKUP_KEYS.some(key => o[key])) refuse('--rollback-incomplete of an override batch takes no backup flags');
  if (kind === 'load' && missingKey) refuse(`--rollback-incomplete of a load batch needs --${missingKey}`);
  const seen = await pendingRollbackOf(batchId);
  const statuses = seen ? ['pending', 'rolledBack'] : ['pending'];
  const message = `--rollback-incomplete acts only on a pending ${kind} batch`;
  await loadBatch(batchId, statuses, message, kind);
  const lease = await batches.takeOverLock(batchId, ctx.now(), [batchId, seen?.id].filter(Boolean));
  try {
    const resumed = await stillResumed(batchId, seen);
    const target = await loadBatch(batchId, statuses, message, kind);
    const entries = await batches.listEntries(batchId);
    if (kind === 'override') return await undoOverrideBatch(ctx, { target, entries, lease, resumed });
    return await undoBatch(o, ctx, { target, entries, laterEntries: await laterEntriesOf(target), lease, resumed });
  } finally {
    await batches.releaseQuietly(lease);
  }
}

/** Gives up a pending rollback batch a refusal keeps stuck: prints its open steps, marks it abandoned and frees the lock. */
async function abandonRollback(o, { now, write }) {
  const rollbackId = o['abandon-rollback'];
  const pending = async () => {
    const batch = await batches.readBatch(rollbackId);
    return batch && batch.batchKind === 'rollback' && batch.status === 'pending' ? batch : refuse('--abandon-rollback acts only on a pending rollback batch');
  };
  const { targetBatchId } = await pending();
  const lease = await batches.takeOverLock(targetBatchId, now(), [targetBatchId, rollbackId]);
  try {
    const batch = await pending();
    const open = openSteps(await batches.listEntries(rollbackId));
    open.forEach(({ seq, target }) => write(`openStep=${seq} project=${target.projectId} target=${target.id ?? target.entryId ?? target.system}`));
    write(`open=${open.length}`);
    await batches.markBatch(batch, 'abandoned', now());
    write(`abandoned=${rollbackId}`);
    return 0;
  } finally {
    await batches.releaseQuietly(lease);
  }
}

/** Frees a lock a stopped run left with no pending batch behind it. */
async function clearLock(o, { now, write }) {
  write(`clearedLock=${await batches.clearStaleLock(now())}`);
  return 0;
}

const BACKUP_OPTIONS = Object.fromEntries(BACKUP_KEYS.map(name => [name, { type: 'string' }]));
const MARKER_OPTIONS = { project: { type: 'string' }, all: { type: 'boolean' } };
// One entry per mode: its flags, the ones it needs, and its runner, which resolves the exit code.
const MODES = {
  rollback: { options: { rollback: { type: 'string' }, ...BACKUP_OPTIONS }, required: ['rollback', ...BACKUP_KEYS], run: rollback },
  'rollback-incomplete': {
    options: { 'rollback-incomplete': { type: 'string' }, ...BACKUP_OPTIONS }, required: ['rollback-incomplete'], run: rollbackIncomplete
  },
  'abandon-rollback': { options: { 'abandon-rollback': { type: 'string' } }, required: ['abandon-rollback'], run: abandonRollback },
  'revert-override': { options: { 'revert-override': { type: 'boolean' }, ...MARKER_OPTIONS }, required: ['revert-override'], run: revertOverride },
  'reapply-override': { options: { 'reapply-override': { type: 'boolean' }, ...MARKER_OPTIONS }, required: ['reapply-override'], run: reapplyOverride },
  rederive: { options: { rederive: { type: 'string' }, unflip: { type: 'boolean' } }, required: ['rederive'], run: rederiveBatch },
  'clear-stale-lock': { options: { 'clear-stale-lock': { type: 'boolean' } }, required: ['clear-stale-lock'], run: clearLock }
};

const HELP = [
  'Usage: rollback-business-works.js <mode>; --rollback and --rollback-incomplete of a load batch need --backup <sealed> --expect-backup-sha256 <hex> --devbox-key <pem> --expect-devbox-fingerprint <hex>',
  'Modes:',
  '  --rollback <batchId>                 undo the latest complete load batch',
  '  --rollback-incomplete <batchId>      undo a pending load or override batch whose lease expired',
  '  --abandon-rollback <rollbackBatchId> give up a stuck rollback batch (no backup flags); a fresh rollback then finishes',
  '  --revert-override                    turn the sheet override marker off, with --project <id> or --all',
  '  --reapply-override                   turn it back on, with --project <id> or --all',
  '      --all: every marker the latest complete load batch wrote',
  '      a failed revert or reapply leaves its override batch pending: clear it with --rollback-incomplete <id>',
  '  --rederive <batchId>                 after sheet joins WORKS_READ_SOURCES: the public read must show a batch sheet work',
  '  --rederive <batchId> --unflip        after sheet leaves WORKS_READ_SOURCES: the public read must show none',
  '  --clear-stale-lock                   delete an expired lock a stopped run left, when its batch is not pending',
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
  const missing = mode.required.find(key => values[key] === undefined || values[key] === '');
  if (missing) refuse(`--${named[0]} needs --${missing}`);
  return { mode, o: values };
}

/** Resolves the exit code. @param {object} [deps] test seam {write, demi, openBackup, now, fetchFn} */
async function run(argv, { write = line => process.stdout.write(`${line}\n`), demi = liveDemi(), openBackup, now = Date.now, fetchFn = timedFetch } = {}) {
  const { help, mode, o } = optionsOf(argv);
  if (help) {
    HELP.forEach(write);
    return 0;
  }
  const env = testEnvironment();
  return mode.run(o, { demi, openBackup, now, write, fetchFn, env, ownerOf: works.ownerOf });
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
