'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { run } = require('../../src/scripts/rollback-business-works');
const batches = require('../../src/scripts/works-import-batch');
const cosmos = require('../../src/db/cosmos-nosql');
const history = require('../../src/repositories/project-staff-history');
const { OVERRIDE_MARKER_ID, hiddenByOverride } = require('../../src/domain/work-model');
const { overrideShown } = require('../../src/domain/works-derive');
const { openEnvelope, fingerprintOf } = require('../../src/utils/import-envelope');
const { logger } = require('../../src/utils/logger');
const { fakeLists, amendment, register } = require('../helpers/works-import-fakes');
const { ENV, T0, PROJECT, operator, fakeDemi, inputs, liveRun } = require('../helpers/works-import-loader');

const { KINDS, LOCK_ID, LEASE_MS } = batches;
const LATER = T0 + 60 * 1000;
const SHA = 'a'.repeat(64);
const OTHER = '7002';
const DERIVE_ENV = { WORKS_READ: 'true', WORKS_READ_SOURCES: 'track' };

const saved = Object.fromEntries(Object.keys(DERIVE_ENV).map(name => [name, process.env[name]]));
Object.assign(process.env, DERIVE_ENV);
test.after(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const isSheet = doc => doc.source === 'sheet' && doc.id !== OVERRIDE_MARKER_ID;

/** fakeDemi plus the rollback's reads and undo writes; history undo follows the repository's hash rule. */
function rollbackDemi(demi = fakeDemi()) {
  const sha = history.historyEntrySha256;
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

async function rollback(argv, demi, { at = LATER, backup = openBackup } = {}) {
  const lines = [];
  const code = await run(argv, { write: line => lines.push(line), demi, openBackup: backup, now: () => at });
  const value = key => (lines.find(line => line.startsWith(`${key}=`)) || '').slice(key.length + 1);
  return { code, lines, value };
}

/** A live load on a fresh store; resolves the store, the fake DEMI, the batch header and the rollback argv for it. */
async function loaded(t, given = inputs(), demi = rollbackDemi()) {
  const store = fakeLists(t);
  const { value } = await liveRun(given, demi);
  return { store, demi, ...loadedBatch(store, given, value('batchId')) };
}

function loadedBatch(store, given, batchId) {
  const header = store.get(batchId, KINDS.BATCH);
  const argv = argsOf('rollback', batchId, { backup: path.join(given.outDir, header.backupBlob), sha: header.backupSha256 });
  return { batchId, header, argv };
}

const second = () => inputs({ records: { projects: [register], amendments: [amendment(2, '2012-02-01', '2012-05-01')] } });

/** The Track works a read with sheet in its sources shows for the fake's documents. */
function shownTrackIds(docs) {
  const all = [...docs.values()].filter(doc => !doc.deleted);
  const track = all.filter(doc => doc.source === 'track');
  const marker = docs.get(OVERRIDE_MARKER_ID);
  if (!marker) return track.map(doc => doc.id);
  const { boundary, shownSheetIds } = overrideShown(all.filter(isSheet), track, marker);
  return track.filter(doc => !hiddenByOverride(doc, marker, boundary, shownSheetIds)).map(doc => doc.id);
}

/** A hand-built `lists` store: one batch header and its entries, numbered from 1. */
function seeded(t, { status = 'complete', entries, lock }) {
  const store = fakeLists(t);
  store.set({ kind: KINDS.BATCH, id: 'b1', batchKind: 'load', status, backupSha256: SHA, startedAt: new Date(T0).toISOString(),
    ...(status === 'complete' && { completedAt: new Date(T0 + 1).toISOString() }) });
  entries.forEach((entry, i) => store.set({ kind: KINDS.ENTRY, id: `b1:${i + 1}`, batchId: 'b1', seq: i + 1, priorEtag: null, state: 'done', ...entry }));
  if (lock) store.set({ kind: KINDS.LOCK, id: LOCK_ID, batchId: 'b1', ...lock });
  return store;
}

const backupOf = fields => async () => ({ batchId: 'b1', documents: [], projects: [], projectEntries: [], ...fields });
const expiredLock = { expiresAt: new Date(LATER - 1).toISOString() };
const sheetDoc = (id, fields) => ({ id, projectId: PROJECT, source: 'sheet', owner: 'sheet', sourceKey: `101:amendment:${id}`, ...fields });
const staffEntry = (id, fields) => ({ id, role: 'epd', name: 'Pat Example', effectiveFrom: null, effectiveTo: null, source: 'sheet', sheetKey: 'register:epd', ...fields });
const rollbackBatches = store => store.all().filter(item => item.kind === KINDS.BATCH && item.batchKind === 'rollback');
const externalIdEntry = fields => ({ target: { projectId: PROJECT, system: 'eao-register' }, action: 'addExternalId', writtenEtag: '"r1"', ...fields });
const plannedId = value => ({ action: 'addExternalId', projectId: PROJECT, pair: { system: 'eao-register', value, source: 'sheet' } });

/** `demi.removeWork` that throws on its `n`th call, once; `landed` makes that call delete first. */
function failingRemove(demi, n, { landed = false } = {}) {
  const remove = demi.removeWork;
  let calls = 0;
  demi.removeWork = async (target, options) => {
    calls += 1;
    if (calls !== n) return remove(target, options);
    if (landed) await remove(target, options);
    throw new Error('the undo stopped');
  };
}

test('rollback removes the batch\'s markers, so Track\'s works show', async (t) => {
  const { store, demi, batchId, argv } = await loaded(t);
  assert.ok(!shownTrackIds(demi.docs).includes('track-43'), 'the load hides track-43 behind its sheet copy');

  assert.equal((await rollback(argv, demi)).code, 0);
  assert.equal(demi.docs.get(OVERRIDE_MARKER_ID), undefined);
  assert.deepEqual(shownTrackIds(demi.docs).sort(), ['track-43', 'track-45']);
  assert.deepEqual([...demi.docs.values()].filter(isSheet), []);
  assert.deepEqual([...demi.docs.values()].map(doc => doc._etag), ['"t"', '"t"'], 'Track documents are never written');
  assert.equal(store.get(batchId, KINDS.BATCH).status, 'rolledBack');
  assert.deepEqual(rollbackBatches(store).map(one => [one.status, one.targetBatchId]), [['complete', batchId]]);
  assert.equal(store.get(LOCK_ID, KINDS.LOCK), undefined);
});

test('rollback after flip leaves no sheet work in the stored works', async (t) => {
  const demi = rollbackDemi();
  // With sheet in WORKS_READ_SOURCES the derive stores every live work of both sources on the row.
  demi.patchDerived = async () => {
    demi.row = { ...demi.row, works: [...demi.docs.values()].filter(doc => !doc.deleted && doc.id !== OVERRIDE_MARKER_ID).map(doc => doc.id) };
    return { status: 'patched' };
  };
  const { argv } = await loaded(t, inputs(), demi);
  assert.ok(demi.row.works.some(id => id.startsWith('sheet-')));

  assert.equal((await rollback(argv, demi)).code, 0);
  assert.deepEqual(demi.row.works.sort(), ['track-43', 'track-45']);
});

test('rollback refuses when a document etag moved', async (t) => {
  const { store, demi, batchId, argv } = await loaded(t);
  const [moved] = [...demi.docs.values()].filter(isSheet);
  demi.docs.set(moved.id, { ...moved, _etag: '"staff"' });
  const before = [...demi.docs.keys()].sort();

  await assert.rejects(rollback(argv, demi), /moved since the batch wrote it/);
  assert.deepEqual([...demi.docs.keys()].sort(), before);
  assert.equal(store.get(batchId, KINDS.BATCH).status, 'complete');
  assert.deepEqual(rollbackBatches(store), []);
  assert.equal(store.get(LOCK_ID, KINDS.LOCK), undefined);
});

test('rollback takes the expected etag from a later override batch entry', async (t) => {
  const { store, demi, argv } = await loaded(t);
  const marker = demi.docs.get(OVERRIDE_MARKER_ID);
  demi.docs.set(OVERRIDE_MARKER_ID, { ...marker, active: false, _etag: '"revert"' });
  store.set({ kind: KINDS.BATCH, id: 'ov1', batchKind: 'override', status: 'complete', startedAt: new Date(LATER).toISOString(), completedAt: new Date(LATER).toISOString() });
  store.set({ kind: KINDS.ENTRY, id: 'ov1:1', batchId: 'ov1', seq: 1, target: { projectId: PROJECT, id: OVERRIDE_MARKER_ID },
    action: 'marker', priorEtag: marker._etag, writtenEtag: '"revert"', state: 'done' });

  assert.equal((await rollback(argv, demi)).code, 0);
  assert.equal(demi.docs.get(OVERRIDE_MARKER_ID), undefined);
});

test('rollback removes created, restores tombstoned', async (t) => {
  const demi = rollbackDemi();
  const store = fakeLists(t);
  await liveRun(inputs(), demi);
  const first = [...demi.docs.values()].find(doc => doc.sourceKey === '101:amendment:1');
  const before = new Set(demi.docs.keys());
  const given = second();
  const { value } = await liveRun(given, demi);
  assert.equal(demi.docs.get(first.id).deleted, true);
  const created = [...demi.docs.keys()].filter(id => !before.has(id));
  assert.ok(created.length > 0);

  assert.equal((await rollback(loadedBatch(store, given, value('batchId')).argv, demi)).code, 0);
  assert.equal(demi.docs.get(first.id).deleted, undefined);
  assert.equal(demi.docs.get(first.id).sourceKey, first.sourceKey);
  assert.deepEqual(created.filter(id => demi.docs.has(id)), []);
});

test('rollback acts only on the latest complete load batch', async (t) => {
  const demi = rollbackDemi();
  const store = fakeLists(t);
  const given = inputs();
  const { value } = await liveRun(given, demi);
  await liveRun(second(), demi, { at: T0 + 1000 });

  await assert.rejects(rollback(loadedBatch(store, given, value('batchId')).argv, demi), /latest complete load batch/);
});

test('rollback of the previous load after rolling back the latest succeeds', async (t) => {
  const demi = rollbackDemi();
  const store = fakeLists(t);
  const given = inputs();
  const first = (await liveRun(given, demi)).value('batchId');
  const later = second();
  const latest = (await liveRun(later, demi, { at: T0 + 1000 })).value('batchId');
  assert.equal((await rollback(loadedBatch(store, later, latest).argv, demi)).code, 0);

  assert.equal((await rollback(loadedBatch(store, given, first).argv, demi, { at: LATER + 1000 })).code, 0);
  assert.deepEqual([...demi.docs.keys()].sort(), ['track-43', 'track-45']);
  assert.equal(store.get(first, KINDS.BATCH).status, 'rolledBack');
});

test('a rollback that fails on its second undo resumes on re-run and exits 0 with everything undone', async (t) => {
  const { store, demi, batchId, argv } = await loaded(t);
  failingRemove(demi, 2);
  await assert.rejects(rollback(argv, demi), /the undo stopped/);
  assert.deepEqual(rollbackBatches(store).map(one => one.status), ['pending']);
  assert.equal(store.get(LOCK_ID, KINDS.LOCK), undefined);

  assert.equal((await rollback(argv, demi)).code, 0);
  assert.deepEqual([...demi.docs.keys()].sort(), ['track-43', 'track-45']);
  assert.equal(store.get(batchId, KINDS.BATCH).status, 'rolledBack');
  assert.deepEqual(rollbackBatches(store).map(one => one.status), ['complete']);
});

test('a rollback-incomplete that fails after its second undo landed resumes on re-run and exits 0', async (t) => {
  const store = seeded(t, { status: 'pending', lock: expiredLock, entries: [
    { target: { projectId: PROJECT, id: 'sheet-a' }, action: 'create', writtenEtag: '"a1"' },
    { target: { projectId: PROJECT, id: 'sheet-b' }, action: 'create', writtenEtag: '"b1"' },
    { target: { projectId: PROJECT, id: 'sheet-c' }, action: 'create', writtenEtag: '"c1"' }
  ] });
  const demi = rollbackDemi();
  ['a', 'b', 'c'].forEach(n => demi.docs.set(`sheet-${n}`, sheetDoc(`sheet-${n}`, { _etag: `"${n}1"` })));
  failingRemove(demi, 2, { landed: true });
  await assert.rejects(rollback(argsOf('rollback-incomplete', 'b1'), demi, { backup: backupOf() }), /the undo stopped/);

  assert.equal((await rollback(argsOf('rollback-incomplete', 'b1'), demi, { backup: backupOf() })).code, 0);
  assert.deepEqual([...demi.docs.keys()].sort(), ['track-43', 'track-45']);
  assert.equal(store.get('b1', KINDS.BATCH).status, 'rolledBack');
});

test('a re-run after a failed re-derive redoes no undo, only the derive', async (t) => {
  const store = seeded(t, { status: 'pending', lock: expiredLock,
    entries: [{ target: { projectId: PROJECT, id: 'sheet-a' }, action: 'create', writtenEtag: '"a1"' }, externalIdEntry()] });
  const demi = rollbackDemi();
  demi.docs.set('sheet-a', sheetDoc('sheet-a', { _etag: '"a1"' }));
  demi.row = { ...demi.row, externalIds: [{ system: 'eao-register', value: '101', source: 'sheet' }] };
  let removals = 0;
  const remove = demi.removeExternalId;
  demi.removeExternalId = async (...args) => { removals += 1; return remove(...args); };
  const derive = demi.patchDerived;
  demi.patchDerived = async () => ({ status: 'missing' });
  const backup = backupOf({ projectEntries: [plannedId('101')] });
  assert.equal((await rollback(argsOf('rollback-incomplete', 'b1'), demi, { backup })).code, 1);

  demi.patchDerived = derive;
  const { code, value } = await rollback(argsOf('rollback-incomplete', 'b1'), demi, { backup });
  assert.equal(code, 0);
  assert.equal(value('undone'), '0');
  assert.equal(removals, 1);
  assert.equal(store.get('b1', KINDS.BATCH).status, 'rolledBack');
});

test('rollback takes over an expired lock its target holds', async (t) => {
  const { store, demi, batchId, argv } = await loaded(t);
  store.set({ kind: KINDS.LOCK, id: LOCK_ID, batchId, expiresAt: new Date(LATER - 1).toISOString() });

  assert.equal((await rollback(argv, demi)).code, 0);
  assert.equal(store.get(batchId, KINDS.BATCH).status, 'rolledBack');
});

test('rollback refuses a document Track now owns, and writes nothing', async (t) => {
  const store = seeded(t, { status: 'pending', lock: expiredLock,
    entries: [{ target: { projectId: PROJECT, id: 'sheet-d' }, action: 'update', priorEtag: '"d0"', state: 'intent' }] });
  const demi = rollbackDemi();
  demi.docs.set('sheet-d', sheetDoc('sheet-d', { owner: 'track', _etag: '"x"' }));
  const backup = backupOf({ documents: [sheetDoc('sheet-d', { _etag: '"d0"' })] });

  await assert.rejects(rollback(argsOf('rollback-incomplete', 'b1'), demi, { backup }), /not owned by sheet/);
  assert.equal(demi.docs.get('sheet-d')._etag, '"x"');
  assert.deepEqual(rollbackBatches(store), []);
});

test('rollback refuses an intent update whose document is gone', async (t) => {
  seeded(t, { status: 'pending', lock: expiredLock,
    entries: [{ target: { projectId: PROJECT, id: 'sheet-d' }, action: 'update', priorEtag: '"d0"', state: 'intent' }] });
  const backup = backupOf({ documents: [sheetDoc('sheet-d', { _etag: '"d0"' })] });

  await assert.rejects(rollback(argsOf('rollback-incomplete', 'b1'), rollbackDemi(), { backup }), /sheet-d on project 7001 is gone/);
});

test('rollback refuses an update the backup holds no prior copy of', async (t) => {
  seeded(t, { entries: [{ target: { projectId: PROJECT, id: 'sheet-d' }, action: 'update', priorEtag: '"d0"', writtenEtag: '"d1"' }] });
  const demi = rollbackDemi();
  demi.docs.set('sheet-d', sheetDoc('sheet-d', { _etag: '"d1"' }));

  await assert.rejects(rollback(argsOf('rollback', 'b1'), demi, { backup: backupOf() }), /no prior copy of document sheet-d/);
  assert.ok(demi.docs.has('sheet-d'));
});

test('rollback refuses a wrong --expect-backup-sha256 before any works read', async (t) => {
  seeded(t, { entries: [{ target: { projectId: PROJECT, id: 'sheet-a' }, action: 'create', writtenEtag: '"a1"' }] });
  const demi = rollbackDemi();

  await assert.rejects(rollback(argsOf('rollback', 'b1', { sha: 'b'.repeat(64) }), demi, { backup: backupOf() }), /--expect-backup-sha256/);
  assert.equal(demi.reads, 0);
});

test('rollback refuses a backup of another batch before any works read', async (t) => {
  seeded(t, { entries: [{ target: { projectId: PROJECT, id: 'sheet-a' }, action: 'create', writtenEtag: '"a1"' }] });
  const demi = rollbackDemi();

  await assert.rejects(rollback(argsOf('rollback', 'b1'), demi, { backup: backupOf({ batchId: 'b0' }) }), /not this batch/);
  assert.equal(demi.reads, 0);
});

test('rollback removes an external id after an unrelated row write', async (t) => {
  seeded(t, { entries: [externalIdEntry()] });
  const demi = rollbackDemi();
  demi.row = { ...demi.row, externalIds: [{ system: 'eao-register', value: '101', source: 'sheet' }], description: 'staff wrote this later', _etag: '"r9"' };

  assert.equal((await rollback(argsOf('rollback', 'b1'), demi, { backup: backupOf({ projectEntries: [plannedId('101')] }) })).code, 0);
  assert.deepEqual(demi.row.externalIds, []);
});

test('rollback keeps an external id the row held before the batch', async (t) => {
  seeded(t, { entries: [externalIdEntry(), externalIdEntry()] });
  const demi = rollbackDemi();
  demi.row = { ...demi.row, externalIds: [{ system: 'eao-register', value: '101', source: 'sheet' }, { system: 'eao-register', value: '102', source: 'eagle' }] };
  const backup = backupOf({ projects: [{ projectId: PROJECT, externalIds: [{ system: 'eao-register', value: '102', source: 'eagle' }] }],
    projectEntries: [plannedId('101'), plannedId('102')] });

  assert.equal((await rollback(argsOf('rollback', 'b1'), demi, { backup })).code, 0);
  assert.deepEqual(demi.row.externalIds.map(one => one.value), ['102']);
});

test('rollback keeps an external id whose add wrote nothing', async (t) => {
  seeded(t, { entries: [externalIdEntry({ writtenEtag: null })] });
  const demi = rollbackDemi();
  demi.row = { ...demi.row, externalIds: [{ system: 'eao-register', value: '101', source: 'eagle' }] };

  assert.equal((await rollback(argsOf('rollback', 'b1'), demi, { backup: backupOf({ projectEntries: [plannedId('101')] }) })).code, 0);
  assert.deepEqual(demi.row.externalIds.map(one => one.value), ['101']);
});

test('rollback refuses when a project entry undo answers conflict', async (t) => {
  const store = seeded(t, { entries: [externalIdEntry()] });
  const demi = rollbackDemi();
  demi.removeExternalId = async () => ({ status: 'conflict' });

  await assert.rejects(rollback(argsOf('rollback', 'b1'), demi, { backup: backupOf({ projectEntries: [plannedId('101')] }) }), /answered conflict/);
  assert.equal(store.get('b1', KINDS.BATCH).status, 'complete');
});

const appended = (close) => ({ action: 'appendHistory', projectId: PROJECT, field: 'staffAssignments', entry: staffEntry('n1'), close });
const appendEntry = { target: { projectId: PROJECT, field: 'staffAssignments', entryId: 'n1' }, action: 'appendHistory', writtenEtag: '"r1"' };

test('rollback reports a staff-edited history entry as changed and keeps it', async (t) => {
  seeded(t, { entries: [appendEntry] });
  const demi = rollbackDemi();
  demi.row = { ...demi.row, staffAssignments: [staffEntry('n1', { effectiveTo: '2026-11-20' })] };

  const { code, value } = await rollback(argsOf('rollback', 'b1'), demi, { backup: backupOf({ projectEntries: [appended(null)] }) });
  assert.equal(code, 0);
  assert.equal(value('changedProject'), PROJECT);
  assert.deepEqual(demi.row.staffAssignments.map(one => one.id), ['n1']);
});

test('a kept staff-edited entry leaves the entry it closed closed', async (t) => {
  seeded(t, { entries: [appendEntry] });
  const demi = rollbackDemi();
  const close = { id: 'o1', effectiveTo: '2026-11-13' };
  demi.row = { ...demi.row, staffAssignments: [staffEntry('o1', { effectiveTo: close.effectiveTo }), staffEntry('n1', { effectiveTo: '2026-11-20' })] };
  const backup = backupOf({ projects: [{ projectId: PROJECT, staffAssignments: [staffEntry('o1')] }], projectEntries: [appended(close)] });

  assert.equal((await rollback(argsOf('rollback', 'b1'), demi, { backup })).code, 0);
  assert.equal(demi.row.staffAssignments[0].effectiveTo, close.effectiveTo);
});

test('an intent close that never landed counts as restored, not changed', async (t) => {
  seeded(t, { status: 'pending', lock: expiredLock,
    entries: [{ target: { projectId: PROJECT, field: 'staffAssignments', entryId: 'o1' }, action: 'closeHistory', state: 'intent' }] });
  const demi = rollbackDemi();
  demi.row = { ...demi.row, staffAssignments: [staffEntry('o1')] };
  const backup = backupOf({ projects: [{ projectId: PROJECT, staffAssignments: [staffEntry('o1')] }],
    projectEntries: [{ action: 'closeHistory', projectId: PROJECT, field: 'staffAssignments', entryId: 'o1', effectiveTo: '2026-11-13' }] });

  const { code, value } = await rollback(argsOf('rollback-incomplete', 'b1'), demi, { backup });
  assert.equal(code, 0);
  assert.equal(value('changed'), '0');
});

test('rollback-incomplete undoes intent and done entries, including tombstones and project entries', async (t) => {
  const close = { id: 'o1', effectiveTo: '2026-11-13' };
  const store = seeded(t, {
    status: 'pending', lock: expiredLock,
    entries: [
      { target: { projectId: PROJECT, id: 'sheet-a' }, action: 'create', writtenEtag: '"a1"' },
      { target: { projectId: PROJECT, id: 'sheet-b' }, action: 'tombstone', priorEtag: '"b0"', writtenEtag: '"b1"' },
      appendEntry,
      { target: { projectId: PROJECT, id: 'sheet-c' }, action: 'create', state: 'intent' },
      { target: { projectId: PROJECT, id: 'sheet-d' }, action: 'update', priorEtag: '"d0"', state: 'intent' }
    ]
  });
  const demi = rollbackDemi();
  const liveB = sheetDoc('sheet-b', { startDate: '2012-02-01', _etag: '"b0"' });
  [sheetDoc('sheet-a', { _etag: '"a1"' }), sheetDoc('sheet-b', { deleted: true, _etag: '"b1"' }), sheetDoc('sheet-c', { _etag: '"c1"' }),
    sheetDoc('sheet-d', { _etag: '"d0"' })].forEach(doc => demi.docs.set(doc.id, doc));
  demi.row = { ...demi.row, staffAssignments: [staffEntry('o1', { effectiveTo: close.effectiveTo }), staffEntry('n1')] };
  const backup = backupOf({ documents: [liveB, sheetDoc('sheet-d', { _etag: '"d0"' })],
    projects: [{ projectId: PROJECT, staffAssignments: [staffEntry('o1')] }], projectEntries: [appended(close)] });

  assert.equal((await rollback(argsOf('rollback-incomplete', 'b1'), demi, { backup })).code, 0);
  assert.deepEqual(['sheet-a', 'sheet-c'].filter(id => demi.docs.has(id)), []);
  assert.equal(demi.docs.get('sheet-b').deleted, undefined);
  assert.equal(demi.docs.get('sheet-b').startDate, '2012-02-01');
  assert.equal(demi.docs.get('sheet-d')._etag, '"d0"', 'an intent whose write never landed is left alone');
  assert.deepEqual(demi.row.staffAssignments, [staffEntry('o1')]);
  assert.equal(store.get('b1', KINDS.BATCH).status, 'rolledBack');
  assert.equal(store.get(LOCK_ID, KINDS.LOCK), undefined);
});

test('rollback-incomplete refuses a fresh lease', async (t) => {
  const store = seeded(t, { status: 'pending', lock: { expiresAt: new Date(LATER + LEASE_MS).toISOString() },
    entries: [{ target: { projectId: PROJECT, id: 'sheet-a' }, action: 'create', writtenEtag: '"a1"' }] });
  const demi = rollbackDemi();
  demi.docs.set('sheet-a', sheetDoc('sheet-a', { _etag: '"a1"' }));

  await assert.rejects(rollback(argsOf('rollback-incomplete', 'b1'), demi, { backup: backupOf() }), /lease is fresh/);
  assert.ok(demi.docs.has('sheet-a'));
  assert.equal(store.get('b1', KINDS.BATCH).status, 'pending');
});

const twoProjects = (t) => seeded(t, { status: 'pending', lock: expiredLock, entries: [
  { target: { projectId: PROJECT, id: 'sheet-a' }, action: 'create', state: 'intent' },
  { target: { projectId: OTHER, id: 'sheet-z' }, action: 'create', state: 'intent' }
] });

test('rollback-incomplete re-derives every touched project', async (t) => {
  twoProjects(t);
  const demi = rollbackDemi();

  const { code, value } = await rollback(argsOf('rollback-incomplete', 'b1'), demi, { backup: backupOf() });
  assert.equal(code, 0);
  assert.deepEqual(demi.derived.sort(), [PROJECT, OTHER].sort());
  assert.equal(value('patched'), '2');
});

test('a patchDerived throw counts as conflict, every project is tried, and the batch is not marked rolledBack', async (t) => {
  const store = twoProjects(t);
  const demi = rollbackDemi();
  const tried = [];
  demi.patchDerived = async (id) => {
    tried.push(id);
    if (id === PROJECT) throw new Error('etag race lost');
    return { status: 'unchanged' };
  };

  const { code, value } = await rollback(argsOf('rollback-incomplete', 'b1'), demi, { backup: backupOf() });
  assert.equal(code, 1);
  assert.deepEqual(tried.sort(), [PROJECT, OTHER].sort());
  assert.equal(value('conflict'), '1');
  assert.equal(store.get('b1', KINDS.BATCH).status, 'pending');
  assert.deepEqual(rollbackBatches(store).map(one => one.status), ['pending'], 'a re-run resumes and re-derives');
});

test('rollback refuses unless WORKS_READ and WORKS_READ_SOURCES are exported', async (t) => {
  seeded(t, { entries: [] });
  t.after(() => Object.assign(process.env, DERIVE_ENV));
  delete process.env.WORKS_READ_SOURCES;
  await assert.rejects(rollback(argsOf('rollback', 'b1'), rollbackDemi(), { backup: backupOf() }), /^Error: WORKS_READ_SOURCES is not set$/);
  delete process.env.WORKS_READ;
  await assert.rejects(rollback(argsOf('rollback', 'b1'), rollbackDemi(), { backup: backupOf() }), /^Error: WORKS_READ is not set$/);
});

test('restoreHistory puts the prior entry back and keeps one that moved', async (t) => {
  const prior = staffEntry('o1');
  const closed = { ...prior, effectiveTo: '2026-11-13' };
  let row = { id: PROJECT, staffAssignments: [closed, staffEntry('o2', { effectiveTo: '2026-11-01' }), staffEntry('o3')], _etag: '"r1"' };
  t.mock.method(cosmos, 'readItem', async () => row);
  t.mock.method(cosmos, 'patch', async (_c, _id, _pk, [op]) => { row = { ...row, [op.path.slice(1)]: op.value, _etag: '"r2"' }; return row; });
  const closedSha = entry => history.historyEntrySha256({ ...entry, effectiveTo: '2026-11-13' });

  assert.deepEqual(await history.restoreHistory(PROJECT, 'staffAssignments', prior, history.historyEntrySha256(closed)), { status: 'restored' });
  assert.deepEqual(row.staffAssignments[0], prior);
  assert.deepEqual(await history.restoreHistory(PROJECT, 'staffAssignments', staffEntry('o2'), closedSha(staffEntry('o2'))), { status: 'changed' });
  assert.equal(row.staffAssignments[1].effectiveTo, '2026-11-01');
  assert.deepEqual(await history.restoreHistory(PROJECT, 'staffAssignments', staffEntry('o3'), closedSha(staffEntry('o3'))), { status: 'unchanged' });
});

test('stdout, stderr and logger output contain no sourceKey or number', async (t) => {
  const said = [];
  for (const level of ['error', 'warn', 'info', 'debug']) t.mock.method(logger, level, (...args) => { said.push(JSON.stringify(args)); });
  const { demi, argv } = await loaded(t);
  const { lines } = await rollback(argv, demi);
  said.push(...lines);
  const text = said.join('\n').replace(/[0-9a-f]{64}|[0-9a-f-]{36}/g, '');
  assert.ok(lines.length > 0);
  assert.ok(!text.includes(':amendment:'));
  assert.ok(!/\b101\b/.test(text));
});
