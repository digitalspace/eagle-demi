'use strict';

// Loads the business works spreadsheets into DEMI on test: a dry run by default, `--live` to write.
// Run on the devbox with DEVBOX_RUN_MODE=invoke; every decryption stays in memory.

const crypto = require('crypto');
const { parseArgs } = require('util');
const lists = require('../repositories/lists');
const works = require('../repositories/works');
const projects = require('../repositories/projects');
const history = require('../repositories/project-staff-history');
const phaseCatalog = require('../domain/phase-catalog');
const { deriveInputs, loadWorks } = require('../domain/works-derive');
const { OVERRIDE_MARKER_ID } = require('../domain/work-model');
const { systemAccess } = require('../helpers/access-sql');
const { readCrosswalk } = require('./works-crosswalk');
const { buildPlan, countLines } = require('./works-import-plan');
const batches = require('./works-import-batch');
const { devboxKeysFromPem, fingerprintOf, openExtract, publicKeysFromPem, readCapped } = require('../utils/import-envelope');
const { logger } = require('../utils/logger');

const ENV = 'test';
const TEST_HOST = 'demi-cosmos-test.documents.azure.com';
const MAX_BYTES = { extract: 64 * 1024 * 1024, crosswalk: 16 * 1024 * 1024, key: 64 * 1024 };
const OWNER = 'sheet';
const INPUTS = ['extract', 'expect-sha256', 'crosswalk', 'expect-crosswalk-sha256', 'expect-manual-sha256', 'devbox-key',
  'operator-key', 'expect-operator-fingerprint', 'out-dir'];
const LIVE = ['operator', 'run-ref', 'signoff-ref', 'expect-plan-sha256'];
const OPTIONS = { ...Object.fromEntries([...INPUTS, ...LIVE].map(name => [name, { type: 'string' }])), live: { type: 'boolean' } };
const DONE = new Set(['written', 'set', 'appended', 'unchanged']);

const refuse = (message) => { throw new Error(message); };

/** Test only: any Cosmos host but demi-cosmos-test refuses, in dry run and live alike. */
function testEnvironment(endpoint = process.env.COSMOS_ENDPOINT) {
  const host = URL.canParse(endpoint || '') ? new URL(endpoint).hostname : '';
  return host === TEST_HOST ? ENV : refuse('COSMOS_ENDPOINT is not demi-cosmos-test; this loader runs on test only');
}

function optionsOf(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false }));
  } catch {
    refuse(`options are --${Object.keys(OPTIONS).join(', --')}`);
  }
  const missing = [...INPUTS, ...(values.live ? LIVE : [])].filter(name => !values[name]);
  if (missing.length) refuse(`missing --${missing.join(', --')}`);
  return values;
}

/** The repositories the loader reads and writes; tests pass a fake. */
function liveDemi() {
  return {
    worksCatalog: () => lists.readWorksCatalog(),
    phaseCatalog: () => phaseCatalog.load(),
    works: projectId => works.listByProject(projectId, { includeDeleted: true }),
    marker: projectId => works.get(projectId, OVERRIDE_MARKER_ID),
    project: projectId => projects.getById(systemAccess(), projectId),
    trackPublic: async row => (await loadWorks(row)).worksForDerive,
    saveWork: (doc, options) => works.save(doc, options),
    tombstone: (doc, options) => works.tombstone(doc, options),
    addExternalId: (projectId, pair, recordedAt) => history.addExternalId(projectId, pair, recordedAt),
    appendHistory: (projectId, field, entry, close) => history.appendHistory(projectId, field, entry, close),
    patchDerived: projectId => projects.patchDerived(projectId, { inputsFor: deriveInputs })
  };
}

function openInputs(o, env) {
  const keys = devboxKeysFromPem(readCapped(o['devbox-key'], MAX_BYTES.key).toString('utf8'));
  const operator = publicKeysFromPem(readCapped(o['operator-key'], MAX_BYTES.key).toString('utf8')).rsa;
  const recipient = { rsa: operator, fingerprint: fingerprintOf({ rsa: operator }) };
  if (recipient.fingerprint !== o['expect-operator-fingerprint'].toLowerCase()) refuse('fingerprint of operator key does not match');
  const opened = openExtract(readCapped(o.extract, MAX_BYTES.extract), {
    env, keyFingerprint: keys.fingerprint, privateKey: keys.rsa, expectSha256: o['expect-sha256']
  });
  const crosswalk = readCrosswalk(readCapped(o.crosswalk, MAX_BYTES.crosswalk), {
    env, keys, expectExtractSha256: opened.sha256, expectManualSha256: o['expect-manual-sha256']
  });
  if (crosswalk.sha256 !== o['expect-crosswalk-sha256'].toLowerCase()) refuse('crosswalk SHA-256 does not match --expect-crosswalk-sha256');
  return { keys, recipient, opened, crosswalk };
}

/** Every stored input of the crosswalk's projects. */
async function readStored(demi, projectIds) {
  const state = { stored: new Map(), storedMarkers: new Map(), rows: new Map(), trackWorks: new Map(), trackPublic: new Map(), eagleItems: new Map() };
  for (const projectId of projectIds) {
    const row = await demi.project(projectId);
    if (!row) continue;
    const docs = await demi.works(projectId);
    const marker = await demi.marker(projectId);
    state.rows.set(projectId, row);
    state.stored.set(projectId, docs);
    if (marker) state.storedMarkers.set(projectId, marker);
    state.trackWorks.set(projectId, docs.filter(doc => works.ownerOf(doc) === 'track' && !doc.deleted));
    state.trackPublic.set(projectId, await demi.trackPublic(row));
    state.eagleItems.set(projectId, { reviewExtensions: row.reviewExtensions || [], reviewSuspensions: row.reviewSuspensions || [] });
  }
  return state;
}

async function planFor(demi, inputs, { batchId, batchAt }) {
  const crosswalk = new Map(inputs.crosswalk.rows.map(row => [Number(row.sheetId), row.targetId]));
  const stored = await readStored(demi, [...new Set(crosswalk.values())]);
  const markers = new Map(stored.storedMarkers);
  const plan = buildPlan(inputs.opened.extract, {
    ...stored, markers, crosswalk, batchId, batchAt, ownerOf: works.ownerOf, catalog: await demi.worksCatalog(), phaseCatalog: await demi.phaseCatalog()
  });
  if (plan.report.some(entry => entry.reason === 'notInCrosswalk')) refuse('a sheet number is not in the signed crosswalk');
  return { plan, stored };
}

const targetOf = entry => ({
  addExternalId: { projectId: entry.projectId, system: entry.system },
  appendHistory: { projectId: entry.projectId, field: entry.field, entryId: entry.entry && entry.entry.id }
}[entry.action] || { projectId: entry.projectId, id: (entry.doc || entry.current).id });

/** Runs one planned write; resolves the etag the save returned. A refused write stops the run. */
async function writeOne(demi, entry, batchAt) {
  const current = entry.current;
  const guard = current ? { owner: OWNER, etag: current._etag, existing: current } : { owner: OWNER };
  const result = await {
    create: () => demi.saveWork(entry.doc, guard),
    update: () => demi.saveWork(entry.doc, guard),
    marker: () => demi.saveWork(entry.doc, guard),
    tombstone: () => demi.tombstone(current, { owner: OWNER, etag: current._etag }),
    addExternalId: () => demi.addExternalId(entry.projectId, entry.pair, batchAt),
    appendHistory: () => demi.appendHistory(entry.projectId, entry.field, entry.entry, entry.close)
  }[entry.action]();
  if (!DONE.has(result.status)) refuse(`${entry.action} on project ${entry.projectId} answered ${result.status}`);
  return result.etag ?? null;
}

function backupOf(plan, stored) {
  const touched = [...new Set(plan.entries.map(entry => entry.projectId))];
  return Buffer.from(JSON.stringify({
    documents: plan.entries.filter(entry => entry.current).map(entry => entry.current),
    projects: touched.map((projectId) => {
      const row = stored.rows.get(projectId) || {};
      const { externalIds, staffAssignments, capitalInvestments, staffNotes } = row;
      return { projectId, externalIds, staffAssignments, capitalInvestments, staffNotes };
    })
  }));
}

async function live(o, ctx) {
  const { demi, inputs, env, now, write } = ctx;
  const batchId = crypto.randomUUID();
  const lease = await batches.takeLock(batchId, now());
  let planned;
  try {
    planned = await planFor(demi, inputs, { batchId, batchAt: new Date(now()).toISOString() });
    if (planned.plan.planSha256 !== o['expect-plan-sha256'].toLowerCase()) refuse('planSha256 does not match --expect-plan-sha256; nothing was written');
  } catch (err) {
    await batches.releaseLock(lease);
    throw err;
  }
  const { plan, stored } = planned;
  const sealed = { purpose: 'works-backup', env, recipient: inputs.recipient, signingKey: inputs.keys.ed25519 };
  const backup = batches.writeSealed(o['out-dir'], backupOf(plan, stored), sealed);
  const batch = await batches.createBatch(batchId, {
    operator: o.operator, runRef: o['run-ref'], signoffRef: o['signoff-ref'], signoffRefs: inputs.opened.signoffRefs ?? null,
    inputSha256: inputs.opened.sha256, crosswalkSha256: inputs.crosswalk.sha256, planSha256: plan.planSha256,
    backupBlob: backup.name, backupSha256: backup.sha256
  }, now());
  const run = { batchId, lease, seq: 0 };
  const batchAt = batch.item.startedAt;
  for (const entry of plan.entries) {
    await batches.writeAhead(run, { target: targetOf(entry), action: entry.action, priorEtag: entry.current ? entry.current._etag : null },
      () => writeOne(demi, entry, batchAt), now());
  }
  for (const projectId of new Set(plan.entries.map(entry => entry.projectId))) await demi.patchDerived(projectId);
  await batches.completeBatch(batch, lease, now());
  write(`batchId=${batchId}`);
  write(`written=${plan.entries.length}`);
  write(`backupSha256=${backup.sha256}`);
}

async function dryRun(o, { demi, inputs, env, now, write }) {
  const { plan } = await planFor(demi, inputs, { batchId: crypto.randomUUID(), batchAt: new Date(now()).toISOString() });
  const body = Buffer.from(JSON.stringify({ planSha256: plan.planSha256, report: plan.report, lists: plan.lists }));
  const report = batches.writeSealed(o['out-dir'], body, { purpose: 'works-report', env, recipient: inputs.recipient, signingKey: inputs.keys.ed25519 });
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
  const env = testEnvironment();
  const ctx = { demi, inputs: openInputs(o, env), env, now, write };
  if (o.live) await live(o, ctx);
  else await dryRun(o, ctx);
  return 0;
}

module.exports = { run, liveDemi, testEnvironment };

if (require.main === module) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code; }, (err) => {
    logger.error('[load-business-works] failed', { error: err.message, code: err.code });
    process.exitCode = 1;
  });
}
