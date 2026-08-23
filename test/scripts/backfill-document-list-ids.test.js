'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  parseArgs, listFieldsFor, planPatch, backfill, DEFAULT_BATCH
} = require('../../src/scripts/backfill-document-list-ids');

const NOW = '2026-08-22T00:00:00.000Z';

const LIST = new Map([
  ['5cf00c03a266b7e1877504da', 'Letter'],
  ['5cf00c03a266b7e1877504dc', 'Proponent / Certificate Holder']
]);

/**
 * Documents repository double, partitioned by `projectId` the way Cosmos is.
 *
 * `countVisible` answers over ALL partitions while `listVisible` answers one — which is what makes
 * the coverage check falsifiable: a partition the caller never asks for shows up as a shortfall.
 * `opts.count` lets a test hand back a total larger than what it will serve, standing in for the
 * real failure this replaced (a cross-partition read that silently stops after one page).
 */
function fakeDocuments(docs, opts = {}) {
  const state = { listCalls: [] };
  return {
    state,
    CONTAINER: 'documents',
    async listVisible(access, listOpts) {
      state.listCalls.push(listOpts);
      const partition = String(listOpts.projectId ?? '');
      return { items: docs.filter(d => String(d.projectId ?? '') === partition) };
    },
    async countVisible() {
      return opts.count === undefined ? docs.length : opts.count;
    }
  };
}

/** Projects repository double — only the ids matter; they are the partitions to walk. */
function fakeProjects(ids) {
  return { async listVisible() { return { items: ids.map(id => ({ id })) }; } };
}

/** Stands in for `src/seed/sources.js` — the eagle-api reads, which are the only network here. */
function fakeSources(eagleDocs) {
  return {
    async fetchListLookup() { return LIST; },
    async streamEagleDocuments(onPage) {
      // Two pages, so a caller that only handles the first is caught.
      const half = Math.ceil(eagleDocs.length / 2) || 1;
      await onPage(eagleDocs.slice(0, half));
      await onPage(eagleDocs.slice(half));
      return { count: eagleDocs.length, total: eagleDocs.length };
    }
  };
}

function fakeWriter(opts = {}) {
  const state = { calls: [] };
  const write = async (operations) => {
    state.calls.push(operations);
    const failed = opts.failAll ? operations.length : 0;
    return {
      succeeded: operations.length - failed,
      failed,
      statusCounts: failed ? { 429: failed } : { 200: operations.length },
      requestCharge: operations.length * 10
    };
  };
  return { state, write };
}

const EAGLE = [
  {
    _id: 'doc1',
    type: '5cf00c03a266b7e1877504da',
    milestone: '5cf00c03a266b7e1877504e9',
    projectPhase: '5d3f6c7eda7a38421829602f',
    documentAuthorType: '5cf00c03a266b7e1877504dc'
  },
  { _id: 'doc2', type: '5cf00c03a266b7e1877504da' },
  { _id: 'doc3', type: '5cf00c03a266b7e1877504da' }
];

/** Rows as the seed left them: labels, no ids. */
const SEEDED = [
  { id: 'doc1', projectId: '207', type: 'Letter' },
  { id: 'doc2', projectId: '207', type: 'Letter' },
  { id: 'doc3', projectId: '311', type: 'Letter' }
];

test('parseArgs', async (t) => {
  await t.test('dry run by default, batch at the Cosmos hard limit', () => {
    const args = parseArgs([]);
    assert.strictEqual(args.live, false);
    assert.strictEqual(args.batch, DEFAULT_BATCH);
    assert.strictEqual(DEFAULT_BATCH, 100, 'the SDK rejects a larger bulk request outright');
  });

  await t.test('--batch is bounded above, not merely validated as a number', () => {
    assert.strictEqual(parseArgs(['--batch', '50']).batch, 50);
    assert.throws(() => parseArgs(['--batch', '101']), /between 1 and 100/);
    assert.throws(() => parseArgs(['--batch', '0']), /between 1 and 100/);
    // Bounded above as well as below: _sql.pageOptions clamps at 1000, so a larger value would be
    // accepted, ignored, and then reported in the summary as the size that actually ran.
    assert.throws(() => parseArgs(['--page-size', 'x']), /between 1 and 1000/);
    assert.throws(() => parseArgs(['--page-size', '5000']), /between 1 and 1000/);
    assert.strictEqual(parseArgs(['--page-size', '1000']).pageSize, 1000);
    assert.throws(() => parseArgs(['--wat']), /unknown argument/);
  });
});

test('listFieldsFor — the five fields, from the raw eagle payload', () => {
  assert.deepStrictEqual(listFieldsFor(EAGLE[0], LIST), {
    typeId: '5cf00c03a266b7e1877504da',
    milestoneId: '5cf00c03a266b7e1877504e9',
    projectPhaseId: '5d3f6c7eda7a38421829602f',
    documentAuthorType: 'Proponent / Certificate Holder',
    documentAuthorTypeId: '5cf00c03a266b7e1877504dc'
  });
  assert.deepStrictEqual(listFieldsFor(EAGLE[1], LIST), {
    typeId: '5cf00c03a266b7e1877504da',
    milestoneId: null,
    projectPhaseId: null,
    documentAuthorType: null,
    documentAuthorTypeId: null
  });
});

test('planPatch', async (t) => {
  await t.test('a row with no such property and nothing to write is NOT patched', () => {
    // The trap this exists for: the seeded row has no `typeId` key at all and the upstream value
    // is null. Treating undefined and null as different would rewrite all ~60,578 rows with a
    // page of nulls and pay full RU to change nothing.
    const fields = { typeId: null, milestoneId: null, projectPhaseId: null, documentAuthorType: null, documentAuthorTypeId: null };
    assert.strictEqual(planPatch({ id: 'doc9', projectId: '207' }, fields, NOW), null);
  });

  await t.test('only the fields that differ are written, plus updatedAt', () => {
    const ops = planPatch(
      { id: 'doc1', typeId: 'already-right' },
      { typeId: 'already-right', milestoneId: 'm1' },
      NOW);
    assert.deepStrictEqual(ops, [
      { op: 'set', path: '/milestoneId', value: 'm1' },
      { op: 'set', path: '/updatedAt', value: NOW }
    ]);
  });

  await t.test('an already-backfilled row is skipped, so a re-run is cheap', () => {
    const fields = listFieldsFor(EAGLE[0], LIST);
    assert.strictEqual(planPatch({ id: 'doc1', ...fields }, fields, NOW), null);
  });
});

test('backfill', async (t) => {
  await t.test('a dry run writes nothing and still counts what would change', async () => {
    const documents = fakeDocuments(SEEDED);
    const writer = fakeWriter();
    const summary = await backfill([], {
      documents, projects: fakeProjects(['207', '311']),
      sources: fakeSources(EAGLE), bulkVerified: writer.write, now: NOW
    });

    assert.deepStrictEqual(writer.state.calls, [], 'nothing written without --live');
    assert.strictEqual(summary.mode, 'dry-run');
    assert.strictEqual(summary.scanned, 3);
    assert.strictEqual(summary.planned, 3);
    assert.strictEqual(summary.patched, 0);
  });

  await t.test('live — one bulk request per partition, with the planned operations', async () => {
    const documents = fakeDocuments(SEEDED);
    const writer = fakeWriter();
    const summary = await backfill(['--live'], {
      documents, projects: fakeProjects(['207', '311']),
      sources: fakeSources(EAGLE), bulkVerified: writer.write, now: NOW
    });

    // Two projects, so two requests: a bulk request cannot span partition keys.
    assert.strictEqual(writer.state.calls.length, 2);
    const partitions = writer.state.calls.map(ops => ops[0].partitionKey);
    assert.deepStrictEqual(partitions.sort(), ['207', '311']);

    const first = writer.state.calls.find(ops => ops[0].partitionKey === '207');
    assert.strictEqual(first.length, 2, 'both documents of project 207 in one request');
    assert.strictEqual(first[0].operationType, 'Patch');
    assert.strictEqual(first[0].id, 'doc1');
    assert.deepStrictEqual(first[0].resourceBody.operations, [
      { op: 'set', path: '/typeId', value: '5cf00c03a266b7e1877504da' },
      { op: 'set', path: '/milestoneId', value: '5cf00c03a266b7e1877504e9' },
      { op: 'set', path: '/projectPhaseId', value: '5d3f6c7eda7a38421829602f' },
      { op: 'set', path: '/documentAuthorType', value: 'Proponent / Certificate Holder' },
      { op: 'set', path: '/documentAuthorTypeId', value: '5cf00c03a266b7e1877504dc' },
      { op: 'set', path: '/updatedAt', value: NOW }
    ]);
    assert.strictEqual(summary.patched, 3);
    assert.strictEqual(summary.failed, 0);
    assert.strictEqual(summary.requestCharge, 30, 'RU is summed across every request');
  });

  await t.test('--batch flushes a busy partition rather than accumulating it', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `d${i}`, projectId: '207' }));
    const eagle = many.map(d => ({ _id: d.id, type: '5cf00c03a266b7e1877504da' }));
    const writer = fakeWriter();
    await backfill(['--live', '--batch', '2', '--page-size', '10'], {
      documents: fakeDocuments(many), projects: fakeProjects(['207']),
      sources: fakeSources(eagle), bulkVerified: writer.write, now: NOW
    });
    assert.deepStrictEqual(writer.state.calls.map(c => c.length), [2, 2, 1],
      'flushed at the batch size, with the remainder at the end');
  });

  // REPLACED the continuation-token test 2026-08-22. Measured against demi-cosmos-test: the
  // cross-partition `ORDER BY c.id ASC` read returns its FIRST page with no continuation token, so
  // the loop that test pinned stopped after 200 of 60,578 rows and reported success. The script
  // now walks one partition at a time and checks its own coverage instead.
  await t.test('every partition is walked, including the unlinked one', async () => {
    const documents = fakeDocuments([...SEEDED, { id: 'orphan', projectId: '' }]);
    const writer = fakeWriter();
    const summary = await backfill([], {
      documents, projects: fakeProjects(['207', '311']),
      sources: fakeSources([...EAGLE, { _id: 'orphan', type: '5cf00c03a266b7e1877504da' }]),
      bulkVerified: writer.write, now: NOW
    });
    assert.strictEqual(summary.scanned, 4, 'the projectId-less partition is a partition too');
    assert.deepStrictEqual(
      documents.state.listCalls.map(c => String(c.projectId)), ['', '207', '311']);
    assert.strictEqual(documents.state.listCalls[0].sourceSystem, 'eagle',
      'epic.submit documents have no eagle payload to backfill from');
  });

  // The failure that got past a green test run once already: a partial pass that reports success.
  // Nobody re-runs a script that said it was done.
  await t.test('a short run is reported as INCOMPLETE against the counted total', async () => {
    const lines = [];
    const log = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try {
      const summary = await backfill([], {
        documents: fakeDocuments(SEEDED, { count: 60578 }),
        projects: fakeProjects(['207', '311']),
        sources: fakeSources(EAGLE), bulkVerified: fakeWriter().write, now: NOW
      });
      assert.strictEqual(summary.scanned, 3);
      assert.strictEqual(summary.expected, 60578);
    } finally {
      console.log = log;
    }
    assert.match(lines.join('\n'), /INCOMPLETE: scanned 3 of 60578/);
  });

  await t.test('a row absent from eagle is counted, not guessed at', async () => {
    const documents = fakeDocuments([...SEEDED, { id: 'submitted-1', projectId: '207' }]);
    const writer = fakeWriter();
    const summary = await backfill([], {
      documents, projects: fakeProjects(['207', '311']),
      sources: fakeSources(EAGLE), bulkVerified: writer.write, now: NOW
    });
    assert.strictEqual(summary.unmatched, 1);
    assert.strictEqual(summary.planned, 3, 'the unmatched row is not planned as a page of nulls');
  });

  await t.test('a rejected batch is reported, and the run exits non-zero on it', async () => {
    const writer = fakeWriter({ failAll: true });
    const summary = await backfill(['--live'], {
      documents: fakeDocuments(SEEDED), projects: fakeProjects(['207', '311']),
      sources: fakeSources(EAGLE), bulkVerified: writer.write, now: NOW
    });
    assert.strictEqual(summary.patched, 0);
    assert.strictEqual(summary.failed, 3);
    assert.deepStrictEqual(summary.statusCounts, { 429: 3 }, 'summed across both requests');
  });
});
