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

const isSheet = doc => doc.source === 'sheet' && doc.id !== OVERRIDE_MARKER_ID;

/** fakeDemi plus the rollback's reads and undo writes; history undo follows the repository's hash rule. */
function rollbackDemi(demi = fakeDemi()) {
  const entryUnder = (field, entryId, expectedSha256, next) => {
    const list = demi.row[field] || [];
    const index = list.findIndex(one => one.id === entryId);
    if (index < 0) return { status: 'absent' };
    if (list[index].source === 'demi' || history.historyEntrySha256(list[index]) !== expectedSha256) return { status: 'changed' };
    demi.row = { ...demi.row, [field]: next(list, index) };
    return null;
  };
  return Object.assign(demi, {
    work: async (_projectId, id) => demi.docs.get(id) || null,
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
    removeHistory: async (_projectId, field, entryId, sha) => entryUnder(field, entryId, sha, (list, index) => list.toSpliced(index, 1)) || { status: 'removed' },
    restoreHistory: async (_projectId, field, prior, sha) => entryUnder(field, prior.id, sha, (list, index) => list.with(index, prior)) || { status: 'restored' }
  });
}

/** A stand-in for works-import-backup's openBackup: checks the hashes and batch id agree, then opens the sealed backup as the operator. */
const openBackup = async ({ sealedPath, expectSha256, batchId, batchBackupSha256 }) => {
  assert.equal(expectSha256, batchBackupSha256);
  const payload = JSON.parse(openEnvelope(fs.readFileSync(sealedPath), {
    purpose: 'works-backup', env: ENV, keyFingerprint: fingerprintOf({ rsa: operator.publicKey }), privateKey: operator.privateKey
  }).plaintext);
  assert.equal(payload.batchId, batchId);
  return payload;
};

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

const expiredLock = { expiresAt: new Date(LATER - 1).toISOString() };
const sheetDoc = (id, fields) => ({ id, projectId: PROJECT, source: 'sheet', owner: 'sheet', sourceKey: `101:amendment:${id}`, ...fields });
const staffEntry = (id, fields) => ({ id, role: 'epd', name: 'Pat Example', effectiveFrom: null, effectiveTo: null, source: 'sheet', sheetKey: 'register:epd', ...fields });

test('rollback removes the batch\'s markers, so Track\'s works show', async (t) => {
  const { store, demi, batchId, argv } = await loaded(t);
  assert.ok(!shownTrackIds(demi.docs).includes('track-43'), 'the load hides track-43 behind its sheet copy');

  assert.equal((await rollback(argv, demi)).code, 0);
  assert.equal(demi.docs.get(OVERRIDE_MARKER_ID), undefined);
  assert.deepEqual(shownTrackIds(demi.docs).sort(), ['track-43', 'track-45']);
  assert.deepEqual([...demi.docs.values()].filter(isSheet), []);
  assert.deepEqual([...demi.docs.values()].map(doc => doc._etag), ['"t"', '"t"'], 'Track documents are never written');
  assert.equal(store.get(batchId, KINDS.BATCH).status, 'rolledBack');
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
  const second = inputs({ records: { projects: [register], amendments: [amendment(2, '2012-02-01', '2012-05-01')] } });
  const { value } = await liveRun(second, demi);
  assert.equal(demi.docs.get(first.id).deleted, true);
  const created = [...demi.docs.keys()].filter(id => !before.has(id));
  assert.ok(created.length > 0);

  assert.equal((await rollback(loadedBatch(store, second, value('batchId')).argv, demi)).code, 0);
  assert.equal(demi.docs.get(first.id).deleted, undefined);
  assert.equal(demi.docs.get(first.id).sourceKey, first.sourceKey);
  assert.deepEqual(created.filter(id => demi.docs.has(id)), []);
});

test('rollback acts only on the latest complete load batch', async (t) => {
  const demi = rollbackDemi();
  const store = fakeLists(t);
  const given = inputs();
  const { value } = await liveRun(given, demi);
  await liveRun(inputs({ records: { projects: [register], amendments: [amendment(2, '2012-02-01', '2012-05-01')] } }), demi, { at: T0 + 1000 });

  await assert.rejects(rollback(loadedBatch(store, given, value('batchId')).argv, demi), /latest complete load batch/);
});

test('rollback removes an external id after an unrelated row write', async (t) => {
  seeded(t, { entries: [{ target: { projectId: PROJECT, system: 'eao-register' }, action: 'addExternalId', writtenEtag: '"r1"' }] });
  const demi = rollbackDemi();
  demi.row = { ...demi.row, externalIds: [{ system: 'eao-register', value: '101', source: 'sheet' }], description: 'staff wrote this later', _etag: '"r9"' };
  const backup = async () => ({ batchId: 'b1', documents: [], projects: [{ projectId: PROJECT }],
    projectEntries: [{ action: 'addExternalId', projectId: PROJECT, pair: { system: 'eao-register', value: '101', source: 'sheet' } }] });

  assert.equal((await rollback(argsOf('rollback', 'b1'), demi, { backup })).code, 0);
  assert.deepEqual(demi.row.externalIds, []);
});

test('rollback reports a staff-edited history entry as changed and keeps it', async (t) => {
  seeded(t, { entries: [{ target: { projectId: PROJECT, field: 'staffAssignments', entryId: 'n1' }, action: 'appendHistory', writtenEtag: '"r1"' }] });
  const demi = rollbackDemi();
  demi.row = { ...demi.row, staffAssignments: [staffEntry('n1', { effectiveTo: '2026-11-20' })] };
  const backup = async () => ({ batchId: 'b1', documents: [], projects: [{ projectId: PROJECT }],
    projectEntries: [{ action: 'appendHistory', projectId: PROJECT, field: 'staffAssignments', entry: staffEntry('n1'), close: null }] });

  const { code, value } = await rollback(argsOf('rollback', 'b1'), demi, { backup });
  assert.equal(code, 0);
  assert.equal(value('changedProject'), PROJECT);
  assert.deepEqual(demi.row.staffAssignments.map(one => one.id), ['n1']);
});

test('rollback-incomplete undoes intent and done entries, including tombstones and project entries', async (t) => {
  const close = { id: 'o1', effectiveTo: '2026-11-13' };
  const store = seeded(t, {
    status: 'pending', lock: expiredLock,
    entries: [
      { target: { projectId: PROJECT, id: 'sheet-a' }, action: 'create', writtenEtag: '"a1"' },
      { target: { projectId: PROJECT, id: 'sheet-b' }, action: 'tombstone', priorEtag: '"b0"', writtenEtag: '"b1"' },
      { target: { projectId: PROJECT, field: 'staffAssignments', entryId: 'n1' }, action: 'appendHistory', writtenEtag: '"r1"' },
      { target: { projectId: PROJECT, id: 'sheet-c' }, action: 'create', state: 'intent' },
      { target: { projectId: PROJECT, id: 'sheet-d' }, action: 'update', priorEtag: '"d0"', state: 'intent' }
    ]
  });
  const demi = rollbackDemi();
  const liveB = sheetDoc('sheet-b', { startDate: '2012-02-01', _etag: '"b0"' });
  [sheetDoc('sheet-a', { _etag: '"a1"' }), sheetDoc('sheet-b', { deleted: true, _etag: '"b1"' }), sheetDoc('sheet-c', { _etag: '"c1"' }),
    sheetDoc('sheet-d', { _etag: '"d0"' })].forEach(doc => demi.docs.set(doc.id, doc));
  demi.row = { ...demi.row, staffAssignments: [staffEntry('o1', { effectiveTo: close.effectiveTo }), staffEntry('n1')] };
  const backup = async () => ({ batchId: 'b1', documents: [liveB, sheetDoc('sheet-d', { _etag: '"d0"' })],
    projects: [{ projectId: PROJECT, staffAssignments: [staffEntry('o1')] }],
    projectEntries: [{ action: 'appendHistory', projectId: PROJECT, field: 'staffAssignments', entry: staffEntry('n1'), close }] });

  assert.equal((await rollback(argsOf('rollback-incomplete', 'b1'), demi, { backup })).code, 0);
  assert.deepEqual(['sheet-a', 'sheet-c'].filter(id => demi.docs.has(id)), []);
  assert.equal(demi.docs.get('sheet-b').deleted, undefined);
  assert.equal(demi.docs.get('sheet-b').startDate, '2012-02-01');
  assert.equal(demi.docs.get('sheet-d')._etag, '"d0"', 'an intent whose write never landed is left alone');
  assert.deepEqual(demi.row.staffAssignments, [staffEntry('o1')]);
  assert.equal(store.get('b1', KINDS.BATCH).status, 'rolledBack');
});

test('rollback-incomplete refuses a fresh lease', async (t) => {
  const store = seeded(t, { status: 'pending', lock: { expiresAt: new Date(LATER + LEASE_MS).toISOString() },
    entries: [{ target: { projectId: PROJECT, id: 'sheet-a' }, action: 'create', writtenEtag: '"a1"' }] });
  const demi = rollbackDemi();
  demi.docs.set('sheet-a', sheetDoc('sheet-a', { _etag: '"a1"' }));

  await assert.rejects(rollback(argsOf('rollback-incomplete', 'b1'), demi, { backup: async () => ({ batchId: 'b1' }) }), /lease is fresh/);
  assert.ok(demi.docs.has('sheet-a'));
  assert.equal(store.get('b1', KINDS.BATCH).status, 'pending');
});

const twoProjects = (t) => seeded(t, { status: 'pending', lock: expiredLock, entries: [
  { target: { projectId: PROJECT, id: 'sheet-a' }, action: 'create', state: 'intent' },
  { target: { projectId: OTHER, id: 'sheet-z' }, action: 'create', state: 'intent' }
] });
const emptyBackup = async () => ({ batchId: 'b1', documents: [], projects: [] });

test('rollback-incomplete re-derives every touched project', async (t) => {
  twoProjects(t);
  const demi = rollbackDemi();

  const { code, value } = await rollback(argsOf('rollback-incomplete', 'b1'), demi, { backup: emptyBackup });
  assert.equal(code, 0);
  assert.deepEqual(demi.derived.sort(), [PROJECT, OTHER].sort());
  assert.equal(value('patched'), '2');
});

test('the re-derive count check exits 1 when a touched project is missing', async (t) => {
  twoProjects(t);
  const demi = rollbackDemi();
  demi.patchDerived = async id => ({ status: id === OTHER ? 'missing' : 'unchanged' });

  const { code, value } = await rollback(argsOf('rollback-incomplete', 'b1'), demi, { backup: emptyBackup });
  assert.equal(code, 1);
  assert.equal(value('missing'), '1');
});

test('restoreHistory puts the prior entry back and keeps one that moved', async (t) => {
  const prior = staffEntry('o1');
  const closed = { ...prior, effectiveTo: '2026-11-13' };
  let row = { id: PROJECT, staffAssignments: [closed, staffEntry('o2', { effectiveTo: '2026-11-01' })], _etag: '"r1"' };
  t.mock.method(cosmos, 'readItem', async () => row);
  t.mock.method(cosmos, 'patch', async (_c, _id, _pk, [op]) => { row = { ...row, [op.path.slice(1)]: op.value, _etag: '"r2"' }; return row; });

  assert.deepEqual(await history.restoreHistory(PROJECT, 'staffAssignments', prior, history.historyEntrySha256(closed)), { status: 'restored' });
  assert.deepEqual(row.staffAssignments[0], prior);
  const o2 = staffEntry('o2');
  assert.deepEqual(await history.restoreHistory(PROJECT, 'staffAssignments', o2, history.historyEntrySha256({ ...o2, effectiveTo: '2026-11-13' })),
    { status: 'changed' });
  assert.equal(row.staffAssignments[1].effectiveTo, '2026-11-01');
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
