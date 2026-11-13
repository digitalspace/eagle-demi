'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { KINDS, LOCK_ID } = require('../../src/scripts/works-import-batch');
const { OVERRIDE_MARKER_ID } = require('../../src/domain/work-model');
const { overrideShown } = require('../../src/domain/works-derive');
const { logger } = require('../../src/utils/logger');
const { fakeLists, amendment, register } = require('../helpers/works-import-fakes');
const { T0, PROJECT, inputs, liveRun, staffed } = require('../helpers/works-import-loader');
const { LATER, isSheet, rollback, loaded, shownTrackIds } = require('../helpers/works-import-rollback');

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

/** A complete load batch writing markers on `projects`, and a fake DEMI holding an active sheet marker on each of `stored`. */
function markerStore(t, projects, stored) {
  const store = fakeLists(t);
  store.set({ kind: KINDS.BATCH, id: 'b1', batchKind: 'load', status: 'complete', startedAt: new Date(T0).toISOString(), completedAt: new Date(T0 + 1).toISOString() });
  projects.forEach((projectId, i) => store.set({ kind: KINDS.ENTRY, id: `b1:${i + 1}`, batchId: 'b1', seq: i + 1, target: { projectId, id: OVERRIDE_MARKER_ID },
    action: 'marker', priorEtag: null, writtenEtag: '"m"', state: 'done' }));
  store.set({ kind: KINDS.ENTRY, id: `b1:${projects.length + 1}`, batchId: 'b1', seq: projects.length + 1, target: { projectId: '7003', id: 'sheet-a' },
    action: 'create', priorEtag: null, writtenEtag: '"a"', state: 'done' });
  const markers = new Map(stored.map(projectId => [projectId, { id: OVERRIDE_MARKER_ID, projectId, source: 'sheet', owner: 'sheet', active: true, _etag: '"m"' }]));
  let n = 0;
  const demi = {
    markers,
    work: async projectId => markers.get(projectId) || null,
    saveWork: async (doc, { etag }) => {
      if (markers.get(doc.projectId)?._etag !== etag) return { status: 'foreign' };
      markers.set(doc.projectId, { ...doc, _etag: `"w${n += 1}"` });
      return { status: 'written', etag: markers.get(doc.projectId)._etag };
    },
    patchDerived: async () => ({ status: 'patched' })
  };
  return { store, demi };
}

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

/**
 * A revert --all over 7001 to 7003 whose write on 7003 is refused, or with `landed` lands and then fails; 7002 was
 * turned off by a load. Resolves the store, the fake and the pending override batch's id.
 */
async function stoppedRevert(t, { landed = false } = {}) {
  const { store, demi } = markerStore(t, ['7001', '7002', '7003'], ['7001', '7002', '7003']);
  demi.markers.set('7002', { ...demi.markers.get('7002'), active: false, deactivatedBy: 'load' });
  const save = demi.saveWork;
  demi.saveWork = async (doc, options) => {
    if (doc.projectId !== '7003') return save(doc, options);
    if (landed) await save(doc, options);
    throw new Error('connection reset');
  };
  await assert.rejects(rollback(['--revert-override', '--all'], demi), /connection reset/);
  demi.saveWork = save;
  const [stuck] = store.all().filter(item => item.kind === KINDS.BATCH && item.batchKind === 'override');
  assert.equal(stuck.status, 'pending');
  return { store, demi, stuck: stuck.id };
}

const markerValues = (demi, id) => [demi.markers.get(id).active, demi.markers.get(id).deactivatedBy];

test('rollback-incomplete clears a pending override batch', async (t) => {
  const { store, demi, stuck } = await stoppedRevert(t);
  await assert.rejects(rollback(['--revert-override', '--all'], demi), /an ImportBatch is pending/);

  const { code, value } = await rollback(['--rollback-incomplete', stuck], demi);
  assert.equal(code, 0);
  assert.deepEqual([markerValues(demi, '7001'), markerValues(demi, '7002')], [[true, undefined], [false, 'load']]);
  assert.equal(value('markers'), '2');
  assert.equal(value('moved'), '0', 'the 7003 write never landed, so its intent is left alone');
  assert.equal(value('patched'), '3');
  assert.equal(store.get(stuck, KINDS.BATCH).status, 'rolledBack');
  assert.equal(store.get(LOCK_ID, KINDS.LOCK), undefined);
  await assert.rejects(rollback(['--rollback-incomplete', stuck], demi), /only on a pending batch/);
  assert.equal((await rollback(['--revert-override', '--all'], demi)).code, 0);
});

test('rollback-incomplete undoes an override intent whose write landed', async (t) => {
  const { demi, stuck } = await stoppedRevert(t, { landed: true });
  assert.equal(demi.markers.get('7003').active, false);

  assert.equal((await rollback(['--rollback-incomplete', stuck], demi)).code, 0);
  assert.equal(demi.markers.get('7003').active, true);
});

test('rollback-incomplete keeps an override marker that moved and reports its project', async (t) => {
  const { demi, stuck } = await stoppedRevert(t);
  demi.markers.set('7001', { ...demi.markers.get('7001'), _etag: '"staff"' });

  const { code, value } = await rollback(['--rollback-incomplete', stuck], demi);
  assert.equal(code, 0);
  assert.equal(value('movedProject'), '7001');
  assert.equal(demi.markers.get('7001').active, false);
});

test('a rollback after an undone override batch expects the undo\'s etags', async (t) => {
  const { store, demi, argv } = await loaded(t);
  const save = demi.saveWork;
  demi.saveWork = async (doc, options) => { await save(doc, options); throw new Error('connection reset'); };
  await assert.rejects(rollback(revert, demi), /connection reset/);
  demi.saveWork = save;
  const [stuck] = store.all().filter(item => item.kind === KINDS.BATCH && item.batchKind === 'override');
  assert.equal((await rollback(['--rollback-incomplete', stuck.id], demi)).code, 0);
  assert.equal(marker(demi).active, true);

  assert.equal((await rollback(argv, demi, { at: LATER + 1000 })).code, 0);
  assert.equal(marker(demi), undefined);
});

test('rollback-incomplete of a pending load batch still needs its backup', async (t) => {
  const { store, demi } = markerStore(t, ['7001'], ['7001']);
  store.set({ kind: KINDS.BATCH, id: 'b2', batchKind: 'load', status: 'pending', startedAt: new Date(LATER).toISOString() });

  await assert.rejects(rollback(['--rollback-incomplete', 'b2'], demi), /of a load batch needs --backup/);
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
