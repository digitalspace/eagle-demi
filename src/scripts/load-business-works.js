'use strict';

// Loads the business works spreadsheets into DEMI on test: a dry run by default, `--live` to write.
// Run on the devbox with DEVBOX_RUN_MODE=invoke; every decryption stays in memory.

const crypto = require('crypto');
const lists = require('../repositories/lists');
const works = require('../repositories/works');
const projects = require('../repositories/projects');
const commentPeriods = require('../repositories/comment-periods');
const history = require('../repositories/project-staff-history');
const phaseCatalog = require('../domain/phase-catalog');
const { deriveInputs, loadWorks } = require('../domain/works-derive');
const { OVERRIDE_MARKER_ID } = require('../domain/work-model');
const { systemAccess } = require('../helpers/access-sql');
const { buildPlan, withoutHeld } = require('./works-import-plan');
const { countLines } = require('./works-import-lists');
const { MAX_BYTES, HELP, optionsOf, testEnvironment, openInputs, readStored, heldElsewhere } = require('./works-import-inputs');
const { mapperInputs } = require('../domain/business-works-inputs');
const { checkOutDir, writeSealed } = require('../utils/import-envelope');
const batches = require('./works-import-batch');
const { logger } = require('../utils/logger');

const OWNER = 'sheet';
const DONE = new Set(['written', 'set', 'appended', 'closed', 'unchanged']);
// Refused until W8b lands the restore path, since nothing can open a works-backup yet.
const LIVE_REFUSED = '--live is refused until the rollback (W8b) can open the works-backup it writes; run the dry run';
const CROSSWALK_REASONS = ['notInCrosswalk', 'noRegisterRow'];
const DERIVED = new Set(['patched', 'unchanged']);
// The sealed envelope is the base64 plaintext plus a header, wrapped key and signature well under this.
const ENVELOPE_HEADROOM = 16 * 1024;

const refuse = (message) => { throw new Error(message); };

/** The repositories the loader reads and writes; tests pass a fake. */
function liveDemi() {
  return {
    worksCatalog: () => lists.readWorksCatalog(),
    phaseCatalog: () => phaseCatalog.load(),
    works: projectId => works.listByProject(projectId, { includeDeleted: true }),
    marker: projectId => works.get(projectId, OVERRIDE_MARKER_ID),
    commentPeriods: projectId => commentPeriods.listEveryByProject(projectId, systemAccess()),
    project: projectId => projects.getById(systemAccess(), projectId),
    externalIdHolders: (system, value) => history.externalIdHolders(system, value),
    trackPublic: async row => (await loadWorks(row)).worksForDerive,
    saveWork: (doc, options) => works.save(doc, options),
    tombstone: (doc, options) => works.tombstone(doc, options),
    addExternalId: (projectId, pair, recordedAt) => history.addExternalId(projectId, pair, recordedAt),
    appendHistory: (projectId, field, entry, close) => history.appendHistory(projectId, field, entry, close),
    closeHistory: (projectId, field, entryId, effectiveTo) => history.closeHistory(projectId, field, entryId, effectiveTo),
    patchDerived: projectId => projects.patchDerived(projectId, { inputsFor: deriveInputs })
  };
}

async function planFor(demi, inputs, { batchId, batchAt }) {
  const crosswalk = new Map(inputs.crosswalk.rows.map(row => [Number(row.sheetId), row.targetId]));
  const stored = await readStored(demi, [...new Set(crosswalk.values())]);
  const mapper = mapperInputs({
    crosswalk, rows: stored.rows, works: stored.works, markers: stored.markers, commentPeriods: stored.commentPeriods, batchId, batchAt,
    catalog: await demi.worksCatalog(), phaseCatalog: await demi.phaseCatalog()
  });
  const plan = buildPlan(inputs.opened.extract, {
    mapper, stored: stored.works, storedMarkers: stored.markers, rows: stored.rows, trackPublic: stored.trackPublic, ownerOf: works.ownerOf
  });
  if (plan.report.some(entry => CROSSWALK_REASONS.includes(entry.reason))) refuse('a sheet number is not in the signed crosswalk or has no register row');
  return { plan: withoutHeld(plan, await heldElsewhere(demi, plan)), stored };
}

const targetOf = entry => ({
  addExternalId: { projectId: entry.projectId, system: entry.system },
  appendHistory: { projectId: entry.projectId, field: entry.field, entryId: entry.entry && entry.entry.id },
  closeHistory: { projectId: entry.projectId, field: entry.field, entryId: entry.entryId }
}[entry.action] || { projectId: entry.projectId, id: (entry.doc || entry.current).id });

/** Runs one planned write; resolves the save's answer. A refused write stops the run. */
async function writeOne(demi, entry, batchAt) {
  const current = entry.current;
  const guard = current ? { owner: OWNER, etag: current._etag, existing: current } : { owner: OWNER };
  const result = await {
    create: () => demi.saveWork(entry.doc, guard),
    update: () => demi.saveWork(entry.doc, guard),
    marker: () => demi.saveWork(entry.doc, guard),
    tombstone: () => demi.tombstone(current, { owner: OWNER, etag: current._etag }),
    addExternalId: () => demi.addExternalId(entry.projectId, entry.pair, batchAt),
    appendHistory: () => demi.appendHistory(entry.projectId, entry.field, entry.entry, entry.close),
    closeHistory: () => demi.closeHistory(entry.projectId, entry.field, entry.entryId, entry.effectiveTo)
  }[entry.action]();
  if (!DONE.has(result.status)) refuse(`${entry.action} on project ${entry.projectId} answered ${result.status}`);
  return result;
}

function backupOf(plan, stored, batchId) {
  const touched = [...new Set(plan.entries.map(entry => entry.projectId))];
  return Buffer.from(JSON.stringify({
    batchId,
    documents: plan.entries.filter(entry => entry.current).map(entry => entry.current),
    projects: touched.map((projectId) => {
      const row = stored.rows.get(projectId) || {};
      const { externalIds, staffAssignments, capitalInvestments, staffNotes } = row;
      return { projectId, externalIds, staffAssignments, capitalInvestments, staffNotes };
    }),
    projectEntries: plan.entries.filter(entry => !entry.doc && !entry.current)
      .map(({ action, projectId, pair, field, entry, close, entryId, effectiveTo }) => ({ action, projectId, pair, field, entry, close, entryId, effectiveTo }))
  }));
}

/** Frees the lock of a run that wrote no batch header; a failed release is logged so the first error stands. */
async function releaseQuietly(lease) {
  try {
    await batches.releaseLock(lease);
  } catch (err) {
    logger.warn('[load-business-works] import lock release failed', { error: err.message });
  }
}

/** The plan, the sealed backup and the pending header, all under the lock; without a header the lock is freed. */
async function startBatch(o, ctx, batchId, lease) {
  const { demi, inputs, env, runAt } = ctx;
  let batch = null;
  try {
    const { plan, stored } = await planFor(demi, inputs, { batchId, batchAt: runAt });
    if (plan.planSha256 !== o['expect-plan-sha256'].toLowerCase()) refuse('planSha256 does not match --expect-plan-sha256; nothing was written');
    const sealed = { purpose: 'works-backup', env, recipient: inputs.recipient, signingKey: inputs.keys.ed25519 };
    const body = backupOf(plan, stored, batchId);
    if (4 * Math.ceil(body.length / 3) + ENVELOPE_HEADROOM > MAX_BYTES.backup) refuse('the works-backup would be over the size a rollback reads; nothing was written');
    const backup = writeSealed(o['out-dir'], body, sealed);
    batch = await batches.createBatch(batchId, {
      operator: o.operator, runRef: o['run-ref'], signoffRef: o['signoff-ref'], signoffRefs: inputs.opened.signoffRefs ?? null,
      inputSha256: inputs.opened.sha256, crosswalkSha256: inputs.crosswalk.sha256, planSha256: plan.planSha256,
      backupBlob: backup.name, backupSha256: backup.sha256
    }, Date.parse(runAt));
    return { plan, stored, backup, batch };
  } finally {
    if (!batch) await releaseQuietly(lease);
  }
}

async function live(o, ctx) {
  const { demi, inputs, now, runAt, write } = ctx;
  const refs = Object.values(inputs.opened.signoffRefs || {}).filter(Boolean);
  if (refs.length && !refs.includes(o['signoff-ref'])) refuse('--signoff-ref is not a sign-off ref the extract was sealed with');
  const batchId = crypto.randomUUID();
  const lease = await batches.takeLock(batchId, now());
  const { plan, stored, backup, batch } = await startBatch(o, ctx, batchId, lease);
  const run = { batchId, lease, seq: 0 };
  const rowEtags = new Map([...stored.rows].map(([id, row]) => [id, row._etag ?? null]));
  let written = 0;
  for (const entry of plan.entries) {
    const project = !entry.doc && !entry.current;
    const priorEtag = project ? rowEtags.get(entry.projectId) : entry.current?._etag ?? null;
    const etag = await batches.writeAhead(run, { target: targetOf(entry), action: entry.action, priorEtag }, async () => {
      const result = await writeOne(demi, entry, runAt);
      if (result.status !== 'unchanged') written += 1;
      return result.etag ?? null;
    }, now());
    if (project && etag) rowEtags.set(entry.projectId, etag);
  }
  const touched = [...new Set(plan.entries.map(entry => entry.projectId))];
  for (const projectId of touched) {
    await batches.writeAhead(run, { target: { projectId, id: projectId }, action: 'derive', priorEtag: rowEtags.get(projectId) ?? null }, async () => {
      const { status, etag } = await demi.patchDerived(projectId);
      if (!DERIVED.has(status)) refuse(`patchDerived on project ${projectId} answered ${status}`);
      return etag ?? null;
    }, now());
  }
  await batches.completeBatch(batch, lease, now());
  write(`batchId=${batchId}`);
  write(`written=${written}`);
  write(`derived=${touched.length}`);
  write(`backupSha256=${backup.sha256}`);
}

async function dryRun(o, { demi, inputs, env, runAt, write }) {
  const { plan } = await planFor(demi, inputs, { batchId: crypto.randomUUID(), batchAt: runAt });
  const body = Buffer.from(JSON.stringify({ planSha256: plan.planSha256, report: plan.report, lists: plan.lists }));
  const report = writeSealed(o['out-dir'], body, { purpose: 'works-report', env, recipient: inputs.recipient, signingKey: inputs.keys.ed25519 });
  countLines(plan).forEach(write);
  write(`inputSha256=${inputs.opened.sha256}`);
  write(`crosswalkSha256=${inputs.crosswalk.sha256}`);
  write(`planSha256=${plan.planSha256}`);
  write(`reportSha256=${report.sha256}`);
  write(`blob=${report.name}`);
}

/** Resolves the exit code. @param {object} [deps] test seam {write, demi, now} */
async function run(argv, { write = line => process.stdout.write(`${line}\n`), demi = liveDemi(), now = Date.now } = {}) {
  const o = optionsOf(argv);
  if (o.help) {
    HELP.forEach(write);
    return 0;
  }
  const env = testEnvironment();
  checkOutDir(o['out-dir']);
  const ctx = { demi, inputs: openInputs(o, env), env, now, runAt: new Date(now()).toISOString(), write };
  if (o.live) await live(o, ctx);
  else await dryRun(o, ctx);
  return 0;
}

/** The command line: `run`, except that `--live` is refused (LIVE_REFUSED). */
function main(argv) {
  if (argv.includes('--live')) return Promise.reject(new Error(LIVE_REFUSED));
  return run(argv);
}

module.exports = { run, main, liveDemi };

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, (err) => {
    logger.error('[load-business-works] failed', { error: err.message, code: err.code, stack: err.stack });
    process.exitCode = 1;
  });
}
