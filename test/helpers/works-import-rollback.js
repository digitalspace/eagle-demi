'use strict';

// The rollback CLI tests' harness: a fake DEMI with the undo writes, a backup opener, the CLI runner and a loaded batch.

const test = require('node:test');
const fs = require('fs');
const path = require('path');
const { run } = require('../../src/scripts/rollback-business-works');
const { KINDS } = require('../../src/scripts/works-import-batch');
const history = require('../../src/repositories/project-staff-history');
const { OVERRIDE_MARKER_ID, hiddenByOverride } = require('../../src/domain/work-model');
const { overrideShown } = require('../../src/domain/works-derive');
const { openEnvelope, fingerprintOf } = require('../../src/utils/import-envelope');
const { fakeLists } = require('./works-import-fakes');
const { ENV, T0, operator, fakeDemi, inputs, liveRun } = require('./works-import-loader');

const LATER = T0 + 60 * 1000;
const SHA = 'a'.repeat(64);
const DERIVE_ENV = { WORKS_READ: 'true', WORKS_READ_SOURCES: 'track' };

// The modes that derive refuse while WORKS_READ or WORKS_READ_SOURCES is unset, as on a devbox shell.
const saved = Object.fromEntries(Object.keys(DERIVE_ENV).map(name => [name, process.env[name]]));
Object.assign(process.env, DERIVE_ENV);
test.after(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const isSheet = doc => doc.source === 'sheet' && doc.id !== OVERRIDE_MARKER_ID;

/** fakeDemi plus the rollback's reads and undo writes; saves honour the etag guard, history undo the repository's hash rule. */
function rollbackDemi(demi = fakeDemi()) {
  const sha = history.historyEntrySha256;
  const save = demi.saveWork;
  const entryUnder = (field, entryId, expectedSha256, next, unchangedSha256) => {
    const list = demi.row[field] || [];
    const index = list.findIndex(one => one.id === entryId);
    if (index < 0) return { status: 'absent' };
    if (list[index].source !== 'demi' && sha(list[index]) === unchangedSha256) return { status: 'unchanged' };
    if (list[index].source === 'demi' || sha(list[index]) !== expectedSha256) return { status: 'changed' };
    demi.row = { ...demi.row, [field]: next(list, index) };
    return null;
  };
  return Object.assign(demi, {
    reads: 0,
    work: async (_projectId, id) => { demi.reads += 1; return demi.docs.get(id) || null; },
    saveWork: async (doc, options = {}) => (options.etag !== undefined && demi.docs.get(doc.id)?._etag !== options.etag ? { status: 'foreign' } : save(doc, options)),
    removeWork: async ({ id }, { etag }) => {
      if (demi.docs.get(id)?._etag !== etag) return { status: 'foreign' };
      demi.docs.delete(id);
      return { status: 'removed' };
    },
    removeExternalId: async (_projectId, { system, value }) => {
      const list = demi.row.externalIds || [];
      if (!list.some(one => one.system === system && one.value === value)) return { status: 'absent' };
      demi.row = { ...demi.row, externalIds: list.filter(one => !(one.system === system && one.value === value)) };
      return { status: 'removed' };
    },
    removeHistory: async (_projectId, field, entryId, expected) =>
      entryUnder(field, entryId, expected, (list, index) => list.toSpliced(index, 1)) || { status: 'removed' },
    restoreHistory: async (_projectId, field, prior, expected) =>
      entryUnder(field, prior.id, expected, (list, index) => list.with(index, prior), sha(prior)) || { status: 'restored' }
  });
}

/** A stand-in for works-import-backup's openBackup: opens the sealed backup as the operator, checking nothing itself. */
const openBackup = async ({ sealedPath }) => JSON.parse(openEnvelope(fs.readFileSync(sealedPath), {
  purpose: 'works-backup', env: ENV, keyFingerprint: fingerprintOf({ rsa: operator.publicKey }), privateKey: operator.privateKey
}).plaintext);

const argsOf = (mode, batchId, { backup = 'backup.sealed.json', sha = SHA } = {}) =>
  [`--${mode}`, batchId, '--backup', backup, '--expect-backup-sha256', sha, '--devbox-key', 'devbox-key.pem', '--expect-devbox-fingerprint', 'f'.repeat(64)];

async function rollback(argv, demi, { at = LATER, backup = openBackup, fetchFn } = {}) {
  const lines = [];
  const code = await run(argv, { write: line => lines.push(line), demi, openBackup: backup, now: () => at, fetchFn });
  const value = key => (lines.find(line => line.startsWith(`${key}=`)) || '').slice(key.length + 1);
  return { code, lines, value };
}

/** A live load on a fresh store; resolves the store, the fake DEMI, the batch header and the rollback argv for it. */
async function loaded(t, given = inputs(), demi = rollbackDemi(), { signoff } = {}) {
  const store = fakeLists(t);
  const { value } = await liveRun(given, demi, { signoff });
  return { store, demi, ...loadedBatch(store, given, value('batchId')) };
}

function loadedBatch(store, given, batchId) {
  const header = store.get(batchId, KINDS.BATCH);
  const argv = argsOf('rollback', batchId, { backup: path.join(given.outDir, header.backupBlob), sha: header.backupSha256 });
  return { batchId, header, argv };
}

/** The Track works a read with sheet in its sources shows for the fake's documents. */
function shownTrackIds(docs) {
  const all = [...docs.values()].filter(doc => !doc.deleted);
  const track = all.filter(doc => doc.source === 'track');
  const marker = docs.get(OVERRIDE_MARKER_ID);
  if (!marker) return track.map(doc => doc.id);
  const { boundary, shownSheetIds } = overrideShown(all.filter(isSheet), track, marker);
  return track.filter(doc => !hiddenByOverride(doc, marker, boundary, shownSheetIds)).map(doc => doc.id);
}

module.exports = { LATER, SHA, DERIVE_ENV, isSheet, rollbackDemi, openBackup, argsOf, rollback, loaded, loadedBatch, shownTrackIds };
