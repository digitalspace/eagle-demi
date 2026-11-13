'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cosmos = require('../../src/db/cosmos-nosql');
const { KINDS, LOCK_ID } = require('../../src/scripts/works-import-batch');
const { fakeLists } = require('../helpers/works-import-fakes');
const { main } = require('../../src/scripts/load-business-works');
const { MAX_BYTES } = require('../../src/scripts/works-import-inputs');
const { fingerprintOf, openEnvelope } = require('../../src/utils/import-envelope');
const { ENV, T0, PROJECT, operator, fakeDemi, inputs, load, reportOf, liveArgs, staffed, liveRun } = require('../helpers/works-import-loader');

const DAY = 24 * 60 * 60 * 1000;
const entriesOf = store => store.all().filter(item => item.kind === KINDS.ENTRY).sort((a, b) => a.seq - b.seq);

test('a missing --out-dir refuses before the lock', async (t) => {
  const store = fakeLists(t);
  const given = inputs();
  const argv = given.argv.map(arg => (arg === given.outDir ? path.join(given.outDir, 'absent') : arg));
  await assert.rejects(load([...argv, ...liveArgs('0'.repeat(64))]), /--out-dir does not exist/);
  assert.deepEqual(store.all(), []);
});

test('a failure before the batch header frees the lock and keeps its error', async (t) => {
  const store = fakeLists(t);
  const create = cosmos.create;
  t.mock.method(cosmos, 'create', async (container, item) => {
    if (item.kind === KINDS.BATCH) throw new Error('header write failed');
    return create(container, item);
  });
  await assert.rejects(liveRun(inputs(), fakeDemi()), /header write failed/);
  assert.equal(store.get(LOCK_ID, KINDS.LOCK), undefined);
});

test('a failed lock release keeps the first error', async (t) => {
  const store = fakeLists(t);
  t.mock.method(cosmos, 'remove', async () => { throw new Error('release failed'); });
  await assert.rejects(load([...inputs().argv, ...liveArgs('0'.repeat(64))]), /planSha256 does not match/);
  assert.equal(store.get(LOCK_ID, KINDS.LOCK).kind, KINDS.LOCK);
});

test('a works-backup too big for a rollback to read refuses before the backup or the batch header is written', async (t) => {
  const store = fakeLists(t);
  const cap = MAX_BYTES.backup;
  MAX_BYTES.backup = 16 * 1024;
  t.after(() => { MAX_BYTES.backup = cap; });
  const given = inputs();
  const planSha256 = (await load(given.argv)).value('planSha256');
  const files = fs.readdirSync(given.outDir);
  await assert.rejects(load([...given.argv, ...liveArgs(planSha256)]), /works-backup would be over the size a rollback reads/);
  assert.deepEqual(fs.readdirSync(given.outDir), files);
  assert.deepEqual(store.all(), []);
});

test('the works-backup of a staff load holds the appended staff entry and the added external id', async (t) => {
  const store = fakeLists(t);
  const given = staffed();
  await liveRun(given, fakeDemi(), { signoff: 'so-staff' });
  const { backupBlob } = store.all().find(item => item.kind === KINDS.BATCH);
  const backup = JSON.parse(openEnvelope(fs.readFileSync(path.join(given.outDir, backupBlob)), {
    purpose: 'works-backup', env: ENV, keyFingerprint: fingerprintOf({ rsa: operator.publicKey }), privateKey: operator.privateKey
  }).plaintext);
  const appended = backup.projectEntries.find(entry => entry.action === 'appendHistory');
  const added = backup.projectEntries.find(entry => entry.action === 'addExternalId');
  assert.equal(appended.projectId, PROJECT);
  assert.equal(typeof appended.entry.id, 'string');
  assert.equal(added.projectId, PROJECT);
  assert.equal(typeof added.pair.system, 'string');
});

test('a write that fails mid-run leaves the batch pending, its entry intent, the lock held and later entries unwritten', async (t) => {
  const store = fakeLists(t);
  const demi = fakeDemi();
  const save = demi.saveWork;
  let saves = 0;
  demi.saveWork = async (...args) => {
    saves += 1;
    if (saves === 2) throw new Error('save failed');
    return save(...args);
  };
  await assert.rejects(liveRun(inputs(), demi), /save failed/);
  const entries = entriesOf(store);
  assert.deepEqual(entries.map(entry => entry.state), ['done', 'intent']);
  assert.equal(store.all().find(item => item.kind === KINDS.BATCH).status, 'pending');
  assert.equal(store.get(LOCK_ID, KINDS.LOCK).kind, KINDS.LOCK);
  assert.equal(saves, 2);
});

test('an unchanged staff load on a later day writes nothing', async (t) => {
  fakeLists(t);
  const demi = fakeDemi();
  const given = staffed();
  await liveRun(given, demi, { signoff: 'so-staff' });
  const second = await liveRun(given, demi, { signoff: 'so-staff', at: T0 + DAY });
  assert.equal(second.value('written'), '0');
});

test('project writes record the row etag as priorEtag, and each patchDerived gets its own entry', async (t) => {
  const store = fakeLists(t);
  await liveRun(staffed(), fakeDemi(), { signoff: 'so-staff' });
  const entries = entriesOf(store);
  assert.equal(entries.find(entry => entry.action === 'addExternalId').priorEtag, '"r"');
  assert.deepEqual(entries.filter(entry => entry.action === 'derive').map(entry => [entry.target.id, entry.state, entry.writtenEtag]), [[PROJECT, 'done', '"d"']]);
});

test('a patchDerived conflict stops the run with the batch pending', async (t) => {
  const store = fakeLists(t);
  const demi = fakeDemi();
  demi.patchDerived = async () => ({ status: 'conflict' });
  await assert.rejects(liveRun(inputs(), demi), /patchDerived on project .* answered conflict/);
  assert.equal(store.all().find(item => item.kind === KINDS.BATCH).status, 'pending');
});

test('--signoff-ref must be one of the extract\'s sign-off refs', async (t) => {
  const store = fakeLists(t);
  await assert.rejects(liveRun(staffed(), fakeDemi(), { signoff: 'so-other' }), /not a sign-off ref/);
  assert.deepEqual(store.all(), []);
});

test('an external id another project holds is not planned and is reported', async (t) => {
  fakeLists(t);
  const demi = fakeDemi();
  demi.externalIdHolders = async () => ['other-project'];
  const given = staffed();
  const dry = await load(given.argv, demi);
  assert.equal(dry.value('addExternalId'), '0');
  const report = reportOf(given.outDir, dry.value('blob')).report;
  assert.deepEqual(report.filter(entry => entry.reason === 'externalIdHeldElsewhere').map(entry => entry.projectId), [PROJECT]);
});

test('the command line refuses --live until the rollback can open its backup', async (t) => {
  const store = fakeLists(t);
  await assert.rejects(main([...inputs().argv, ...liveArgs('0'.repeat(64))]), /refused until the rollback/);
  assert.deepEqual(store.all(), []);
});
