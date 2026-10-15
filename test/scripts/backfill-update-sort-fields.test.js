'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { logger } = require('../../src/utils/logger');
const { updatesStore } = require('../helpers/updates-store');
const script = () => require('../../src/scripts/backfill-update-sort-fields');

const PUSHED = { pinned: false, complianceAndEnforcement: false, status: 'published' };
const rows = () => [
  // Written before the mirror filled any of the three; Eagle's own flags kept in sources.eagle.
  { id: 'old', sources: { eagle: { pinned: true, complianceAndEnforcement: true } } },
  { id: 'bare' },
  { id: 'partial', pinned: false, status: 'published', sources: { eagle: { complianceAndEnforcement: true } } },
  // A stored null is a value: an ORDER BY keeps it.
  { id: 'nulled', pinned: null, complianceAndEnforcement: false, status: null },
  { id: 'full', ...PUSHED }
];

test('backfill-update-sort-fields', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.beforeEach(() => t.mock.method(logger, 'info', () => {}));

  await t.test('a dry run counts each missing field and writes nothing', async () => {
    const { patches } = updatesStore(t, rows(), { pageSize: 1 });

    const summary = await script().backfillUpdateSortFields([]);

    assert.strictEqual(summary.mode, 'dry-run');
    assert.strictEqual(summary.changed, 3);
    assert.deepStrictEqual(summary.fields, { pinned: 2, complianceAndEnforcement: 3, status: 2 });
    assert.deepStrictEqual(patches, []);
    assert.match(logger.info.mock.calls.at(-1).arguments[0],
      /mode=dry-run changed=3 patched=0 raced=0 failed=0 missing: pinned=2 complianceAndEnforcement=3 status=2/);
  });

  await t.test('--live fills only the missing fields, from sources.eagle else false and null', async () => {
    const { row, patches } = updatesStore(t, rows());

    const summary = await script().backfillUpdateSortFields(['--live']);

    assert.strictEqual(summary.patched, 3);
    assert.deepStrictEqual([row('old').pinned, row('old').complianceAndEnforcement, row('old').status], [true, true, null]);
    assert.deepStrictEqual([row('bare').pinned, row('bare').complianceAndEnforcement, row('bare').status], [false, false, null]);
    assert.deepStrictEqual(patches.find(p => p.id === 'partial').operations,
      [{ op: 'set', path: '/complianceAndEnforcement', value: true }]);
    assert.deepStrictEqual(patches.map(p => p.id).sort(), ['bare', 'old', 'partial']);
  });

  await t.test('a push that wrote the row first wins', async () => {
    const { row } = updatesStore(t, rows(), {
      onQuery: (store) => store.set('old', { ...store.get('old'), ...PUSHED })
    });

    const summary = await script().backfillUpdateSortFields(['--live']);

    assert.strictEqual(summary.raced, 1);
    assert.strictEqual(row('old').pinned, false);
    assert.strictEqual(row('old').status, 'published');
  });

  await t.test('a failed patch is counted and exits 1', async () => {
    t.mock.method(logger, 'error', () => {});
    const updates = {
      listMissingSortFields: async () => ({ items: [{ id: 'bare' }] }),
      fillSortFields: async () => { throw new Error('Cosmos is down'); }
    };

    const summary = await script().backfillUpdateSortFields(['--live'], { updates });

    assert.strictEqual(summary.failed, 1);
    assert.strictEqual(script().exitCodeFor(summary), 1);
    assert.strictEqual(script().exitCodeFor({ ...summary, failed: 0 }), 0);
  });

  await t.test('an unknown argument is refused', () => {
    assert.throws(() => script().parseArgs(['--dry']), /unknown argument: --dry/);
  });
});
