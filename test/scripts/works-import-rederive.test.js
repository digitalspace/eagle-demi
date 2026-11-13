'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../../src/config');
const { KINDS } = require('../../src/scripts/works-import-batch');
const { API_BASE } = require('../../src/scripts/works-import-rederive');
const { PROJECT } = require('../helpers/works-import-loader');
const { isSheet, rollback, loaded } = require('../helpers/works-import-rollback');

/** A loaded batch on a public row; the fake records each derive's sources and each probe request. */
async function published(t) {
  const setup = await loaded(t);
  const { demi } = setup;
  demi.row = { ...demi.row, read: ['public'] };
  demi.derives = [];
  demi.patchDerived = async (projectId, sources) => { demi.derives.push({ projectId, sources }); return { status: 'patched' }; };
  const sheetIds = [...demi.docs.values()].filter(isSheet).map(doc => doc.id);
  return { ...setup, sheetIds };
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

test('rederive re-derives the batch\'s projects from Track and sheet once the probe shows a batch sheet work', async (t) => {
  const { demi, batchId, sheetIds } = await published(t);

  const { code, value } = await rollback(rederive(batchId), demi, publicRead(['track-45', sheetIds[0]]));
  assert.equal(code, 0);
  assert.equal(value('flipProbe'), PROJECT);
  assert.deepEqual(demi.derives, [{ projectId: PROJECT, sources: ['track', 'sheet'] }]);
});

test('rederive refuses when the probe lacks a batch work id', async (t) => {
  const { demi, batchId } = await published(t);

  await assert.rejects(rollback(rederive(batchId), demi, publicRead(['track-45', elsewhere])), /holds no sheet work of the batch/);
  assert.deepEqual(demi.derives, []);
});

test('rederive sends no Authorization header', async (t) => {
  const { demi, batchId, sheetIds } = await published(t);
  const { fetchFn, requests } = publicRead(sheetIds);

  await rollback(rederive(batchId), demi, { fetchFn });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${API_BASE.test}/projects/${PROJECT}`);
  assert.ok(!Object.keys(requests[0].init.headers || {}).some(name => name.toLowerCase() === 'authorization'));
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

test('rederive refuses a batch that is not a complete load batch', async (t) => {
  const { store, demi, batchId } = await published(t);
  store.set({ ...store.get(batchId, KINDS.BATCH), status: 'rolledBack' });

  await assert.rejects(rollback(rederive(batchId), demi, publicRead([])), /only on a complete load batch/);
});

test('--unflip refuses while the probe still shows a batch sheet work', async (t) => {
  const { demi, batchId, sheetIds } = await published(t);

  await assert.rejects(rollback(rederive(batchId, '--unflip'), demi, publicRead([sheetIds[0]])), /still holds 1 sheet works of the batch/);
  assert.deepEqual(demi.derives, []);
});

test('--unflip re-derives from WORKS_READ_SOURCES once the read works show no batch sheet work, whatever the stored assessments list', async (t) => {
  const { demi, batchId, sheetIds } = await published(t);
  const read = publicRead(['track-43', 'track-45'], { storedIds: sheetIds });

  assert.equal((await rollback(rederive(batchId, '--unflip'), demi, read)).code, 0);
  assert.deepEqual(demi.derives, [{ projectId: PROJECT, sources: undefined }]);
});

test('--unflip refuses while WORKS_READ_SOURCES still holds sheet', async (t) => {
  const { demi, batchId } = await published(t);
  const sources = config.worksReadSources;
  config.worksReadSources = ['track', 'sheet'];
  t.after(() => { config.worksReadSources = sources; });

  await assert.rejects(rollback(rederive(batchId, '--unflip'), demi, publicRead([])), /WORKS_READ_SOURCES without sheet/);
});

test('rederive refuses when the probe answers an error', async (t) => {
  const { demi, batchId } = await published(t);
  const fetchFn = async () => ({ ok: false, status: 503 });

  await assert.rejects(rollback(rederive(batchId), demi, { fetchFn }), /probe of project 7001 answered 503/);
  assert.deepEqual(demi.derives, []);
});
