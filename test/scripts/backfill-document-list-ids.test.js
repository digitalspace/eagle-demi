'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  parseArgs, listFieldsFor, planPatch, backfill, exitCodeFor, DEFAULT_BATCH
} = require('../../src/scripts/backfill-document-list-ids');
const chunksRepo = require('../../src/repositories/chunks');
const documentsRepo = require('../../src/repositories/documents');

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
  // `cleared` records every clear attempted, in order: the argument list is the contract, since a
  // clear guarded on the wrong token is what would take a flag down over chunks nobody wrote.
  const state = { listCalls: [], cleared: [] };
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
    },
    // The REAL raise. A fake returning a constant would let a run that re-uses the token already
    // on the row pass, and that is the bug the strictly-greater rule exists for.
    pendingRaiseOps: documentsRepo.pendingRaiseOps,
    async setParentFieldsPending(id, projectId, pending, guard) {
      state.cleared.push({ id: String(id), projectId, pending, guard });
      return opts.clearOutcome || { status: 'cleared', pendingAt: null };
    }
  };
}

/** Every operation the writer was handed for one document id, flattened across batches. */
function opsFor(writer, id) {
  return writer.state.calls.flat()
    .filter(op => String(op.id) === id)
    .flatMap(op => op.resourceBody.operations);
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

/**
 * Chunks repository double. `parentFieldsChanged` and `reStampAfterWrite` are the REAL ones — the
 * decision to re-stamp and the two failure counters are only meaningful against what the repository
 * actually does, so only the Cosmos write is faked, through the helper's documented `stamp` seam.
 *
 * `opts.rejectChunksOf` names documents whose patch comes back with chunk operations REJECTED —
 * a document that landed in part, which is a different unit from a document that threw.
 */
function fakeChunks(opts = {}) {
  // `stampedAt` is the instant each partition's re-stamp was guarded on — the only thing that
  // keeps a slow partition from putting stale values back over a newer walk.
  const state = { patched: [], stampedAt: [] };
  const rejectChunksOf = new Set(opts.rejectChunksOf || []);
  return {
    state,
    parentFieldsChanged: chunksRepo.parentFieldsChanged,
    async setParentFieldsForDocument(access, documentId, document) {
      if (opts.throwAll) throw new Error('cosmos unavailable');
      state.patched.push({ id: String(documentId), typeId: document.typeId });
      if (rejectChunksOf.has(String(documentId))) {
        return { succeeded: 0, failed: 2, statusCounts: { 429: 2 }, requestCharge: 5, chunks: 2 };
      }
      return { succeeded: 2, failed: 0, statusCounts: { 200: 2 }, requestCharge: 5, chunks: 2 };
    },
    reStampAfterWrite(access, docs, failedIds, options) {
      if (docs.length) state.stampedAt.push(options.stampedAt);
      return chunksRepo.reStampAfterWrite(access, docs, failedIds, {
        ...options, stamp: this.setParentFieldsForDocument
      });
    }
  };
}

/**
 * `cosmos.bulkVerified` double. `failedIds` is part of its real return shape and is what lets the
 * caller re-stamp only the rows that landed, so the double has to carry it or the test cannot see
 * the difference.
 *
 * `opts.failIds` rejects named ids; `opts.failAll` rejects everything.
 */
function fakeWriter(opts = {}) {
  const state = { calls: [] };
  const failIds = new Set(opts.failIds || []);
  const write = async (operations) => {
    state.calls.push(operations);
    const rejected = operations.filter(op => opts.failAll || failIds.has(String(op.id)));
    return {
      succeeded: operations.length - rejected.length,
      failed: rejected.length,
      statusCounts: rejected.length
        ? { 429: rejected.length, ...(operations.length - rejected.length
          ? { 200: operations.length - rejected.length } : {}) }
        : { 200: operations.length },
      requestCharge: operations.length * 10,
      failedIds: rejected.map(op => String(op.id))
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
      sources: fakeSources(EAGLE), bulkVerified: writer.write, chunks: fakeChunks(), now: NOW
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
      sources: fakeSources(EAGLE), bulkVerified: writer.write, chunks: fakeChunks(), now: NOW
    });

    // Two projects, so two requests: a bulk request cannot span partition keys.
    assert.strictEqual(writer.state.calls.length, 2);
    const partitions = writer.state.calls.map(ops => ops[0].partitionKey);
    assert.deepStrictEqual(partitions.sort(), ['207', '311']);

    const first = writer.state.calls.find(ops => ops[0].partitionKey === '207');
    assert.strictEqual(first.length, 2, 'both documents of project 207 in one request');
    assert.strictEqual(first[0].operationType, 'Patch');
    assert.strictEqual(first[0].id, 'doc1');
    const ops = first[0].resourceBody.operations;
    assert.deepStrictEqual(ops.slice(0, 6), [
      { op: 'set', path: '/typeId', value: '5cf00c03a266b7e1877504da' },
      { op: 'set', path: '/milestoneId', value: '5cf00c03a266b7e1877504e9' },
      { op: 'set', path: '/projectPhaseId', value: '5d3f6c7eda7a38421829602f' },
      { op: 'set', path: '/documentAuthorType', value: 'Proponent / Certificate Holder' },
      { op: 'set', path: '/documentAuthorTypeId', value: '5cf00c03a266b7e1877504dc' },
      { op: 'set', path: '/updatedAt', value: NOW }
    ]);
    // The outbox stamp rides the same patch. Its token is minted at write time, so only its shape
    // can be pinned here; the test named for the clear pins the value the guard is built from.
    assert.deepStrictEqual(ops[6], { op: 'set', path: '/parentFieldsPending', value: true });
    assert.strictEqual(ops[7].path, '/parentFieldsPendingAt');
    assert.match(ops[7].value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.strictEqual(ops.length, 8, 'well inside the ten operations Cosmos allows per item');
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
      sources: fakeSources(eagle), bulkVerified: writer.write, chunks: fakeChunks(), now: NOW
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
      bulkVerified: writer.write, chunks: fakeChunks(), now: NOW
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
        sources: fakeSources(EAGLE), bulkVerified: fakeWriter().write, chunks: fakeChunks(), now: NOW
      });
      assert.strictEqual(summary.scanned, 3);
      assert.strictEqual(summary.expected, 60578);
      // The summary is what the exit code is computed from, and a partial run must not exit 0 —
      // a wrapper reads that as "every filter works now". Asserted on the same fields the entry
      // point reads, since the entry point itself calls process.exit.
      assert.ok(summary.scanned !== summary.expected, 'this is the state that must exit non-zero');
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
      sources: fakeSources(EAGLE), bulkVerified: writer.write, chunks: fakeChunks(), now: NOW
    });
    assert.strictEqual(summary.unmatched, 1);
    assert.strictEqual(summary.planned, 3, 'the unmatched row is not planned as a page of nulls');
  });

  await t.test('re-stamps the chunks of every document whose ids moved', async () => {
    // THE OTHER HALF OF THE SAME FIX. Every chunk carries a COPY of these four ids so a chunk
    // search can filter on them without a join, and nothing else refreshes it. Writing the ids onto
    // the document and stopping there fixes the Document tab and leaves Deep Search filtering on
    // what the chunk was stamped with at ingest — four nulls for exactly these rows, so the filter
    // matches none of them under a 200.
    const chunks = fakeChunks();
    const summary = await backfill(['--live'], {
      documents: fakeDocuments(SEEDED), projects: fakeProjects(['207', '311']),
      sources: fakeSources(EAGLE), bulkVerified: fakeWriter().write, chunks, now: NOW
    });

    assert.deepStrictEqual(chunks.state.patched.map(p => p.id).sort(), ['doc1', 'doc2', 'doc3']);
    assert.strictEqual(chunks.state.patched[0].typeId, '5cf00c03a266b7e1877504da',
      'the chunks must get the NEW id, not whatever the stale row held');
    assert.strictEqual(summary.documentsReStamped, 3);
  });

  await t.test('a document already carrying its ids has no chunks re-stamped', async () => {
    // The re-stamp walks every chunk of the document, so firing it for a row that did not move
    // would pay that RU over the whole corpus on every re-run.
    const current = SEEDED.map(d => ({
      ...d, typeId: '5cf00c03a266b7e1877504da', documentAuthorType: null,
      ...(d.id === 'doc1' ? {
        milestoneId: '5cf00c03a266b7e1877504e9',
        projectPhaseId: '5d3f6c7eda7a38421829602f',
        documentAuthorType: 'Proponent / Certificate Holder',
        documentAuthorTypeId: '5cf00c03a266b7e1877504dc'
      } : {})
    }));
    const chunks = fakeChunks();
    await backfill(['--live'], {
      documents: fakeDocuments(current), projects: fakeProjects(['207', '311']),
      sources: fakeSources(EAGLE), bulkVerified: fakeWriter().write, chunks, now: NOW
    });

    assert.deepStrictEqual(chunks.state.patched, []);
  });

  await t.test('only the documents whose row write LANDED have their chunks re-stamped', async () => {
    // A re-stamp on the strength of a rejected write puts an id in the chunks that no document in
    // Cosmos holds — the chunk then answers a filter its own document does not match, which is
    // strictly worse than the stale copy the run was fixing.
    const eagle = [];
    const seeded = [];
    const failIds = [];
    for (let i = 0; i < 100; i++) {
      const id = `doc${String(i).padStart(3, '0')}`;
      eagle.push({ _id: id, type: '5cf00c03a266b7e1877504da' });
      seeded.push({ id, projectId: '207', type: 'Letter' });
      if (i % 5 === 0 || i % 5 === 1) failIds.push(id);   // 40 of the 100
    }
    const chunks = fakeChunks();
    const summary = await backfill(['--live'], {
      documents: fakeDocuments(seeded), projects: fakeProjects(['207']),
      sources: fakeSources(eagle), bulkVerified: fakeWriter({ failIds }).write, chunks, now: NOW
    });

    assert.strictEqual(summary.failed, 40);
    assert.strictEqual(summary.patched, 60);
    assert.strictEqual(summary.documentsReStamped, 60);
    assert.strictEqual(summary.reStampSkipped, 40);
    assert.deepStrictEqual(chunks.state.patched.map(p => p.id).sort(),
      seeded.map(d => d.id).filter(id => !failIds.includes(id)).sort());
    for (const id of failIds) {
      assert.ok(!chunks.state.patched.some(p => p.id === id),
        `${id}'s row write was rejected but its chunks were re-stamped anyway`);
    }
  });

  await t.test('a failed re-stamp is counted, not thrown', async () => {
    // The document rows are authoritative and have landed. A stale chunk copy makes a filter MISS
    // rather than expose anything, so it must not abort a run that fixed 60k documents.
    const summary = await backfill(['--live'], {
      documents: fakeDocuments(SEEDED), projects: fakeProjects(['207', '311']),
      sources: fakeSources(EAGLE), bulkVerified: fakeWriter().write,
      chunks: fakeChunks({ throwAll: true }), now: NOW
    });

    assert.strictEqual(summary.reStampFailedDocuments, 3);
    assert.strictEqual(summary.reStampFailedChunks, 0,
      'nothing came back from a throw, so no chunk operation can be claimed as rejected');
    assert.strictEqual(summary.documentsReStamped, 0);
    assert.strictEqual(summary.patched, 3, 'the document half still landed');
    assert.strictEqual(exitCodeFor(summary), 0);
  });

  await t.test('a part-stamped document is one document and two chunk operations', async () => {
    // The units the summary used to add together. `doc1`'s row landed and two of its chunk
    // operations were rejected — one document to repair, not two, and reading it either way
    // decides whether the operator runs a 1.1M-row backfill.
    const summary = await backfill(['--live'], {
      documents: fakeDocuments(SEEDED), projects: fakeProjects(['207', '311']),
      sources: fakeSources(EAGLE), bulkVerified: fakeWriter().write,
      chunks: fakeChunks({ rejectChunksOf: ['doc1'] }), now: NOW
    });

    assert.strictEqual(summary.reStampFailedDocuments, 1);
    assert.strictEqual(summary.reStampFailedChunks, 2);
    assert.strictEqual(summary.documentsReStamped, 2, 'the other two landed whole');
  });

  await t.test('a row whose parent fields moved is patched flagged, in the same operations',
    async () => {
      // The flag rides the SAME patch as the ids. Re-stamping best-effort and flagging nothing
      // made every loss here invisible: a run killed between the patch and the re-stamp, or a
      // re-stamp that threw, left rows whose chunks nothing knows to repair.
      const writer = fakeWriter();
      const seeded = [{ ...SEEDED[0], parentFieldsPendingAt: '2999-01-01T00:00:00.000Z' }];
      await backfill(['--live'], {
        documents: fakeDocuments(seeded), projects: fakeProjects(['207']),
        sources: fakeSources(EAGLE), bulkVerified: writer.write, chunks: fakeChunks(), now: NOW
      });

      assert.deepStrictEqual(
        opsFor(writer, 'doc1').filter(op => op.path.startsWith('/parentFieldsPending')),
        [
          { op: 'set', path: '/parentFieldsPending', value: true },
          // Strictly past the token the row held, or the older flag's clear takes this one down.
          { op: 'set', path: '/parentFieldsPendingAt', value: '2999-01-01T00:00:00.001Z' }
        ]);
    });

  await t.test('a patch that moves no parent field raises no flag', async () => {
    // `documentAuthorType` is the LABEL, and no chunk carries it — only the four ids beside it are
    // stamped onto chunks. A patch that moves the label alone owes the chunks nothing, and a flag
    // raised here sends `--pending` over rows whose chunks already agree.
    const writer = fakeWriter();
    const labelOnly = [{
      id: 'doc1', projectId: '207', type: 'Letter',
      typeId: '5cf00c03a266b7e1877504da',
      milestoneId: '5cf00c03a266b7e1877504e9',
      projectPhaseId: '5d3f6c7eda7a38421829602f',
      documentAuthorTypeId: '5cf00c03a266b7e1877504dc'
    }];
    const summary = await backfill(['--live'], {
      documents: fakeDocuments(labelOnly), projects: fakeProjects(['207']),
      sources: fakeSources(EAGLE), bulkVerified: writer.write, chunks: fakeChunks(), now: NOW
    });

    assert.strictEqual(summary.planned, 1, 'the label is stale and is still patched');
    assert.deepStrictEqual(opsFor(writer, 'doc1').map(op => op.path),
      ['/documentAuthorType', '/updatedAt']);
    assert.strictEqual(summary.pendingRaised, 0);
  });

  await t.test('the flag is cleared on the token it was raised with', async () => {
    const writer = fakeWriter();
    const documents = fakeDocuments([SEEDED[0]]);
    const summary = await backfill(['--live'], {
      documents, projects: fakeProjects(['207']),
      sources: fakeSources(EAGLE), bulkVerified: writer.write, chunks: fakeChunks(), now: NOW
    });

    const token = opsFor(writer, 'doc1').find(op => op.path === '/parentFieldsPendingAt').value;
    assert.deepStrictEqual(documents.state.cleared, [
      { id: 'doc1', projectId: '207', pending: false, guard: { pendingAt: token } }
    ], 'unguarded, this clear would take down a flag a newer write raised for chunks it never saw');
    assert.strictEqual(summary.pendingCleared, 1);
  });

  await t.test('the chunk patches are guarded on the token the flag was raised with', async () => {
    // Unguarded, this run is last-writer-wins: a partition that took minutes to flush would put
    // the values it read at the start back over a re-stamp that landed in between, with the flag
    // already cleared, so nothing would report the drift.
    const writer = fakeWriter();
    const chunks = fakeChunks();
    await backfill(['--live'], {
      documents: fakeDocuments([SEEDED[0]]), projects: fakeProjects(['207']),
      sources: fakeSources(EAGLE), bulkVerified: writer.write, chunks, now: NOW
    });

    const token = opsFor(writer, 'doc1').find(op => op.path === '/parentFieldsPendingAt').value;
    assert.deepStrictEqual(chunks.state.stampedAt, [token]);
  });

  await t.test('a document whose chunks did not all land keeps its flag', async () => {
    // `doc1` landed and two of its chunk operations were rejected, so its chunks hold a mix of old
    // and new values — the exact state `backfill-chunk-parent-fields.js --pending` walks.
    const documents = fakeDocuments(SEEDED);
    const summary = await backfill(['--live'], {
      documents, projects: fakeProjects(['207', '311']),
      sources: fakeSources(EAGLE), bulkVerified: fakeWriter().write,
      chunks: fakeChunks({ rejectChunksOf: ['doc1'] }), now: NOW
    });

    assert.deepStrictEqual(summary.pendingLeftRaised, ['doc1'],
      'named as well as counted: a count cannot say which rows to repair');
    assert.ok(!documents.state.cleared.some(c => c.id === 'doc1'));
    assert.strictEqual(summary.pendingCleared, 2, 'the two that landed whole');
  });

  await t.test('a clear a newer write owns is counted as a conflict', async () => {
    const summary = await backfill(['--live'], {
      documents: fakeDocuments(SEEDED, { clearOutcome: { status: 'conflict', pendingAt: NOW } }),
      projects: fakeProjects(['207', '311']),
      sources: fakeSources(EAGLE), bulkVerified: fakeWriter().write, chunks: fakeChunks(), now: NOW
    });

    assert.strictEqual(summary.pendingConflicts, 3);
    assert.strictEqual(summary.pendingCleared, 0,
      'the newer write owns the flag now and its own re-stamp clears it');
  });

  await t.test('a row gone by the time the clear runs is counted as missing', async () => {
    const summary = await backfill(['--live'], {
      documents: fakeDocuments(SEEDED, { clearOutcome: { status: 'missing', reason: 'patch' } }),
      projects: fakeProjects(['207', '311']),
      sources: fakeSources(EAGLE), bulkVerified: fakeWriter().write, chunks: fakeChunks(), now: NOW
    });

    assert.strictEqual(summary.pendingMissed, 3);
  });

  await t.test('a dry run counts the flags it would raise and writes none', async () => {
    const writer = fakeWriter();
    const documents = fakeDocuments(SEEDED);
    const summary = await backfill([], {
      documents, projects: fakeProjects(['207', '311']),
      sources: fakeSources(EAGLE), bulkVerified: writer.write, chunks: fakeChunks(), now: NOW
    });

    assert.strictEqual(summary.pendingRaised, 3);
    assert.deepStrictEqual(writer.state.calls, [], 'a dry run reports counts and touches nothing');
    assert.deepStrictEqual(documents.state.cleared, []);
  });

  await t.test('a rejected batch is reported, and the run exits non-zero on it', async () => {
    const writer = fakeWriter({ failAll: true });
    const summary = await backfill(['--live'], {
      documents: fakeDocuments(SEEDED), projects: fakeProjects(['207', '311']),
      sources: fakeSources(EAGLE), bulkVerified: writer.write, chunks: fakeChunks(), now: NOW
    });
    assert.strictEqual(summary.patched, 0);
    assert.strictEqual(summary.failed, 3);
    assert.deepStrictEqual(summary.statusCounts, { 429: 3 }, 'summed across both requests');
  });
});

// The entry point calls process.exit, so the decision is tested where it can be: as a function of
// the same summary the run returns. Review caught that deleting the incomplete half left the suite
// green — a claim in the commit message with nothing holding it up.
test('exitCodeFor — a partial run is non-zero, both ways of being partial', () => {
  assert.strictEqual(exitCodeFor({ scanned: 60578, expected: 60578, failed: 0 }), 0);
  assert.strictEqual(exitCodeFor({ scanned: 3, expected: 60578, failed: 0 }), 1, 'short walk');
  assert.strictEqual(exitCodeFor({ scanned: 60578, expected: 60578, failed: 2 }), 1, 'rejected write');
  assert.strictEqual(exitCodeFor({ scanned: 3, failed: 0 }), 0, 'no count taken, nothing to compare');
});
