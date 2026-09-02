'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  parseArgs, planPatch, backfillDisplayNameSort, exitCodeFor
} = require('../../src/scripts/backfill-display-name-sort');

const NOW = '2026-09-02T00:00:00.000Z';

/**
 * Documents repository double, partitioned by `projectId` the way Cosmos is.
 *
 * `countVisible` answers over ALL partitions while `listVisible` answers one, which is what makes
 * the coverage check falsifiable: a partition nobody asked for shows up as a shortfall.
 */
function fakeDocuments(docs, opts = {}) {
  const state = { listedPartitions: [] };
  return {
    state,
    CONTAINER: 'documents',
    async listVisible(access, listOpts) {
      const partition = String(listOpts.projectId ?? '');
      state.listedPartitions.push(partition);
      return { items: docs.filter(d => String(d.projectId ?? '') === partition) };
    },
    async countVisible() {
      return opts.count === undefined ? docs.length : opts.count;
    }
  };
}

const fakeProjects = (ids) => ({ async listVisible() { return { items: ids.map(id => ({ id })) }; } });

function fakeWriter(opts = {}) {
  const state = { operations: [] };
  const write = async (operations) => {
    state.operations.push(...operations);
    const failed = opts.failAll ? operations.length : 0;
    return {
      succeeded: operations.length - failed,
      failed,
      statusCounts: failed ? { 429: failed } : { 200: operations.length },
      requestCharge: operations.length
    };
  };
  return { state, write };
}

const DOCS = [
  { id: 'd1', projectId: '207', displayName: 'Appendix 2' },
  { id: 'd2', projectId: '207', displayName: 'Appendix 10' },
  // Already agrees: a re-run must not pay to rewrite it.
  { id: 'd3', projectId: '311', displayName: 'Item 1', displayNameSort: 'item 000000000001' },
  // The unlinked partition, which is a real partition and not a guard.
  { id: 'd4', projectId: '', displayName: 'Orphan Report' }
];

const run = (argv, docs = DOCS, opts = {}) => {
  const documents = fakeDocuments(docs, opts);
  const projects = fakeProjects(['207', '311']);
  const writer = fakeWriter(opts);
  return backfillDisplayNameSort(argv, {
    documents, projects, bulkVerified: writer.write, now: NOW
  }).then(summary => ({ summary, documents, writer }));
};

test('backfill-display-name-sort arguments', async (t) => {
  await t.test('dry run by default, --live is the mutating flag', () => {
    assert.strictEqual(parseArgs([]).live, false);
    assert.strictEqual(parseArgs(['--dry-run']).live, false);
    assert.strictEqual(parseArgs(['--live']).live, true);
  });

  await t.test('an unknown argument is refused, never ignored', () => {
    assert.throws(() => parseArgs(['--all']), /unknown argument/);
  });
});

test('planPatch', async (t) => {
  await t.test('a row with no key gets one', () => {
    const ops = planPatch({ displayName: 'Appendix 2' }, NOW);
    assert.deepStrictEqual(ops[0], {
      op: 'set', path: '/displayNameSort', value: 'appendix 000000000002'
    });
    assert.deepStrictEqual(ops[1], { op: 'set', path: '/updatedAt', value: NOW });
  });

  await t.test('a row that already agrees is left alone', () => {
    assert.strictEqual(
      planPatch({ displayName: 'Appendix 2', displayNameSort: 'appendix 000000000002' }, NOW),
      null);
  });

  await t.test('an untitled row settles on the empty key and stays settled', () => {
    // Otherwise every run rewrites these rows: `undefined` and `''` would compare as different.
    assert.notStrictEqual(planPatch({ displayName: '' }, NOW), null, 'the first run writes it');
    assert.strictEqual(planPatch({ displayName: '', displayNameSort: '' }, NOW), null);
  });
});

test('backfillDisplayNameSort', async (t) => {
  await t.test('a dry run plans the work and writes nothing', async () => {
    const { summary, writer } = await run([]);

    assert.strictEqual(summary.mode, 'dry-run');
    assert.strictEqual(summary.scanned, 4);
    assert.strictEqual(summary.planned, 3);
    assert.strictEqual(summary.current, 1, 'the row that already agrees is not planned');
    assert.deepStrictEqual(writer.state.operations, [], 'nothing is written without --live');
  });

  await t.test('a live run patches only the rows that need it', async () => {
    const { summary, writer } = await run(['--live']);

    assert.strictEqual(summary.patched, 3);
    assert.strictEqual(summary.failed, 0);
    // Partition order: the unlinked one is walked first, then each project's.
    assert.deepStrictEqual(writer.state.operations.map(o => o.id), ['d4', 'd1', 'd2']);

    const appendix10 = writer.state.operations.find(o => o.id === 'd2');
    assert.deepStrictEqual(appendix10.resourceBody.operations[0],
      { op: 'set', path: '/displayNameSort', value: 'appendix 000000000010' });
    assert.strictEqual(appendix10.partitionKey, '207',
      'a bulk request cannot span partitions, so the key must be the row\'s own');
  });

  await t.test('the unlinked partition is walked, not skipped as falsy', async () => {
    const { documents, writer } = await run(['--live']);

    assert.ok(documents.state.listedPartitions.includes(''));
    assert.ok(writer.state.operations.some(o => o.id === 'd4' && o.partitionKey === ''));
  });

  await t.test('a second run over patched rows plans nothing', async () => {
    const patched = DOCS.map(d => ({ ...d, displayNameSort: d.displayNameSort ?? planned(d) }));
    const { summary, writer } = await run(['--live'], patched);

    assert.strictEqual(summary.planned, 0);
    assert.strictEqual(summary.current, 4);
    assert.deepStrictEqual(writer.state.operations, []);
  });

  await t.test('a walk that misses a partition is reported and exits non-zero', async () => {
    // The failure this counter exists for: 4 of 6 patched, and every other number looks healthy.
    const { summary } = await run(['--live'], DOCS, { count: 6 });

    assert.strictEqual(summary.scanned, 4);
    assert.strictEqual(summary.expected, 6);
    assert.strictEqual(exitCodeFor(summary), 1, 'a partial run must not exit 0');
  });

  await t.test('a rejected write exits non-zero', async () => {
    const { summary } = await run(['--live'], DOCS, { failAll: true });

    assert.strictEqual(summary.failed, 3);
    assert.strictEqual(exitCodeFor(summary), 1);
  });

  await t.test('a complete run exits 0', async () => {
    const { summary } = await run(['--live']);
    assert.strictEqual(exitCodeFor(summary), 0);
  });
});

/** What the script should have written for a row, computed the way the row's writers do. */
function planned(doc) {
  return require('../../src/helpers/natural-sort').naturalSortKey(doc.displayName);
}
