'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const extractionRows = require('../../src/repositories/documents-extraction');
const backlog = require('../../src/extraction/backlog');
const { logger } = require('../../src/utils/logger');
const { loadIndex } = require('../helpers/load-index');
const { QUEUE, setExtractionEnv, fakeQueueAndStore, queueable } = require('./fakes');

const NOW = new Date('2026-11-27T12:00:00.000Z');

test('the sweep asks for rows unsent for a week, capped at EXTRACTION_SWEEP_MAX, and queues each', async (t) => {
  setExtractionEnv(t, { EXTRACTION_QUEUE: QUEUE, EXTRACTION_SWEEP_MAX: '2' });
  const { sent } = fakeQueueAndStore(t);
  t.mock.method(logger, 'info', () => {});
  const list = t.mock.method(extractionRows, 'listExtractionBacklog',
    async () => [queueable({ id: 'a' }), queueable({ id: 'b' })]);

  assert.deepStrictEqual(await backlog.sweep({ now: NOW }), { listed: 2, queued: 2 });
  assert.deepStrictEqual(list.mock.calls[0].arguments[0],
    { queuedBefore: '2026-11-20T12:00:00.000Z', max: 2 });
  assert.deepStrictEqual(sent.map(m => [m.documentId, m.reason]), [['a', 'backlog'], ['b', 'backlog']]);
});

test('the sweep reads nothing with EXTRACTION_QUEUE unset', async (t) => {
  setExtractionEnv(t, {});
  const list = t.mock.method(extractionRows, 'listExtractionBacklog', async () => []);

  assert.deepStrictEqual(await backlog.sweep({ now: NOW }), { listed: 0, queued: 0 });
  assert.strictEqual(list.mock.calls.length, 0);
});

test('no EXTRACTION_QUEUE registers no backlog timer', (t) => {
  setExtractionEnv(t, {});
  const { registered } = loadIndex(t);
  assert.deepStrictEqual(registered.timers.filter(r => r.name === 'extractionBacklogSweep'), []);
});

test('EXTRACTION_QUEUE registers the daily backlog timer, not on startup; the schedule setting overrides it', async (t) => {
  await t.test('default', (t) => {
    setExtractionEnv(t);
    const { registered, index } = loadIndex(t);
    const timer = registered.timers.find(r => r.name === 'extractionBacklogSweep');
    assert.strictEqual(timer.options.schedule, '0 0 11 * * *');
    assert.strictEqual(timer.options.runOnStartup, false);
    assert.strictEqual(timer.options.handler, index.extractionBacklogSweep);
  });
  await t.test('EXTRACTION_SWEEP_SCHEDULE', (t) => {
    setExtractionEnv(t, { EXTRACTION_QUEUE: QUEUE, EXTRACTION_SWEEP_SCHEDULE: '0 0 */6 * * *' });
    const { registered } = loadIndex(t);
    assert.strictEqual(registered.timers.find(r => r.name === 'extractionBacklogSweep').options.schedule,
      '0 0 */6 * * *');
  });
});

test('a failed sweep run is logged, not thrown, so the host does not count the timer failed', async (t) => {
  setExtractionEnv(t);
  const { index } = loadIndex(t);
  t.mock.method(extractionRows, 'listExtractionBacklog', async () => { throw new Error('cosmos down'); });
  const error = t.mock.method(logger, 'error', () => {});

  await index.extractionBacklogSweep();
  assert.strictEqual(error.mock.calls[0].arguments[0], '[extraction] backlog sweep failed');
});
