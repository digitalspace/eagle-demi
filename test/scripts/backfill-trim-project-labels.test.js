'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  backfillTrimProjectLabels, exitCodeFor, parseArgs
} = require('../../src/scripts/backfill-trim-project-labels');

const ROWS = [
  { id: '207', sector: 'Groundwater Extraction ', projectSubType: ' Dams' },
  { id: '208', sector: 'Mining', projectSubType: 'Coal Mines' },
  { id: '209', sector: null, projectSubType: 'Power Plants  ' },
  { id: '210' }
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

test('backfillTrimProjectLabels', async (t) => {
  await t.test('dry run is the default, counts the rows that would change, writes nothing', async () => {
    const patch = fakePatch();
    const summary = await backfillTrimProjectLabels([], { projects: fakeProjects(ROWS), patch: patch.fn });

    assert.strictEqual(summary.mode, 'dry-run');
    assert.strictEqual(summary.total, 4);
    assert.strictEqual(summary.changed, 2);
    assert.strictEqual(summary.patched, 0);
    assert.strictEqual(patch.calls.length, 0, 'a dry run must not patch');
  });

  await t.test('--live sets only the fields that change, trimmed', async () => {
    const patch = fakePatch();
    const summary = await backfillTrimProjectLabels(['--live'],
      { projects: fakeProjects(ROWS), patch: patch.fn });

    assert.strictEqual(summary.patched, 2);
    assert.deepStrictEqual(patch.calls, [
      { id: '207', ops: [
        { op: 'set', path: '/sector', value: 'Groundwater Extraction' },
        { op: 'set', path: '/projectSubType', value: 'Dams' }
      ] },
      { id: '209', ops: [{ op: 'set', path: '/projectSubType', value: 'Power Plants' }] }
    ]);
  });

  await t.test('--live removes a whitespace-only label instead of writing an empty string', async () => {
    const patch = fakePatch();
    await backfillTrimProjectLabels(['--live'],
      { projects: fakeProjects([{ id: '211', sector: '   ', projectSubType: 'Dams ' }]), patch: patch.fn });

    assert.deepStrictEqual(patch.calls, [
      { id: '211', ops: [
        { op: 'remove', path: '/sector' },
        { op: 'set', path: '/projectSubType', value: 'Dams' }
      ] }
    ]);
  });

  await t.test('a failed patch is counted and exits 1; the rest still run', async () => {
    const patch = fakePatch(['207']);
    const summary = await backfillTrimProjectLabels(['--live'],
      { projects: fakeProjects(ROWS), patch: patch.fn });

    assert.strictEqual(summary.failed, 1);
    assert.strictEqual(summary.patched, 1);
    assert.strictEqual(exitCodeFor(summary), 1);
  });

  await t.test('an unknown argument throws rather than running live or dry by guess', () => {
    assert.throws(() => parseArgs(['--dry']), /unknown argument/);
  });
});
