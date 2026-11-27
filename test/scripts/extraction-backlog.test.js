'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const extractionRows = require('../../src/repositories/documents-extraction');
const { parseArgs, run } = require('../../src/scripts/extraction-backlog');
const { logger } = require('../../src/utils/logger');
const { loadIndex } = require('../helpers/load-index');
const { setExtractionEnv, fakeQueueAndStore, queueable } = require('../extraction/fakes');

const NOW = new Date('2026-11-27T12:00:00.000Z');
const ACCOUNT = 'AzureWebJobsStorage__accountName';

function setAccount(t, value) {
  const saved = process.env[ACCOUNT];
  if (value === undefined) delete process.env[ACCOUNT];
  else process.env[ACCOUNT] = value;
  t.after(() => {
    if (saved === undefined) delete process.env[ACCOUNT];
    else process.env[ACCOUNT] = saved;
  });
}

test('a run asks for rows unsent for a week, capped at --max, and queues each', async (t) => {
  setExtractionEnv(t);
  setAccount(t, 'demifctest');
  const { sent } = fakeQueueAndStore(t);
  t.mock.method(logger, 'info', () => {});
  const list = t.mock.method(extractionRows, 'listExtractionBacklog',
    async () => [queueable({ id: 'a' }), queueable({ id: 'b' })]);

  assert.deepStrictEqual(await run({ max: 2, now: NOW }), { listed: 2, queued: 2 });
  assert.deepStrictEqual(list.mock.calls[0].arguments[0],
    { queuedBefore: '2026-11-20T12:00:00.000Z', max: 2 });
  assert.deepStrictEqual(sent.map(m => [m.documentId, m.reason]), [['a', 'backlog'], ['b', 'backlog']]);
});

test('a run with a setting unset rejects naming it and reads nothing', async (t) => {
  await t.test('EXTRACTION_QUEUE', async (t) => {
    setExtractionEnv(t, {});
    setAccount(t, 'demifctest');
    const list = t.mock.method(extractionRows, 'listExtractionBacklog', async () => []);

    await assert.rejects(run({ max: 2, now: NOW }), /EXTRACTION_QUEUE is not set/);
    assert.strictEqual(list.mock.calls.length, 0);
  });
  await t.test(ACCOUNT, async (t) => {
    setExtractionEnv(t);
    setAccount(t, undefined);
    const list = t.mock.method(extractionRows, 'listExtractionBacklog', async () => []);

    await assert.rejects(run({ max: 2, now: NOW }), /AzureWebJobsStorage__accountName is not set/);
    assert.strictEqual(list.mock.calls.length, 0);
  });
});

test('a run where a send fails rejects, naming how many of the listed rows were queued', async (t) => {
  setExtractionEnv(t);
  setAccount(t, 'demifctest');
  fakeQueueAndStore(t, { failSendFor: 'b' });
  t.mock.method(logger, 'info', () => {});
  t.mock.method(logger, 'warn', () => {});
  t.mock.method(extractionRows, 'listExtractionBacklog',
    async () => [queueable({ id: 'a' }), queueable({ id: 'b' })]);

  await assert.rejects(run({ max: 2, now: NOW }), /1 of 2 queued/);
});

test('--max is required and must be an integer from 1 to 500', async (t) => {
  for (const argv of [[], ['--max', '0'], ['--max', '501'], ['--max', 'abc']]) {
    await t.test(argv.join(' ') || 'no arguments', () => {
      assert.throws(() => parseArgs(argv), /usage: .*--max <1-500>/);
    });
  }
  assert.strictEqual(parseArgs(['--max', '1']).max, 1);
  assert.strictEqual(parseArgs(['--max', '500']).max, 500);
});

test('EXTRACTION_QUEUE registers no extraction timer', (t) => {
  setExtractionEnv(t);
  const { registered } = loadIndex(t);
  assert.deepStrictEqual(registered.timers.filter(r => /extraction/i.test(r.name)), []);
});
