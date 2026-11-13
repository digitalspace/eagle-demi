'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../../src/config');
const { KINDS, LOCK_ID, LEASE_MS } = require('../../src/scripts/works-import-batch');
const { API_BASE, rederiveBatch, timedFetch } = require('../../src/scripts/works-import-rederive');
const { fakeLists } = require('../helpers/works-import-fakes');
const { T0, PROJECT } = require('../helpers/works-import-loader');
const { LATER, rollback, loaded } = require('../helpers/works-import-rollback');

/** config's WORKS_READ and WORKS_READ_SOURCES for the test: sheet in the sources after the flip, not after --unflip. */
function configure(t, { flipped = true } = {}) {
  const { worksRead, worksReadSources } = config;
  Object.assign(config, { worksRead: true, worksReadSources: flipped ? ['track', 'sheet'] : ['track'] });
  t.after(() => Object.assign(config, { worksRead, worksReadSources }));
}

/** A loaded batch on a public row; the fake records each derive's sources. `readable` are the batch sheet works a sheet read shows. */
async function published(t, options) {
  configure(t, options);
  const setup = await loaded(t);
  const { demi } = setup;
  demi.row = { ...demi.row, read: ['public'] };
  demi.derives = [];
  demi.patchDerived = async (projectId, sources) => { demi.derives.push({ projectId, sources }); return { status: 'patched' }; };
  return { ...setup, readable: await demi.readWorkIds() };
}

/** A fetch answering the public project read with works of `workIds` and stored assessments listing `storedIds`. */
function publicRead(workIds, { storedIds = workIds, requests = [] } = {}) {
  const fetchFn = async (url, init) => {
    requests.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ id: PROJECT, works: workIds.map(workId => ({ workId })), assessments: [{ workIds: storedIds }] }) };
  };
  return { fetchFn, requests };
}

const rederive = (batchId, ...more) => ['--rederive', batchId, ...more];
const elsewhere = 'sheet-00000000-0000-4000-8000-000000000000';

test('rederive re-derives the batch\'s projects from WORKS_READ_SOURCES once the probe shows a batch sheet work', async (t) => {
  const { demi, batchId, readable } = await published(t);

  const { code, value } = await rollback(rederive(batchId), demi, publicRead(['track-45', readable[0]]));
  assert.equal(code, 0);
  assert.equal(value('flipProbe'), PROJECT);
  assert.deepEqual(demi.derives, [{ projectId: PROJECT, sources: undefined }]);
});

test('rederive exits 1 when the count check fails', async (t) => {
  const { demi, batchId, readable } = await published(t);
  demi.patchDerived = async () => ({ status: 'missing' });

  const { code, value } = await rollback(rederive(batchId), demi, publicRead(readable));
  assert.equal(code, 1);
  assert.equal(value('missing'), '1');
});

test('rederive refuses unless WORKS_READ is on and sheet is in WORKS_READ_SOURCES', async (t) => {
  const { demi, batchId, readable } = await published(t, { flipped: false });

  await assert.rejects(rollback(rederive(batchId), demi, publicRead(readable)), /needs WORKS_READ=true and sheet in WORKS_READ_SOURCES/);
  config.worksReadSources = ['track', 'sheet'];
  config.worksRead = false;
  await assert.rejects(rollback(rederive(batchId), demi, publicRead(readable)), /needs WORKS_READ=true and sheet in WORKS_READ_SOURCES/);
});

test('rederive refuses when the probe lacks a batch work id', async (t) => {
  const { demi, batchId } = await published(t);

  await assert.rejects(rollback(rederive(batchId), demi, publicRead(['track-45', elsewhere])), /holds no sheet work of the batch/);
  assert.deepEqual(demi.derives, []);
});

test('rederive sends no Authorization header and refuses a redirect', async (t) => {
  const { demi, batchId, readable } = await published(t);
  const { fetchFn, requests } = publicRead(readable);

  await rollback(rederive(batchId), demi, { fetchFn });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${API_BASE.test}/projects/${PROJECT}`);
  assert.ok(!Object.keys(requests[0].init.headers || {}).some(name => name.toLowerCase() === 'authorization'));
  assert.equal(requests[0].init.redirect, 'error');
});

test('timedFetch sends a timeout signal and no Authorization header', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push(init); return { ok: true }; });

  await timedFetch(`${API_BASE.test}/projects/${PROJECT}`, { headers: { Accept: 'application/json' } });
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(calls[0].headers), ['Accept']);
});

test('rederive with no public batch project records it and re-derives', async (t) => {
  const { demi, batchId } = await published(t);
  demi.row = { ...demi.row, read: ['staff'] };
  const { fetchFn, requests } = publicRead([]);

  const { code, value } = await rollback(rederive(batchId), demi, { fetchFn });
  assert.equal(code, 0);
  assert.equal(value('flipProbe'), 'no public project');
  assert.equal(requests.length, 0);
  assert.equal(demi.derives.length, 1);
});

test('the probe skips a public project whose sheet works a sheet read hides and uses the next one', async (t) => {
  configure(t);
  const store = fakeLists(t);
  store.set({ kind: KINDS.BATCH, id: 'b1', batchKind: 'load', status: 'complete', startedAt: new Date(T0).toISOString(), completedAt: new Date(T0 + 1).toISOString() });
  [['7001', 'sheet-a'], ['7002', 'sheet-b']].forEach(([projectId, id], i) => store.set({ kind: KINDS.ENTRY, id: `b1:${i + 1}`, batchId: 'b1', seq: i + 1,
    target: { projectId, id }, action: 'create', priorEtag: null, writtenEtag: '"a"', state: 'done' }));
  // 7001's marker is reverted, so a sheet read shows none of its sheet works.
  const demi = { project: async id => ({ id, read: ['public'] }), readWorkIds: async row => (row.id === '7001' ? [] : ['sheet-b']), patchDerived: async () => ({ status: 'patched' }) };
  const { fetchFn, requests } = publicRead(['sheet-b']);

  const { code, value } = await rollback(rederive('b1'), demi, { fetchFn });
  assert.equal(code, 0);
  assert.equal(value('flipProbe'), '7002');
  assert.deepEqual(requests.map(one => one.url), [`${API_BASE.test}/projects/7002`]);
});

test('rederive takes over its own lock after a hard stop, and refuses while that lease is fresh', async (t) => {
  const { store, demi, batchId, readable } = await published(t);
  store.set({ kind: KINDS.LOCK, id: LOCK_ID, batchId, expiresAt: new Date(LATER + 1000).toISOString() });

  await assert.rejects(rollback(rederive(batchId), demi, publicRead(readable)), /lease is fresh/);
  assert.equal((await rollback(rederive(batchId), demi, { ...publicRead(readable), at: LATER + LEASE_MS })).code, 0);
  assert.equal(store.get(LOCK_ID, KINDS.LOCK), undefined);
});

test('rederive refuses a batch that is not a complete load batch', async (t) => {
  const { store, demi, batchId } = await published(t);
  store.set({ ...store.get(batchId, KINDS.BATCH), status: 'rolledBack' });

  await assert.rejects(rollback(rederive(batchId), demi, publicRead([])), /only on a complete load batch/);
});

test('--unflip refuses while the probe still shows a batch sheet work', async (t) => {
  const { demi, batchId, readable } = await published(t, { flipped: false });

  await assert.rejects(rollback(rederive(batchId, '--unflip'), demi, publicRead([readable[0]])), /still holds 1 sheet works of the batch/);
  assert.deepEqual(demi.derives, []);
});

test('--unflip re-derives from WORKS_READ_SOURCES once the read works show no batch sheet work, whatever the stored assessments list', async (t) => {
  const { demi, batchId, readable } = await published(t, { flipped: false });
  const read = publicRead(['track-43', 'track-45'], { storedIds: readable });

  assert.equal((await rollback(rederive(batchId, '--unflip'), demi, read)).code, 0);
  assert.deepEqual(demi.derives, [{ projectId: PROJECT, sources: undefined }]);
});

test('--unflip refuses while WORKS_READ_SOURCES still holds sheet', async (t) => {
  const { demi, batchId } = await published(t);

  await assert.rejects(rollback(rederive(batchId, '--unflip'), demi, publicRead([])), /WORKS_READ_SOURCES without sheet/);
});

test('rederive refuses when the probe answers an error or no JSON body', async (t) => {
  const { demi, batchId } = await published(t);
  const answer = res => ({ fetchFn: async () => res });

  await assert.rejects(rollback(rederive(batchId), demi, answer({ ok: false, status: 503 })), /probe of project 7001 answered 503$/);
  await assert.rejects(rollback(rederive(batchId), demi, answer({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } })),
    /probe of project 7001 answered 200 with no JSON body/);
  await assert.rejects(rollback(rederive(batchId), demi, answer({ ok: true, status: 200, json: async () => null })), /answered 200 with no JSON body/);
  assert.deepEqual(demi.derives, []);
});

test('rederive refuses an environment with no API base', async (t) => {
  const { demi, batchId } = await published(t);

  await assert.rejects(rederiveBatch({ rederive: batchId }, { demi, now: () => LATER, write: () => {}, fetchFn: async () => ({}), env: 'prod' }), /no API base for prod/);
});
