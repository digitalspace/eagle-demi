'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const batches = require('../../src/scripts/works-import-batch');
const { fingerprintOf, openEnvelope, verify } = require('../../src/utils/import-envelope');
const { fakeLists } = require('./works-import-fakes');

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

test('lists reads return no ImportBatch, ImportBatchEntry or ImportLock item: none carries read[]', async (t) => {
  const { store, run } = await started(t);
  await batches.writeAhead(run, { target, action: 'create' }, async () => '"w"', T0);
  const written = store.all();
  assert.deepEqual([...new Set(written.map(item => item.kind))].sort(), [KINDS.BATCH, KINDS.ENTRY, KINDS.LOCK].sort());
  assert.deepEqual(written.filter(item => 'read' in item || 'isPublished' in item), []);
});

test('writeSealed writes one 0600 blob the operator opens and whose devbox signature verifies', () => {
  const operator = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
  const ed = crypto.generateKeyPairSync('ed25519');
  const recipient = { rsa: operator.publicKey, fingerprint: fingerprintOf({ rsa: operator.publicKey }) };
  const dir = fs.mkdtempSync(path.join(tmp, 'sealed-'));
  const plaintext = Buffer.from('{"report":[]}');
  const { name, sha256 } = batches.writeSealed(dir, plaintext, { purpose: 'works-report', env: 'test', recipient, signingKey: ed.privateKey });
  assert.deepEqual(fs.readdirSync(dir), [name]);
  assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600);
  const opened = openEnvelope(fs.readFileSync(path.join(dir, name)), {
    purpose: 'works-report', env: 'test', keyFingerprint: recipient.fingerprint, privateKey: operator.privateKey
  });
  assert.equal(opened.plaintext.toString(), plaintext.toString());
  assert.ok(verify(ed.publicKey, { purpose: 'works-report', env: 'test', sha256 }, opened.signature));
});
