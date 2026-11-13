'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { KINDS, LOCK_ID, LEASE_MS } = require('../../src/scripts/works-import-batch');
const { OVERRIDE_MARKER_ID } = require('../../src/domain/work-model');
const { PROJECT } = require('../helpers/works-import-loader');
const { LATER, markerStore, rollback, loaded } = require('../helpers/works-import-rollback');

const undo = id => ['--rollback-incomplete', id];
const batchesOf = (store, kind) => store.all().filter(item => item.kind === KINDS.BATCH && item.batchKind === kind);
const markerValues = (demi, id) => [demi.markers.get(id).active, demi.markers.get(id).deactivatedBy];

/**
 * A revert --all over 7001 to 7003 whose write on 7003 throws, after landing with `landed`. Resolves the store, the
 * fake and the pending override batch's id.
 */
async function stopped(t, options) {
  const { store, demi } = markerStore(t, ['7001', '7002', '7003'], ['7001', '7002', '7003']);
  const save = demi.saveWork;
  demi.saveWork = async (doc, opts) => {
    if (doc.projectId !== '7003') return save(doc, opts);
    if (options?.landed) await save(doc, opts);
    throw new Error('connection reset');
  };
  await assert.rejects(rollback(['--revert-override', '--all'], demi), /connection reset; override batch .+ stays pending/);
  demi.saveWork = save;
  const [stuck] = batchesOf(store, 'override');
  assert.equal(stuck.status, 'pending');
  return { store, demi, stuck: stuck.id };
}

test('rollback-incomplete clears a pending override batch', async (t) => {
  const { store, demi, stuck } = await stopped(t);
  await assert.rejects(rollback(['--revert-override', '--all'], demi), /an ImportBatch is pending/);

  const { code, value } = await rollback(undo(stuck), demi);
  assert.equal(code, 0);
  assert.deepEqual([markerValues(demi, '7001'), markerValues(demi, '7002')], [[true, undefined], [true, undefined]]);
  assert.equal(value('markers'), '2');
  assert.equal(value('moved'), '0', 'the 7003 write never landed, so its intent is left alone');
  assert.equal(value('patched'), '3');
  assert.equal(store.get(stuck, KINDS.BATCH).status, 'rolledBack');
  assert.deepEqual(batchesOf(store, 'rollback').map(one => [one.targetBatchId, one.status]), [[stuck, 'complete']]);
  assert.equal(store.get(LOCK_ID, KINDS.LOCK), undefined);
  await assert.rejects(rollback(undo(stuck), demi), /only on a pending override batch/);
  assert.equal((await rollback(['--revert-override', '--all'], demi)).code, 0);
});

test('rollback-incomplete puts back the deactivatedBy a load set', async (t) => {
  const { store, demi } = markerStore(t, ['7002'], ['7002']);
  demi.markers.set('7002', { ...demi.markers.get('7002'), active: false, deactivatedBy: 'load' });
  const save = demi.saveWork;
  demi.saveWork = async (doc, options) => { await save(doc, options); throw new Error('connection reset'); };
  await assert.rejects(rollback(['--revert-override', '--project', '7002'], demi), /connection reset/);
  demi.saveWork = save;
  assert.deepEqual(markerValues(demi, '7002'), [false, undefined]);

  assert.equal((await rollback(undo(batchesOf(store, 'override')[0].id), demi)).code, 0);
  assert.deepEqual(markerValues(demi, '7002'), [false, 'load']);
});

test('rollback-incomplete undoes an override intent whose write landed', async (t) => {
  const { demi, stuck } = await stopped(t, { landed: true });
  assert.equal(demi.markers.get('7003').active, false);

  assert.equal((await rollback(undo(stuck), demi)).code, 0);
  assert.equal(demi.markers.get('7003').active, true);
});

test('rollback-incomplete keeps an override marker that moved and reports its project', async (t) => {
  const { demi, stuck } = await stopped(t);
  demi.markers.set('7001', { ...demi.markers.get('7001'), _etag: '"staff"' });

  const { code, value } = await rollback(undo(stuck), demi);
  assert.equal(code, 0);
  assert.equal(value('movedProject'), '7001');
  assert.equal(demi.markers.get('7001').active, false);
});

test('rollback-incomplete keeps a marker someone changed under an intent entry and reports its project', async (t) => {
  const { demi, stuck } = await stopped(t);
  demi.markers.set('7003', { ...demi.markers.get('7003'), active: false, deactivatedBy: 'load', _etag: '"load"' });

  const { code, value } = await rollback(undo(stuck), demi);
  assert.equal(code, 0);
  assert.equal(value('movedProject'), '7003');
  assert.equal(demi.markers.get('7003')._etag, '"load"');
});

test('rollback-incomplete refuses before any write when a marker is no longer the sheet\'s', async (t) => {
  const { store, demi, stuck } = await stopped(t);
  demi.markers.set('7002', { ...demi.markers.get('7002'), owner: 'track' });

  await assert.rejects(rollback(undo(stuck), demi), /not owned by sheet; this run wrote nothing/);
  assert.equal(demi.markers.get('7001').active, false);
  assert.deepEqual(batchesOf(store, 'rollback'), []);
});

test('rollback-incomplete of an override batch resumes after its undo stopped on the second marker', async (t) => {
  const { store, demi, stuck } = await stopped(t);
  const save = demi.saveWork;
  demi.saveWork = async (doc, options) => {
    if (doc.projectId === '7002') throw new Error('connection reset');
    return save(doc, options);
  };
  await assert.rejects(rollback(undo(stuck), demi), /connection reset; rollback batch .+ stays pending/);
  demi.saveWork = save;
  assert.equal(demi.markers.get('7001').active, true);
  // A load turns 7001 off after its restore; the resumed run leaves that alone and does not call it moved.
  demi.markers.set('7001', { ...demi.markers.get('7001'), active: false, deactivatedBy: 'load', _etag: '"load"' });

  const { code, value } = await rollback(undo(stuck), demi);
  assert.equal(code, 0);
  assert.equal(value('moved'), '0');
  assert.deepEqual(markerValues(demi, '7002'), [true, undefined]);
  assert.equal(store.get(stuck, KINDS.BATCH).status, 'rolledBack');
  assert.deepEqual(batchesOf(store, 'rollback').map(one => one.status), ['complete']);
});

test('a resumed override undo logs done the restore that landed before its run stopped', async (t) => {
  const { store, demi, stuck } = await stopped(t);
  const save = demi.saveWork;
  demi.saveWork = async (doc, options) => {
    if (doc.projectId !== '7002') return save(doc, options);
    await save(doc, options);
    throw new Error('connection reset');
  };
  await assert.rejects(rollback(undo(stuck), demi), /connection reset/);
  demi.saveWork = save;
  const [undoBatch] = batchesOf(store, 'rollback');

  assert.equal((await rollback(undo(stuck), demi)).code, 0);
  const restores = store.all().filter(item => item.kind === KINDS.ENTRY && item.batchId === undoBatch.id && item.state === 'done');
  assert.deepEqual(restores.map(one => [one.target.projectId, one.writtenEtag]), [['7001', demi.markers.get('7001')._etag], ['7002', demi.markers.get('7002')._etag]]);
});

test('rollback-incomplete of an override batch takes over its own lock after a hard stop', async (t) => {
  const { store, demi, stuck } = await stopped(t);
  demi.patchDerived = async () => ({ status: 'missing' });
  assert.equal((await rollback(undo(stuck), demi)).code, 1, 'the count check fails, so nothing is marked done');
  assert.equal(store.get(stuck, KINDS.BATCH).status, 'pending');
  const [pendingUndo] = batchesOf(store, 'rollback');
  assert.equal(pendingUndo.status, 'pending');
  store.set({ kind: KINDS.LOCK, id: LOCK_ID, batchId: stuck, expiresAt: new Date(LATER).toISOString() });
  demi.patchDerived = async () => ({ status: 'patched' });

  assert.equal((await rollback(undo(stuck), demi, { at: LATER + LEASE_MS })).code, 0);
  assert.equal(store.get(stuck, KINDS.BATCH).status, 'rolledBack');
  assert.equal(store.get(pendingUndo.id, KINDS.BATCH).status, 'complete');
});

test('--abandon-rollback clears a stuck override undo, and a fresh run finishes it', async (t) => {
  const { store, demi, stuck } = await stopped(t);
  const save = demi.saveWork;
  demi.saveWork = async (doc, options) => (doc.projectId === '7002' ? { status: 'foreign' } : save(doc, options));
  await assert.rejects(rollback(undo(stuck), demi), /answered foreign; rollback batch .+ stays pending/);
  demi.saveWork = save;
  const [stuckUndo] = batchesOf(store, 'rollback');

  assert.equal((await rollback(['--abandon-rollback', stuckUndo.id], demi)).code, 0);
  assert.equal(store.get(stuckUndo.id, KINDS.BATCH).status, 'abandoned');
  assert.equal(store.get(LOCK_ID, KINDS.LOCK), undefined);
  assert.equal((await rollback(undo(stuck), demi)).code, 0);
  assert.deepEqual([markerValues(demi, '7001'), markerValues(demi, '7002')], [[true, undefined], [true, undefined]]);
});

test('a rollback after an undone override batch expects the undo\'s etags', async (t) => {
  const { store, demi, argv } = await loaded(t);
  const save = demi.saveWork;
  demi.saveWork = async (doc, options) => { await save(doc, options); throw new Error('connection reset'); };
  await assert.rejects(rollback(['--revert-override', '--project', PROJECT], demi), /connection reset/);
  demi.saveWork = save;
  const [stuck] = batchesOf(store, 'override');
  assert.equal((await rollback(undo(stuck.id), demi)).code, 0);
  assert.equal(demi.docs.get(OVERRIDE_MARKER_ID).active, true);

  assert.equal((await rollback(argv, demi, { at: LATER + 1000 })).code, 0);
  assert.equal(demi.docs.get(OVERRIDE_MARKER_ID), undefined);
});

test('rollback-incomplete of an override batch refuses backup flags; a load batch still needs them', async (t) => {
  const { store, demi, stuck } = await stopped(t);
  store.set({ kind: KINDS.BATCH, id: 'b2', batchKind: 'load', status: 'pending', startedAt: new Date(LATER).toISOString() });

  await assert.rejects(rollback([...undo(stuck), '--backup', 'x'], demi), /an override batch takes no backup flags/);
  await assert.rejects(rollback(undo('b2'), demi), /of a load batch needs --backup/);
});
