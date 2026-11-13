'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { KINDS, LOCK_ID } = require('../../src/scripts/works-import-batch');
const { OVERRIDE_MARKER_ID } = require('../../src/domain/work-model');
const { overrideShown } = require('../../src/domain/works-derive');
const { logger } = require('../../src/utils/logger');
const { amendment, register } = require('../helpers/works-import-fakes');
const { T0, PROJECT, inputs, liveRun, staffed } = require('../helpers/works-import-loader');
const { LATER, markerStore, isSheet, rollback, loaded, shownTrackIds } = require('../helpers/works-import-rollback');

const revert = ['--revert-override', '--project', PROJECT];
const reapply = ['--reapply-override', '--project', PROJECT];
const marker = demi => demi.docs.get(OVERRIDE_MARKER_ID);
const trackShown = demi => shownTrackIds(demi.docs);

/** The sheet work ids a read with sheet in its sources shows. */
function sheetShown(demi) {
  const all = [...demi.docs.values()].filter(doc => !doc.deleted);
  return [...overrideShown(all.filter(isSheet), all.filter(doc => doc.source === 'track'), marker(demi)).shownSheetIds];
}

test('revert-override shows the Track work again, hides its sheet counterpart and keeps the sheet work', async (t) => {
  const { store, demi } = await loaded(t);
  const sheetIds = [...demi.docs.values()].filter(isSheet).map(doc => doc.id);
  const counterpart = marker(demi).hidden.find(pair => pair.trackWorkId === 'track-43').sheetWorkId;
  assert.ok(!trackShown(demi).includes('track-43'));
  assert.ok(sheetShown(demi).includes(counterpart));

  const { code, value } = await rollback(revert, demi);
  assert.equal(code, 0);
  assert.ok(trackShown(demi).includes('track-43'));
  assert.ok(!sheetShown(demi).includes(counterpart));
  assert.deepEqual(sheetIds.filter(id => demi.docs.get(id) && !demi.docs.get(id).deleted), sheetIds, 'the sheet works stay stored');
  assert.deepEqual([...demi.docs.values()].filter(doc => doc.source === 'track').map(doc => doc._etag), ['"t"', '"t"'], 'Track documents are never written');
  assert.equal(store.get(value('batchId'), KINDS.BATCH).batchKind, 'override');
  assert.equal(store.get(value('batchId'), KINDS.BATCH).status, 'complete');
  assert.equal(store.get(LOCK_ID, KINDS.LOCK), undefined);
});

test('the override batch records the marker\'s prior and written etags, then re-derives the project', async (t) => {
  const { store, demi } = await loaded(t);
  const prior = marker(demi)._etag;
  demi.derived.length = 0;

  const { value } = await rollback(revert, demi);
  const entry = store.get(`${value('batchId')}:1`, KINDS.ENTRY);
  assert.deepEqual([entry.action, entry.priorEtag, entry.writtenEtag, entry.state], ['marker', prior, marker(demi)._etag, 'done']);
  assert.deepEqual(entry.prior, { active: true, deactivatedBy: null });
  assert.deepEqual(demi.derived, [PROJECT]);
  assert.equal(value('patched'), '1');
});

test('reapply-override hides it again', async (t) => {
  const { demi } = await loaded(t);
  await rollback(revert, demi);

  assert.equal((await rollback(reapply, demi, { at: LATER + 1000 })).code, 0);
  assert.equal(marker(demi).active, true);
  assert.ok(!trackShown(demi).includes('track-43'));
});

test('re-run after revert keeps the marker off', async (t) => {
  const { demi } = await loaded(t);
  await rollback(revert, demi);

  await liveRun(inputs(), demi, { at: LATER + 1000 });
  assert.equal(marker(demi).active, false);
});

test('rollback after revert-override succeeds', async (t) => {
  const { demi, argv } = await loaded(t);
  await rollback(revert, demi);

  assert.equal((await rollback(argv, demi, { at: LATER + 1000 })).code, 0);
  assert.equal(marker(demi), undefined);
});

test('revert acts on the marker\'s live etag after a later load rewrote it', async (t) => {
  const { demi } = await loaded(t);
  const first = marker(demi)._etag;
  const both = [amendment(1, '2023-06-01', '2023-11-07'), amendment(2, '2015-03-01', '2015-05-07')];
  await liveRun(inputs({ records: { projects: [register], amendments: both } }), demi, { at: T0 + 1000 });
  assert.notEqual(marker(demi)._etag, first);

  assert.equal((await rollback(revert, demi)).code, 0);
  assert.equal(marker(demi).active, false);
});

test('revert --all turns off every marker of the latest load batch', async (t) => {
  const { demi } = markerStore(t, ['7001', '7002'], ['7001', '7002', '7003']);

  const { code, value } = await rollback(['--revert-override', '--all'], demi);
  assert.equal(code, 0);
  assert.deepEqual(['7001', '7002', '7003'].map(id => demi.markers.get(id).active), [false, false, true]);
  assert.equal(value('projects'), '2');
});

test('revert refuses before any write when a named project has no sheet marker', async (t) => {
  const { store, demi } = markerStore(t, ['7001', '7002'], ['7001']);
  demi.markers.set('7002', { ...demi.markers.get('7001'), projectId: '7002', owner: 'track' });

  await assert.rejects(rollback(['--revert-override', '--all'], demi), /not owned by sheet; nothing was written/);
  assert.equal(demi.markers.get('7001').active, true);
  assert.equal(store.all().filter(item => item.batchKind === 'override').length, 0);
  assert.equal(store.get(LOCK_ID, KINDS.LOCK), undefined);
});

test('revert names exactly one of --project and --all', async (t) => {
  const { demi } = markerStore(t, ['7001'], ['7001']);

  await assert.rejects(rollback(['--revert-override', '--all', '--project', '7001'], demi), /one of --project <id> or --all/);
  await assert.rejects(rollback(['--revert-override'], demi), /one of --project <id> or --all/);
});

test('revert stops when the marker moved between its read and its write', async (t) => {
  const { store, demi } = markerStore(t, ['7001'], ['7001']);
  demi.saveWork = async () => ({ status: 'foreign' });

  await assert.rejects(rollback(['--revert-override', '--all'], demi), /marker write on project 7001 answered foreign/);
  assert.equal(store.all().find(item => item.batchKind === 'override').status, 'pending');
});

/** Unsets `name` for the test, as on a devbox shell. */
function unsetEnv(t, name) {
  const value = process.env[name];
  delete process.env[name];
  t.after(() => { process.env[name] = value; });
}

test('revert, reapply, rederive, --unflip and an override undo refuse while WORKS_READ_SOURCES is unset', async (t) => {
  const { store, demi } = markerStore(t, ['7001'], ['7001']);
  store.set({ kind: KINDS.BATCH, id: 'ov1', batchKind: 'override', status: 'pending', startedAt: new Date(LATER).toISOString() });
  unsetEnv(t, 'WORKS_READ_SOURCES');
  const unset = /WORKS_READ_SOURCES is not set/;

  await assert.rejects(rollback(['--revert-override', '--all'], demi), unset);
  await assert.rejects(rollback(['--reapply-override', '--all'], demi), unset);
  await assert.rejects(rollback(['--rederive', 'b1'], demi), unset);
  await assert.rejects(rollback(['--rederive', 'b1', '--unflip'], demi), unset);
  await assert.rejects(rollback(['--rollback-incomplete', 'ov1'], demi), unset);
  assert.equal(demi.markers.get('7001')._etag, '"m"');
});

test('a derive refuses while WORKS_READ is unset', async (t) => {
  const { demi } = markerStore(t, ['7001'], ['7001']);
  unsetEnv(t, 'WORKS_READ');

  await assert.rejects(rollback(['--revert-override', '--all'], demi), /WORKS_READ is not set/);
  assert.equal(demi.markers.get('7001')._etag, '"m"');
});

test('stdout, stderr and logger output of revert, reapply and rederive contain no sourceKey or number', async (t) => {
  const said = [];
  for (const level of ['error', 'warn', 'info', 'debug']) t.mock.method(logger, level, (...args) => { said.push(JSON.stringify(args)); });
  const { demi, batchId } = await loaded(t, staffed(), undefined, { signoff: 'so-staff' });
  demi.row = { ...demi.row, read: ['public'] };
  const sheetIds = [...demi.docs.values()].filter(isSheet).map(doc => doc.id);
  const fetchFn = async () => ({ ok: true, status: 200, json: async () => ({ works: sheetIds.map(workId => ({ workId })) }) });
  const runs = [await rollback(['--revert-override', '--all'], demi), await rollback(reapply, demi), await rollback(['--rederive', batchId], demi, { fetchFn })];
  assert.deepEqual(runs.map(one => one.code), [0, 0, 0]);
  said.push(...runs.flatMap(one => one.lines));
  const text = said.join('\n').replace(/[0-9a-f]{64}|[0-9a-f-]{36}/g, '');
  assert.ok(!text.includes(':amendment:'));
  assert.ok(!/\b101\b/.test(text));
  assert.ok(!text.includes('staff-value'));
});
