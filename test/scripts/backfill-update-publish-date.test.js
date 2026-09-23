'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { logger } = require('../../src/utils/logger');
const { updatesStore } = require('../helpers/updates-store');
// Required per call, not at load: a load-time throw lands in the logger's uncaughtException handler
// and node --test then reports the file as passing.
const script = () => require('../../src/scripts/backfill-update-publish-date');

const ADDED = '2026-01-01T00:00:00.000Z';
const rows = () => [
  { id: 'absent', dateAdded: ADDED },
  { id: 'nulled', dateAdded: ADDED, publishDate: null },
  { id: 'dated', dateAdded: ADDED, publishDate: '2026-02-01T00:00:00.000Z' },
  { id: 'bare' }
];

test('backfill-update-publish-date', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.beforeEach(() => t.mock.method(logger, 'info', () => {}));

  await t.test('a dry run counts the undated rows and writes nothing', async () => {
    const { patches } = updatesStore(t, rows(), { pageSize: 1 });

    const summary = await script().backfillUpdatePublishDate([]);

    assert.deepStrictEqual(summary, { mode: 'dry-run', undated: 3, patched: 0, raced: 0, noDate: 1, failed: 0 });
    assert.deepStrictEqual(patches, []);
  });

  await t.test('--live sets publishDate to dateAdded on undated rows only', async () => {
    const { row } = updatesStore(t, rows());

    const summary = await script().backfillUpdatePublishDate(['--live']);

    assert.deepStrictEqual(summary, { mode: 'live', undated: 3, patched: 2, raced: 0, noDate: 1, failed: 0 });
    assert.strictEqual(row('absent').publishDate, ADDED);
    assert.strictEqual(row('nulled').publishDate, ADDED);
    assert.strictEqual(row('dated').publishDate, '2026-02-01T00:00:00.000Z');
    assert.strictEqual(row('bare').publishDate, undefined);
  });

  await t.test('a push that filled the row first wins', async () => {
    const { row } = updatesStore(t, rows(), {
      onQuery: (store) => store.set('absent', { ...store.get('absent'), publishDate: '2026-03-01T00:00:00.000Z' })
    });

    const summary = await script().backfillUpdatePublishDate(['--live']);

    assert.strictEqual(summary.raced, 1);
    assert.strictEqual(row('absent').publishDate, '2026-03-01T00:00:00.000Z');
  });

  await t.test('a failed patch is counted and exits 1', async () => {
    t.mock.method(logger, 'error', () => {});
    const updates = {
      listUndated: async () => ({ items: [{ id: 'absent', dateAdded: ADDED }] }),
      fillPublishDate: async () => { throw new Error('Cosmos is down'); }
    };

    const summary = await script().backfillUpdatePublishDate(['--live'], { updates });

    assert.strictEqual(summary.failed, 1);
    assert.strictEqual(script().exitCodeFor(summary), 1);
    assert.strictEqual(script().exitCodeFor({ ...summary, failed: 0 }), 0);
  });

  await t.test('an unknown argument is refused', () => {
    assert.throws(() => script().parseArgs(['--dry']), /unknown argument: --dry/);
  });
});
