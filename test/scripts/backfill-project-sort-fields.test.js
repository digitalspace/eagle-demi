'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  backfillProjectSortFields, exitCodeFor, parseArgs
} = require('../../src/scripts/backfill-project-sort-fields');

const FULL = {
  dateUpdated: '2026-01-02T03:04:05.000Z',
  proponentName: 'BC Hydro',
  projectType: 'Energy',
  sector: 'Dams',
  region: 'Peace',
  currentPhaseName: { _id: '5cf00c03a266b7e1877504e9', name: 'Post Decision' }
};

const ROWS = [
  { id: '207', ...FULL },
  { id: '208', ...FULL, dateUpdated: undefined, dateAdded: 'Tue Mar 05 2019 10:00:00 GMT-0800 (Pacific Standard Time)' },
  { id: '209', name: 'Track only', _ts: 1700000000 },
  { id: '210', ...FULL, sector: null, currentPhaseName: undefined }
];

/** Asserts the access tier: a scoped scan would skip every row it cannot read. */
function fakeProjects(rows) {
  return {
    CONTAINER: 'projects',
    async listVisible(access) {
      assert.strictEqual(access && access.tier, 'privileged',
        'the project scan must run as systemAccess(), or rows are skipped');
      return { items: rows };
    }
  };
}

function fakePatch(failIds = []) {
  const calls = [];
  return {
    calls,
    fn: async (id, ops) => {
      if (failIds.includes(id)) throw new Error('boom');
      calls.push({ id, ops });
    }
  };
}

test('backfillProjectSortFields', async (t) => {
  await t.test('dry run is the default, counts each missing field, writes nothing', async () => {
    const patch = fakePatch();
    const summary = await backfillProjectSortFields([], { projects: fakeProjects(ROWS), patch: patch.fn });

    assert.strictEqual(summary.mode, 'dry-run');
    assert.strictEqual(summary.total, 4);
    assert.strictEqual(summary.changed, 3);
    assert.strictEqual(summary.patched, 0);
    assert.deepStrictEqual(summary.fields, {
      dateUpdated: 2, proponentName: 1, projectType: 1, sector: 1, region: 1, currentPhaseName: 2
    });
    assert.strictEqual(patch.calls.length, 0, 'a dry run must not patch');
  });

  await t.test('--live sets only the absent fields, with the values upsert writes', async () => {
    const patch = fakePatch();
    const summary = await backfillProjectSortFields(['--live'],
      { projects: fakeProjects(ROWS), patch: patch.fn });

    assert.strictEqual(summary.patched, 3);
    assert.deepStrictEqual(patch.calls, [
      { id: '208', ops: [{ op: 'set', path: '/dateUpdated', value: '2019-03-05T18:00:00.000Z' }] },
      { id: '209', ops: [
        { op: 'set', path: '/dateUpdated', value: null },
        { op: 'set', path: '/proponentName', value: null },
        { op: 'set', path: '/projectType', value: null },
        { op: 'set', path: '/sector', value: null },
        { op: 'set', path: '/region', value: null },
        { op: 'set', path: '/currentPhaseName', value: { _id: null, name: null } }
      ] },
      { id: '210', ops: [{ op: 'set', path: '/currentPhaseName', value: { _id: null, name: null } }] }
    ]);
  });

  await t.test('a failed patch is counted and exits 1; the rest still run', async () => {
    const patch = fakePatch(['209']);
    const summary = await backfillProjectSortFields(['--live'],
      { projects: fakeProjects(ROWS), patch: patch.fn });

    assert.strictEqual(summary.failed, 1);
    assert.strictEqual(summary.patched, 2);
    assert.strictEqual(exitCodeFor(summary), 1);
  });

  await t.test('an unknown argument throws rather than running live or dry by guess', () => {
    assert.throws(() => parseArgs(['--dry']), /unknown argument/);
  });
});
