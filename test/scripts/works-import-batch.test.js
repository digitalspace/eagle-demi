'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const batches = require('../../src/scripts/works-import-batch');
const cosmos = require('../../src/db/cosmos-nosql');
const { fakeLists } = require('../helpers/works-import-fakes');
const lists = require('../../src/repositories/lists');
const { resolveAccess } = require('../../src/helpers/access-sql');

const { KINDS, LOCK_ID, LEASE_MS, RENEW_EVERY } = batches;
const T0 = Date.parse('2026-11-13T18:00:00Z');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'works-import-batch-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function started(t, batchId = 'b1') {
  const store = fakeLists(t);
  const lease = await batches.takeLock(batchId, T0);
  const batch = await batches.createBatch(batchId, { operator: 'op', runRef: 'run-1', signoffRef: 'so-1' }, T0);
  return { store, lease, batch, run: { batchId, lease, seq: 0 } };
}

const target = { projectId: '7001', id: 'sheet-1' };

test('--live refuses while the lock exists, even expired', async (t) => {
  const store = fakeLists(t);
  store.set({ kind: KINDS.LOCK, id: LOCK_ID, batchId: 'old', expiresAt: new Date(T0 - LEASE_MS).toISOString() });
  await assert.rejects(batches.takeLock('b2', T0), /lock exists/);
});

test('--live refuses while a batch is pending', async (t) => {
  const store = fakeLists(t);
  store.set({ kind: KINDS.BATCH, id: 'old', status: 'pending' });
  await assert.rejects(batches.takeLock('b2', T0), /pending/);
  assert.equal(store.get(LOCK_ID, KINDS.LOCK), undefined);
});

test('a complete batch releases the lock for the next run', async (t) => {
  const { store, lease, batch } = await started(t);
  await batches.completeBatch(batch, lease, T0);
  assert.equal(store.get('b1', KINDS.BATCH).status, 'complete');
  await batches.takeLock('b2', T0);
  assert.equal(store.get(LOCK_ID, KINDS.LOCK).batchId, 'b2');
});

test('a write after the local lease expiry stops the run', async (t) => {
  const { store, run } = await started(t);
  let wrote = false;
  await assert.rejects(batches.writeAhead(run, { target, action: 'create' }, async () => { wrote = true; }, T0 + LEASE_MS),
    err => err.code === 'LEASE_LOST');
  assert.equal(wrote, false);
  assert.equal(store.get('b1', KINDS.BATCH).status, 'pending');
  assert.equal(store.get('b1:1', KINDS.ENTRY), undefined);
});

test('lost lease stops live with the batch pending', async (t) => {
  const { store, run } = await started(t);
  run.lease.writes = RENEW_EVERY;
  // A rewrite of the lock by another run moves its etag past the lease's.
  store.set({ ...store.get(LOCK_ID, KINDS.LOCK), batchId: 'other' });
  let wrote = false;
  await assert.rejects(batches.writeAhead(run, { target, action: 'create' }, async () => { wrote = true; }, T0),
    err => err.code === 'LEASE_LOST');
  assert.equal(wrote, false);
  assert.equal(store.get('b1', KINDS.BATCH).status, 'pending');
});

test('the lease renews every RENEW_EVERY writes', async (t) => {
  const { store, run } = await started(t);
  run.lease.writes = RENEW_EVERY;
  await batches.writeAhead(run, { target, action: 'create' }, async () => '"w"', T0 + 1000);
  assert.equal(store.get(LOCK_ID, KINDS.LOCK).expiresAt, new Date(T0 + 1000 + LEASE_MS).toISOString());
});

test('every entry is written before its document or project entry', async (t) => {
  const { store, run } = await started(t);
  let seen = null;
  await batches.writeAhead(run, { target, action: 'create' }, async () => { seen = store.get('b1:1', KINDS.ENTRY).state; return '"w1"'; }, T0);
  assert.equal(seen, 'intent');
  assert.equal(store.get('b1:1', KINDS.ENTRY).state, 'done');
  assert.equal(store.get('b1:1', KINDS.ENTRY).writtenEtag, '"w1"');
});

test('entries hold no sourceKey, number or staff value', async (t) => {
  const { store, run } = await started(t);
  const leaky = { projectId: '7001', id: 'sheet-1', sourceKey: '45:assessment:1' };
  await assert.rejects(batches.writeAhead(run, { target: leaky, action: 'create' }, async () => '"w"', T0), /target must be/);
  await assert.rejects(batches.writeAhead(run, { target: { projectId: '7001', system: 7 }, action: 'addExternalId' }, async () => '"w"', T0), /target must be/);
  assert.equal(store.all().filter(item => item.kind === KINDS.ENTRY).length, 0);
});

test('lists reads return no ImportBatch, ImportBatchEntry or ImportLock item', async (t) => {
  const { run } = await started(t);
  await batches.writeAhead(run, { target, action: 'create' }, async () => '"w"', T0);
  const staff = resolveAccess({ user: { preferred_username: 'staff.person', roles: ['staff'] } });
  const reads = [[LOCK_ID, KINDS.LOCK], ['b1', KINDS.BATCH], ['b1:1', KINDS.ENTRY]]
    .flatMap(([id, kind]) => [resolveAccess({}), staff].map(access => lists.getById(access, id, kind)));
  assert.deepEqual(await Promise.all(reads), [null, null, null, null, null, null]);
});

test('takeOverLock refuses a lock with no readable expiry or held by another batch', async (t) => {
  const store = fakeLists(t);
  store.set({ kind: KINDS.LOCK, id: LOCK_ID, batchId: 'b1', expiresAt: 'soon' });
  await assert.rejects(batches.takeOverLock('b1', T0), /no readable expiry/);
  store.set({ kind: KINDS.LOCK, id: LOCK_ID, batchId: 'other', expiresAt: new Date(T0 - 1).toISOString() });
  await assert.rejects(batches.takeOverLock('b1', T0), /another batch/);
  assert.equal(store.get(LOCK_ID, KINDS.LOCK).batchId, 'other');
});

test('listEntries refuses a batch with a missing entry below its highest seq', async (t) => {
  const { store, run } = await started(t);
  await batches.writeAhead(run, { target, action: 'create' }, async () => '"w1"', T0);
  await batches.writeAhead(run, { target, action: 'update' }, async () => '"w2"', T0);
  assert.deepEqual((await batches.listEntries('b1')).map(entry => entry.seq), [1, 2]);
  await cosmos.remove(batches.CONTAINER, 'b1:1', KINDS.ENTRY, { etag: store.get('b1:1', KINDS.ENTRY)._etag });
  await assert.rejects(batches.listEntries('b1'), /missing an entry/);
});

test('two takers of an expired lock, one wins', async (t) => {
  const store = fakeLists(t);
  store.set({ kind: KINDS.LOCK, id: LOCK_ID, batchId: 'b1', expiresAt: new Date(T0 - 1).toISOString() });
  const results = await Promise.allSettled([batches.takeOverLock('b1', T0), batches.takeOverLock('b1', T0)]);
  assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /another run took/);
  assert.equal(store.get(LOCK_ID, KINDS.LOCK)._etag, results.find(result => result.status === 'fulfilled').value.etag);
});
