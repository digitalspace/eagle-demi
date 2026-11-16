'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../../src/config');
const mines = require('../../src/repositories/mines');
const records = require('../../src/repositories/regulatory-records');
const projectNrpti = require('../../src/repositories/project-nrpti');
const { run, PAGE_SIZE } = require('../../src/scripts/sync-nrpti');

const order = (id, extra = {}) => ({
  _id: id, _epicProjectId: 'e1', recordName: `Order ${id}`, sourceSystemRef: 'nrced', ...extra
});
const mine = { _id: 'm1', _sourceRefId: 'g1', _epicProjectIds: ['e1'], name: 'Mine One', status: 'Operating', commodities: ['Coal'] };

const page = (rows) => ({ ok: true, status: 200, json: async () => [{ searchResults: rows, meta: [] }] });

test('sync-nrpti', async (t) => {
  const savedSources = config.enrichmentSources;
  t.afterEach(() => {
    t.mock.restoreAll();
    config.enrichmentSources = savedSources;
  });

  /**
   * NRPTI serves `pages[dataset]` (one array per page, empty when absent); e1 links to p1; `withSummary`
   * already hold sources.nrpti. Returns the fetched URLs and every write.
   */
  function wire({ pages = {}, withSummary = [], enabled = true } = {}) {
    config.enrichmentSources = enabled ? ['wildfire', 'nrpti'] : ['wildfire'];
    const seen = { urls: [], mines: [], records: [], patched: new Map(), removed: [] };
    t.mock.method(globalThis, 'fetch', async (url) => {
      seen.urls.push(url);
      const params = new URL(url).searchParams;
      const datasetPages = pages[params.get('dataset')] || [];
      const pageNum = Number(params.get('pageNum'));
      return typeof datasetPages[pageNum] === 'function' ? datasetPages[pageNum]() : page(datasetPages[pageNum] || []);
    });
    t.mock.method(projectNrpti, 'eagleIdMap', async () => new Map([['e1', 'p1']]));
    t.mock.method(projectNrpti, 'listIdsWithSummary', async () => withSummary);
    t.mock.method(projectNrpti, 'patchSummary', async (id, summary) => { seen.patched.set(id, summary); });
    t.mock.method(projectNrpti, 'removeSummary', async (id) => { seen.removed.push(id); });
    t.mock.method(mines, 'upsert', async (row) => { seen.mines.push(row); });
    t.mock.method(records, 'upsert', async (row) => { seen.records.push(row); });
    return seen;
  }

  const writes = (seen) => seen.mines.length + seen.records.length + seen.patched.size + seen.removed.length;

  await t.test('a dry run counts links and stale summaries but writes nothing', async () => {
    const seen = wire({ pages: { MineBCMI: [[mine]], Order: [[order('o1')]] }, withSummary: ['gone'] });

    const summary = await run();

    assert.strictEqual(summary.result, 'dry');
    assert.strictEqual(summary.linked, 2);
    assert.strictEqual(summary.staleSummaries, 1);
    assert.strictEqual(writes(seen), 0);
  });

  await t.test('a live run while nrpti is not enabled writes nothing', async () => {
    const seen = wire({ pages: { Order: [[order('o1')]] }, withSummary: ['gone'], enabled: false });

    const summary = await run({ live: true });

    assert.strictEqual(summary.result, 'skipped:disabled');
    assert.strictEqual(writes(seen), 0);
  });

  await t.test('a live run upserts linked rows and sets each linked project\'s summary', async () => {
    const seen = wire({
      pages: { MineBCMI: [[mine]], Order: [[order('o1', { dateIssued: '2020-01-02T00:00:00.000Z' }), order('o2', { _epicProjectId: 'nope' })]] }
    });

    const summary = await run({ live: true });

    assert.strictEqual(summary.result, 'written');
    assert.deepStrictEqual(seen.mines.map(r => r.id), ['g1:p1']);
    assert.deepStrictEqual(seen.records.map(r => r.id), ['nrpti-o1']);
    assert.deepStrictEqual(summary.datasets.Order.reasons.unknownEpicId, 1);
    assert.deepStrictEqual(seen.patched.get('p1').recordCounts, { order: 1 });
    assert.deepStrictEqual(seen.patched.get('p1').mines.map(m => m.mineId), ['g1']);
    assert.strictEqual(seen.patched.get('p1').lastRecordDate, '2020-01-02T00:00:00.000Z');
  });

  await t.test('a live run removes the summary of a project no longer linked, and keeps the linked one', async () => {
    const seen = wire({ pages: { Order: [[order('o1')]] }, withSummary: ['p1', 'gone'] });

    const summary = await run({ live: true });

    assert.deepStrictEqual(seen.removed, ['gone']);
    assert.strictEqual(summary.cleared, 1);
  });

  await t.test('a full page is followed by the next, and a short page ends the dataset', async () => {
    const full = Array.from({ length: PAGE_SIZE }, (_, i) => order(`a${i}`));
    const seen = wire({ pages: { Inspection: [full, [order('b1')], [order('never')]] } });

    const summary = await run();

    const inspectionUrls = seen.urls.filter(u => u.includes('dataset=Inspection'));
    assert.deepStrictEqual(inspectionUrls.map(u => new URL(u).searchParams.get('pageNum')), ['0', '1']);
    assert.strictEqual(summary.datasets.Inspection.fetched, PAGE_SIZE + 1);
  });

  await t.test('records are fetched populated, so their documents come inline', async () => {
    const seen = wire();

    await run();

    const orderUrl = seen.urls.find(u => u.includes('dataset=Order'));
    assert.strictEqual(new URL(orderUrl).searchParams.get('populate'), 'true');
  });

  await t.test('a failed page aborts the run before any write, patch or clear', async () => {
    const seen = wire({
      pages: { MineBCMI: [[mine]], Order: [[order('o1')]], Permit: [() => ({ ok: false, status: 502, json: async () => ({}) })] },
      withSummary: ['gone']
    });

    await assert.rejects(run({ live: true }), /Permit page 0: HTTP 502/);
    assert.strictEqual(writes(seen), 0);
  });

  await t.test('--clear-only removes every summary, even with nrpti disabled, and neither fetches nor writes rows', async () => {
    const seen = wire({ pages: { Order: [[order('o1')]] }, withSummary: ['p1', 'gone'], enabled: false });

    const summary = await run({ live: true, clearOnly: true });

    assert.strictEqual(summary.mode, 'clear-only');
    assert.deepStrictEqual(seen.removed, ['p1', 'gone']);
    assert.strictEqual(seen.urls.length, 0);
    assert.strictEqual(seen.mines.length + seen.records.length + seen.patched.size, 0);
  });

  await t.test('--clear-only without --live removes nothing', async () => {
    const seen = wire({ withSummary: ['gone'] });

    const summary = await run({ clearOnly: true });

    assert.strictEqual(summary.staleSummaries, 1);
    assert.deepStrictEqual(seen.removed, []);
  });
});
