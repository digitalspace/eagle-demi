'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const batches = require('../../src/scripts/works-import-batch');
const { LATER, markerStore, rollback } = require('../helpers/works-import-rollback');

const { KINDS, LOCK_ID } = batches;
const revertAll = ['--revert-override', '--all'];
const lockOf = (batchId, expiresAt) => ({ kind: KINDS.LOCK, id: LOCK_ID, batchId, expiresAt: new Date(expiresAt).toISOString() });

test('a revert stopped hard before its batch existed leaves a lock --clear-stale-lock frees', async (t) => {
  const { store, demi } = markerStore(t, ['7001'], ['7001']);
  // The process died after takeLock and before createBatch: the lock stays, naming a batch that never existed.
  t.mock.method(batches, 'createBatch', async () => { throw new Error('killed'); }, { times: 1 });
  t.mock.method(batches, 'releaseQuietly', async () => {}, { times: 1 });
  await assert.rejects(rollback(revertAll, demi, { at: LATER - batches.LEASE_MS }), /killed/);
  const orphan = store.get(LOCK_ID, KINDS.LOCK);

  await assert.rejects(rollback(revertAll, demi), new RegExp(`import lock exists, expired or not \\(batch ${orphan.batchId}, expires ${orphan.expiresAt}\\)`));
  const { code, value } = await rollback(['--clear-stale-lock'], demi);
  assert.deepEqual([code, value('clearedLock')], [0, orphan.batchId]);
  assert.equal(store.get(LOCK_ID, KINDS.LOCK), undefined);
  assert.equal((await rollback(revertAll, demi)).code, 0);
  assert.equal(demi.markers.get('7001').active, false);
});

test('--clear-stale-lock refuses a fresh lease', async (t) => {
  const { store, demi } = markerStore(t, ['7001'], ['7001']);
  store.set(lockOf('gone', LATER + 1));

  await assert.rejects(rollback(['--clear-stale-lock'], demi), /lease of batch gone is fresh/);
  assert.ok(store.get(LOCK_ID, KINDS.LOCK));
});

test('--clear-stale-lock refuses the lock of a pending batch, or of a batch a pending rollback undoes', async (t) => {
  const { store, demi } = markerStore(t, ['7001'], ['7001']);
  store.set(lockOf('ov1', LATER - 1));
  store.set({ kind: KINDS.BATCH, id: 'ov1', batchKind: 'override', status: 'pending', startedAt: new Date(LATER).toISOString() });

  await assert.rejects(rollback(['--clear-stale-lock'], demi), /batch ov1 is pending/);
  store.set({ ...store.get('ov1', KINDS.BATCH), status: 'rolledBack' });
  store.set({ kind: KINDS.BATCH, id: 'rb1', batchKind: 'rollback', targetBatchId: 'ov1', status: 'pending', startedAt: new Date(LATER).toISOString() });
  await assert.rejects(rollback(['--clear-stale-lock'], demi), /batch rb1 is pending/);
  assert.ok(store.get(LOCK_ID, KINDS.LOCK));
});
