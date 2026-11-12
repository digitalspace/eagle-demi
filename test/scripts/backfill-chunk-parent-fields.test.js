'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseArgs, backfill, exitCodeFor, DEFAULT_CONCURRENCY, DEFAULT_MAX_ATTEMPTS, NULL_PARTITION
} = require('../../src/scripts/backfill-chunk-parent-fields');
const chunks = require('../../src/repositories/chunks');
const { PARENT_PENDING_FIELDS } = require('../../src/repositories/documents');
const { logger } = require('../../src/utils/logger');

const TYPE_ID = '5cf00c03a266b7e1877504db';
/** The token a raise writes beside the flag, and the one a clear has to be guarded on. */
const PENDING_AT = '2026-09-09T12:00:00.000Z';
/** What the row carries after a write that landed while this run was walking it. */
const MOVED_PENDING_AT = '2026-09-09T12:05:00.000Z';
/** The stamp a chunk carries once this backfill has visited it. */
const V = chunks.CHUNK_PARENT_FIELDS_VERSION;

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'demi-backfill-'));
test.after(() => fs.rmSync(STATE_DIR, { recursive: true, force: true }));

let stateSeq = 0;
const stateFile = () => path.join(STATE_DIR, `state-${stateSeq++}.json`);

/**
 * Documents repository double, partitioned by `projectId` the way Cosmos is. Partitions come from
 * the documents, since a ProjectNotification parent has no `projects` row.
 */
function fakeDocuments(docs, opts = {}) {
  const state = { partitions: [], selected: [], pendingWrites: [] };
  // NO `?? ''`. A JSON-null projectId and `''` are different partitions in Cosmos, and a double
  // that folds one into the other hides the bug where the script walked nothing at all.
  const inPartition = (doc, partition) =>
    doc.projectId !== null && doc.projectId !== undefined && String(doc.projectId) === partition;
  // A raise writes the flag and its token together, so a fixture that names the flag gets one
  // without spelling it out. `null` on the rest, which is what a cleared row holds.
  const tokenOf = (doc) => doc.parentFieldsPending === true
    ? (doc.parentFieldsPendingAt || PENDING_AT)
    : (doc.parentFieldsPendingAt ?? null);
  // Projected like the repository's SELECT, so reading any other column fails here. Properties the
  // item lacks stay absent, as in a Cosmos projection.
  const project = (doc) => {
    const row = { id: doc.id, _etag: doc._etag || `etag-${doc.id}` };
    for (const field of chunks.CHUNK_PARENT_FIELDS) {
      if (field in doc) row[field] = doc[field];
    }
    if (doc.parentFieldsPending !== undefined) {
      row.parentFieldsPending = doc.parentFieldsPending;
      row.parentFieldsPendingAt = tokenOf(doc);
    }
    state.selected.push(Object.keys(row));
    return row;
  };
  return {
    state,
    async parentFieldRowsForProject(access, projectId) {
      state.partitions.push(String(projectId));
      return docs.filter(doc => inPartition(doc, String(projectId))).map(project);
    },
    // The rows `listDistinctProjectIds` cannot enumerate, read cross-partition — the repository's
    // own complement of the predicate above.
    async parentFieldRowsWithNoProject() {
      state.partitions.push(NULL_PARTITION);
      return docs.filter(doc => doc.projectId === null || doc.projectId === undefined).map(project);
    },
    async listDistinctProjectIds() {
      // IS_DEFINED AND NOT NULL, the repository's predicate — a null-project row is in no partition.
      return Array.from(new Set(docs
        .filter(doc => doc.projectId !== null && doc.projectId !== undefined)
        .map(doc => String(doc.projectId))));
    },
    async countVisible(access, criteria = {}) {
      return criteria.hasProjectId === true
        ? docs.filter(doc => doc.projectId !== null && doc.projectId !== undefined).length
        : docs.length;
    },
    async listParentFieldsPending() {
      return docs.filter(doc => doc.parentFieldsPending === true)
        .map(doc => ({ id: doc.id, projectId: doc.projectId }));
    },
    /**
     * Clears only when the token still matches. `movedOn` = a newer write took the token;
     * `missingOn` = no row found. A mismatch is a status, not a throw.
     */
    async setParentFieldsPending(id, projectId, pending, guard) {
      const token = guard && typeof guard === 'object' ? guard.pendingAt : undefined;
      const doc = docs.find(d => String(d.id) === String(id));
      if (!doc || (opts.missingOn || []).includes(String(id))) {
        return { status: 'missing', reason: 'patch' };
      }
      const stored = (opts.movedOn || []).includes(String(id)) ? MOVED_PENDING_AT : tokenOf(doc);
      if (token !== undefined && token !== stored) return { status: 'conflict', pendingAt: token };
      state.pendingWrites.push({ id: String(id), projectId, pending, pendingAt: token ?? null });
      return { status: 'cleared', pendingAt: null };
    }
  };
}

/**
 * Chunks repository double. `parentFieldsOf` and `reStampAfterWrite` are the real ones; only the
 * Cosmos write is faked, through the `stamp` seam.
 */
function fakeChunks(opts = {}) {
  // `stamps`: documentId -> the instant the patch was guarded on. `budgets`: the retry budget each
  // patch got, which no other assertion would notice being dropped.
  const state = {
    patched: [], patchedIds: [], live: 0, read: [], pointReads: [], stamps: {}, budgets: [],
    backoffCeilings: []
  };
  // What each document's chunks hold. Absent means one chunk, all four null and no version.
  const rows = opts.rows || {};
  const chunksOf = (documentId) => rows[String(documentId)] || [{ id: `${documentId}::p1::c0` }];
  return {
    state,
    CHUNK_PARENT_FIELDS: chunks.CHUNK_PARENT_FIELDS,
    CHUNK_PARENT_LIST_REFS: chunks.CHUNK_PARENT_LIST_REFS,
    parentFieldsOf: chunks.parentFieldsOf,
    chunkMatchesParent: chunks.chunkMatchesParent,
    async parentFieldRowsForDocument(access, documentId) {
      state.read.push(String(documentId));
      return chunksOf(documentId);
    },
    // The orphan purge's confirmation step: is this chunk still in Cosmos at all?
    async getById(access, id, documentId) {
      state.pointReads.push(String(id));
      return chunksOf(documentId).find(row => String(row.id) === String(id)) || null;
    },
    async setFieldsForChunks(
      access, documentId, ids, fields, { stampedAt, maxAttempts, maxBackoffMs } = {}
    ) {
      state.live++;
      state.patched.push(String(documentId));
      state.stamps[String(documentId)] = stampedAt;
      state.budgets.push(maxAttempts);
      state.backoffCeilings.push(maxBackoffMs);
      // The ids the caller chose, which is the whole point of this entry point: the backfill knows
      // which rows disagree and must not patch the ones that do not.
      state.patchedIds.push(...ids.map(String));
      if (opts.throwOn && opts.throwOn.includes(String(documentId))) {
        throw new Error('cosmos unavailable');
      }
      const failed = (opts.failOn || []).includes(String(documentId)) ? 1 : 0;
      // What Cosmos answers when a newer walk got there first: 412 on every operation, which is
      // neither a success nor a failure.
      const skippedNewer = (opts.skipNewerOn || []).includes(String(documentId)) ? ids.length : 0;
      return {
        succeeded: failed || skippedNewer ? 0 : ids.length, failed, skippedNewer,
        statusCounts: failed ? { 429: 1 } : (skippedNewer ? { 412: skippedNewer } : { 200: ids.length }),
        requestCharge: 10, chunks: ids.length, fields
      };
    },
    reStampAfterWrite(access, docs, failedIds, options) {
      // The REAL helper, with the script's own `stamp` seam left in place — the backfill patching
      // only the stale ids is exactly what a double that overrode it would hide.
      return chunks.reStampAfterWrite(access, docs, failedIds, options);
    }
  };
}

/**
 * AI Search double. `rows`: unstamped index rows by project id (`null` for the null bucket).
 * `deleted`: keys the purge asked to remove.
 */
function fakeSearch(opts = {}) {
  const state = { queried: [], deleted: [] };
  return {
    state,
    async listStaleChunkIds({ version, projectId, maxRows }) {
      state.queried.push({ version, projectId, maxRows });
      // null is what the module answers when search is unconfigured: "cannot say", never "none".
      if (opts.cannotSay) return null;
      const all = (opts.rows || {})[String(projectId)] || [];
      const rows = all.slice(0, maxRows);
      return { rows, total: all.length, complete: rows.length >= all.length };
    },
    async deleteDocuments(ids) {
      state.deleted.push(...ids);
      return (opts.failDelete || []).filter(id => ids.includes(id));
    }
  };
}

const DOCS = [
  { id: 'd1', projectId: '207', typeId: TYPE_ID },
  { id: 'd2', projectId: '207', milestoneId: 'm1', projectPhaseId: 'p1' },
  // Seeded before the List ids existed: nothing to copy down.
  { id: 'd3', projectId: '208' },
  { id: 'd4', projectId: '', documentAuthorTypeId: 'a1' }
];

function deps(overrides = {}) {
  return {
    documents: fakeDocuments(DOCS),
    chunks: fakeChunks(),
    search: fakeSearch(),
    ...overrides
  };
}

test('parseArgs', async (t) => {
  await t.test('is a dry run unless --live is given', () => {
    // The whole corpus is 1.1M chunks; a script that wrote by default would be a full-corpus patch
    // fired by a typo.
    assert.strictEqual(parseArgs([]).live, false);
    assert.strictEqual(parseArgs(['--live']).live, true);
  });

  await t.test('--live and --dry-run together are refused', () => {
    assert.throws(() => parseArgs(['--live', '--dry-run']), /contradict/);
  });

  await t.test('defaults concurrency to two and bounds it', () => {
    assert.strictEqual(parseArgs([]).concurrency, DEFAULT_CONCURRENCY);
    assert.strictEqual(parseArgs(['--concurrency', '4']).concurrency, 4);
    assert.throws(() => parseArgs(['--concurrency', '0']), /between 1 and 8/);
    assert.throws(() => parseArgs(['--concurrency', '9']), /between 1 and 8/);
    assert.throws(() => parseArgs(['--concurrency', 'lots']), /between 1 and 8/);
  });

  await t.test('--max-attempts defaults to this walk\'s own budget and is bounded when given', () => {
    // Not the shared bulk default: that one is sized for the request path, where a long retry is a
    // gateway timeout. This walk is offline and needs to outlast a throttle that runs for minutes.
    assert.strictEqual(parseArgs([]).maxAttempts, DEFAULT_MAX_ATTEMPTS);
    assert.strictEqual(parseArgs(['--max-attempts', '12']).maxAttempts, 12);
    assert.throws(() => parseArgs(['--max-attempts', '0']), /between 1 and 20/);
    assert.throws(() => parseArgs(['--max-attempts', '21']), /between 1 and 20/);
    assert.throws(() => parseArgs(['--max-attempts', 'lots']), /between 1 and 20/);
  });

  await t.test('an empty --project is refused', () => {
    // `''` is the no-project partition. Accepting it would scope the run to a handful of orphans
    // and report success.
    assert.throws(() => parseArgs(['--project']), /needs a project id/);
    assert.strictEqual(parseArgs(['--project', '207']).project, '207');
  });

  await t.test('--pending and --project are refused together', () => {
    // Two different sets of documents to walk; taking one silently would repair the wrong half.
    assert.throws(() => parseArgs(['--pending', '--project', '207']), /contradict/);
    assert.strictEqual(parseArgs(['--pending']).pending, true);
    assert.strictEqual(parseArgs([]).pending, false);
  });

  await t.test('--force is off unless asked for', () => {
    assert.strictEqual(parseArgs([]).force, false);
    assert.strictEqual(parseArgs(['--force']).force, true);
  });

  await t.test('an unknown flag stops the run', () => {
    assert.throws(() => parseArgs(['--projects', '207']), /unknown argument/);
  });
});

test('backfill', async (t) => {
  await t.test('a dry run writes nothing and still counts what it would do', async () => {
    const d = deps();
    const summary = await backfill(['--state', stateFile()], d);

    assert.strictEqual(summary.mode, 'dry-run');
    assert.strictEqual(summary.documents, 4);
    assert.strictEqual(summary.planned, 4);
    assert.strictEqual(summary.patched, 0);
    assert.strictEqual(d.chunks.state.live, 0, 'a dry run patched a chunk');
  });

  await t.test('patches only the chunks that disagree, not the whole partition', async () => {
    // The read already says which rows are stale. Re-patching the ones that agree is RU spent to
    // write back what is there, and on this corpus that is most of the container.
    const d = deps({
      chunks: fakeChunks({
        rows: {
          d1: [
            { id: 'd1::p1::c0', projectId: '207', typeId: TYPE_ID, parentFieldsVersion: V },
            { id: 'd1::p1::c1', projectId: '207', typeId: 'stale', parentFieldsVersion: V },
            { id: 'd1::p2::c0', projectId: '207', typeId: TYPE_ID, parentFieldsVersion: V }
          ]
        }
      })
    });
    const summary = await backfill(['--live', '--project', '207', '--state', stateFile()], d);

    // d2 is in the same partition and its own chunk is stale, so it is patched in full — the
    // assertion is about d1, whose three rows include two that already agree.
    assert.deepStrictEqual(d.chunks.state.patchedIds.filter(id => id.startsWith('d1')),
      ['d1::p1::c1'], 'the two rows that already agreed were patched anyway');
    assert.strictEqual(summary.patched, 2);
  });

  await t.test('--force re-patches a chunk whose Cosmos copy already matches', async () => {
    // Repair for a run before the data-source PUT: right in Cosmos, null in the index, and only a
    // forced patch moves `_ts` so the indexer re-pulls it.
    const rows = {
      d1: [{ id: 'd1::p1::c0', projectId: '207', typeId: TYPE_ID, parentFieldsVersion: V }],
      d2: [{
        id: 'd2::p1::c0', projectId: '207', milestoneId: 'm1', projectPhaseId: 'p1',
        parentFieldsVersion: V
      }]
    };
    const skipped = deps({ chunks: fakeChunks({ rows }) });
    await backfill(['--live', '--project', '207', '--state', stateFile()], skipped);
    assert.deepStrictEqual(skipped.chunks.state.patchedIds, [], 'the premise: it is skipped');

    const forced = deps({ chunks: fakeChunks({ rows }) });
    const summary = await backfill(
      ['--live', '--force', '--project', '207', '--state', stateFile()], forced);

    assert.deepStrictEqual(forced.chunks.state.patchedIds.sort(),
      ['d1::p1::c0', 'd2::p1::c0']);
    assert.strictEqual(summary.skipped, 0);
  });

  await t.test('a document with no projectId is walked as its own bucket, not folded into \'\'',
    async () => {
      // Two traps: folding null into `''` walks the wrong partition, and skipping the rows leaves
      // their chunks unstamped for good.
      const d = deps({
        documents: fakeDocuments([...DOCS, { id: 'd6', projectId: null, typeId: TYPE_ID }])
      });
      const summary = await backfill(['--live', '--state', stateFile()], d);

      assert.deepStrictEqual(d.documents.state.partitions.sort(),
        ['', NULL_PARTITION, '207', '208'].sort());
      assert.ok(d.chunks.state.patched.includes('d6'), 'the null-project chunks were never stamped');
      assert.strictEqual(summary.nullProject, 1);
      assert.strictEqual(summary.expected, 5, 'every document is coverable, so every one counts');
      assert.strictEqual(summary.documents, 5);
      assert.strictEqual(exitCodeFor(summary), 0);
    });

  await t.test('--pending walks only the flagged documents and clears their flag', async () => {
    const d = deps({
      documents: fakeDocuments([
        { id: 'd1', projectId: '207', typeId: TYPE_ID },
        { id: 'd2', projectId: '207', milestoneId: 'm1', projectPhaseId: 'p1',
          parentFieldsPending: true },
        { id: 'd3', projectId: '208' },
        { id: 'd4', projectId: '', documentAuthorTypeId: 'a1', parentFieldsPending: true }
      ])
    });
    const summary = await backfill(['--live', '--pending', '--state', stateFile()], d);

    assert.deepStrictEqual(d.chunks.state.patched.sort(), ['d2', 'd4']);
    assert.deepStrictEqual(d.documents.state.partitions.sort(), ['', '207'],
      '208 holds no flagged document, so it is never read');
    assert.strictEqual(summary.documents, 2);
    assert.deepStrictEqual(d.documents.state.pendingWrites.sort((a, b) => a.id < b.id ? -1 : 1), [
      { id: 'd2', projectId: '207', pending: false, pendingAt: PENDING_AT },
      { id: 'd4', projectId: '', pending: false, pendingAt: PENDING_AT }
    ]);
    assert.strictEqual(summary.pendingCleared, 2);
  });

  await t.test('--pending leaves the flag on a document whose patch did not land', async () => {
    // The flag says the chunks are behind. Clearing it on a partition that lost a chunk is how the
    // drift becomes invisible again, and nothing else would ever look at that document.
    const d = deps({
      documents: fakeDocuments([{ id: 'd1', projectId: '207', typeId: TYPE_ID,
        parentFieldsPending: true }]),
      chunks: fakeChunks({ failOn: ['d1'] })
    });
    const summary = await backfill(['--live', '--pending', '--state', stateFile()], d);

    assert.strictEqual(summary.failedChunks, 1);
    assert.deepStrictEqual(d.documents.state.pendingWrites, []);
    assert.strictEqual(exitCodeFor(summary), 1);
  });

  await t.test('--pending clears the flag on a document whose chunks already agree', async () => {
    // Something else fixed it — a retry that landed after the flag was written. The proof the
    // chunks agree is as good as a patch, and leaving the flag would keep it on the drift line.
    const d = deps({
      documents: fakeDocuments([{ id: 'd1', projectId: '207', typeId: TYPE_ID,
        parentFieldsPending: true }]),
      chunks: fakeChunks({
        rows: { d1: [{ id: 'd1::p1::c0', projectId: '207', typeId: TYPE_ID,
          parentFieldsVersion: V }] }
      })
    });
    const summary = await backfill(['--live', '--pending', '--state', stateFile()], d);

    assert.strictEqual(summary.skipped, 1);
    assert.deepStrictEqual(d.documents.state.pendingWrites,
      [{ id: 'd1', projectId: '207', pending: false, pendingAt: PENDING_AT }]);
  });

  await t.test('a dry --pending run clears nothing', async () => {
    const d = deps({
      documents: fakeDocuments([{ id: 'd1', projectId: '207', typeId: TYPE_ID,
        parentFieldsPending: true }])
    });
    await backfill(['--pending', '--state', stateFile()], d);

    assert.deepStrictEqual(d.documents.state.pendingWrites, []);
    assert.strictEqual(d.chunks.state.live, 0);
  });

  await t.test('reads only the projected columns, never the whole document row', async () => {
    // ~61k documents compared on five short strings. `listVisible` selects the full catalogued row.
    const d = deps();
    await backfill(['--live', '--state', stateFile()], d);

    assert.strictEqual(typeof d.documents.listVisible, 'undefined',
      'the double offers no listVisible, so a full-row read would have thrown');
    const projected = [...chunks.CHUNK_PARENT_FIELDS, ...PARENT_PENDING_FIELDS];
    for (const columns of d.documents.state.selected) {
      assert.ok(columns.every(c => c === 'id' || c === '_etag' || projected.includes(c)),
        `a column outside the projection was read: ${columns.join(', ')}`);
    }
  });

  await t.test('an unstamped document with nothing to copy is still stamped', async () => {
    // d3's chunks already hold the nulls it wants; only the missing version shows they were never
    // visited.
    const d = deps();
    const summary = await backfill(['--live', '--state', stateFile()], d);

    assert.strictEqual(summary.skipped, 0);
    assert.deepStrictEqual(d.chunks.state.patched.sort(), ['d1', 'd2', 'd3', 'd4']);
  });

  await t.test('a chunk below the current version is re-stamped even though it agrees', async () => {
    // What a version bump buys: after CHUNK_PARENT_FIELDS grows, every chunk stamped under the old
    // list still agrees on all four values, so a value-only comparison would skip the whole corpus.
    const d = deps({
      chunks: fakeChunks({
        rows: {
          d1: [{ id: 'd1::p1::c0', projectId: '207', typeId: TYPE_ID, parentFieldsVersion: V - 1 }],
          d2: [{ id: 'd2::p1::c0', projectId: '207', milestoneId: 'm1', projectPhaseId: 'p1', parentFieldsVersion: V }],
          d3: [{ id: 'd3::p1::c0', projectId: '208', parentFieldsVersion: V }],
          d4: [{ id: 'd4::p1::c0', projectId: '', documentAuthorTypeId: 'a1', parentFieldsVersion: V }]
        }
      })
    });
    const summary = await backfill(['--live', '--state', stateFile()], d);

    assert.deepStrictEqual(d.chunks.state.patched, ['d1']);
    assert.strictEqual(summary.skipped, 3);
  });

  await t.test('walks the no-project partition as well as every project', async () => {
    // Documents linked to no project live in `''`. A walk that skipped it would leave them
    // unfilterable and report success.
    const d = deps();
    await backfill(['--live', '--state', stateFile()], d);

    assert.deepStrictEqual(d.documents.state.partitions.sort(),
      ['', NULL_PARTITION, '207', '208'].sort());
    assert.ok(d.chunks.state.patched.includes('d4'));
  });

  await t.test('sums the chunk operations, not the documents seen', async () => {
    const d = deps();
    const summary = await backfill(['--live', '--state', stateFile()], d);

    assert.strictEqual(summary.patched, 4, 'four documents of one stale chunk each');
    assert.strictEqual(summary.requestCharge, 40);
  });

  await t.test('--project scopes the walk to one partition', async () => {
    const d = deps();
    const summary = await backfill(['--live', '--project', '207', '--state', stateFile()], d);

    assert.deepStrictEqual(d.documents.state.partitions, ['207']);
    assert.strictEqual(summary.documents, 2);
  });

  await t.test('a finished partition is checkpointed and skipped on a rerun', async () => {
    const file = stateFile();
    await backfill(['--live', '--state', file], deps());

    // '208' is NOT here: its only document has nothing to copy down — see the next case.
    assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).walked).sort(),
      ['', '207']);

    const second = deps();
    const summary = await backfill(['--live', '--state', file], second);

    assert.strictEqual(summary.resumed, 2);
    // The null bucket holds nothing here, so it is never checkpointed and every run re-reads it.
    assert.deepStrictEqual(second.documents.state.partitions.sort(),
      ['208', NULL_PARTITION].sort());
    // '208' is re-walked because it was never checkpointed, and this double's rows do not carry
    // the first run's stamp — against Cosmos the second read would return it and skip.
    assert.deepStrictEqual(second.chunks.state.patched, ['d3']);
  });

  await t.test('a partition whose documents all had nothing to copy is NOT checkpointed', async () => {
    // '208' holds only d3, with null List refs, which is how every row looks before the List-id
    // backfill. Checkpointing it would let a too-early run mark the corpus done.
    const file = stateFile();
    await backfill(['--live', '--state', file], deps());

    const done = Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).walked);
    assert.ok(!done.includes('208'), `a partition with nothing to stamp was checkpointed: ${done}`);

    // And the rerun walks it again, so the ids can land once the documents carry them.
    const second = deps({
      documents: fakeDocuments([...DOCS.slice(0, 3).filter(d => d.id !== 'd3'),
        { id: 'd3', projectId: '208', typeId: TYPE_ID }, DOCS[3]])
    });
    await backfill(['--live', '--state', file], second);
    assert.deepStrictEqual(second.chunks.state.patched, ['d3']);
  });

  await t.test('a partition that lost a chunk is not checkpointed', async () => {
    // A rerun has to retry it. Checkpointing a partial partition is how a backfill reports success
    // over rows nobody ever wrote.
    const file = stateFile();
    const summary = await backfill(['--live', '--state', file],
      deps({ chunks: fakeChunks({ failOn: ['d1'] }) }));

    assert.strictEqual(summary.failedChunks, 1);
    assert.strictEqual(summary.failedDocuments, 1, 'one document was left part-stamped');
    assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).walked).sort(),
      ['']);
  });

  await t.test('a throwing document is counted and the walk carries on', async () => {
    const d = deps({ chunks: fakeChunks({ throwOn: ['d1'] }) });
    const summary = await backfill(['--live', '--state', stateFile()], d);

    assert.strictEqual(summary.failedDocuments, 1);
    assert.strictEqual(summary.failedChunks, 0,
      'nothing came back from a throw, so no chunk operation can be claimed as rejected');
    assert.ok(d.chunks.state.patched.includes('d2'), 'the walk stopped at the first failure');
  });

  await t.test('--project ignores the checkpoint, because it is a repair', async () => {
    const file = stateFile();
    await backfill(['--live', '--state', file], deps());

    const second = deps();
    const summary = await backfill(['--live', '--project', '207', '--state', file], second);

    assert.strictEqual(summary.documents, 2);
    assert.deepStrictEqual(second.chunks.state.patched.sort(), ['d1', 'd2']);
  });

  await t.test('walks a partition that has no project row at all', async () => {
    // A ProjectNotification parent partitions the document under the notification id
    // (`helpers/parent-admit.js`), which has no `projects` row.
    const notification = '5f0e4a0c3f4b1a0021a1b2c3';
    const d = deps({
      documents: fakeDocuments([...DOCS, { id: 'd5', projectId: notification, typeId: TYPE_ID }])
    });
    const summary = await backfill(['--live', '--state', stateFile()], d);

    assert.ok(d.documents.state.partitions.includes(notification),
      `the notification partition was never read: ${d.documents.state.partitions}`);
    assert.ok(d.chunks.state.patched.includes('d5'));
    assert.strictEqual(summary.documents, 5);
  });

  await t.test('a walk that misses a partition is INCOMPLETE and exits 1', async () => {
    // The coverage check `backfill-document-list-ids.js` makes, for the same reason: a partial run
    // that reports success is worse than no run, because nobody re-runs it.
    const d = deps();
    d.documents.listDistinctProjectIds = async () => ['207'];
    const summary = await backfill(['--live', '--state', stateFile()], d);

    assert.strictEqual(summary.expected, 4);
    assert.strictEqual(summary.documents, 2);
    assert.strictEqual(exitCodeFor(summary), 1);
  });

  await t.test('a complete walk reports expected and exits 0', async () => {
    const summary = await backfill(['--live', '--state', stateFile()], deps());

    assert.strictEqual(summary.expected, summary.documents);
    assert.strictEqual(exitCodeFor(summary), 0);
  });

  await t.test('clears a chunk whose value the document no longer has', async () => {
    // d3 has no List refs but its chunks still carry a type removed upstream.
    const d = deps({
      chunks: fakeChunks({ rows: { d3: [{ id: 'd3::p1::c0', projectId: '208', typeId: TYPE_ID }] } })
    });
    const summary = await backfill(['--live', '--state', stateFile()], d);

    assert.ok(d.chunks.state.patched.includes('d3'),
      'a chunk holding a value its document dropped was left alone');
    assert.deepStrictEqual(chunks.parentFieldsOf(DOCS[2]),
      {
        projectId: '208',
        typeId: null, milestoneId: null, projectPhaseId: null, documentAuthorTypeId: null,
        parentFieldsVersion: V
      },
      'the fixture must have no List refs to copy, or this asserts the ordinary path');
    assert.strictEqual(summary.skipped, 0);
  });

  await t.test('a document whose chunks already agree is skipped', async () => {
    // Every row carries the current version, as in a finished corpus; nothing should be patched.
    const d = deps({
      chunks: fakeChunks({
        rows: {
          d1: [{ id: 'd1::p1::c0', projectId: '207', typeId: TYPE_ID, parentFieldsVersion: V }],
          d2: [{ id: 'd2::p1::c0', projectId: '207', milestoneId: 'm1', projectPhaseId: 'p1', parentFieldsVersion: V }],
          d3: [{ id: 'd3::p1::c0', projectId: '208', parentFieldsVersion: V }],
          d4: [{ id: 'd4::p1::c0', projectId: '', documentAuthorTypeId: 'a1', parentFieldsVersion: V }]
        }
      })
    });
    const summary = await backfill(['--live', '--state', stateFile()], d);

    assert.deepStrictEqual(d.chunks.state.patched, []);
    assert.strictEqual(summary.skipped, 4);
  });

  await t.test('a checkpoint records how many documents the partition held', async () => {
    // The count is the only record of that partition's contribution: a resumed run never re-reads
    // it, so without the number the run cannot say what fraction of the corpus it has covered.
    const file = stateFile();
    await backfill(['--live', '--state', file], deps());

    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).walked,
      { '': 1, 207: 2 }, '208 is not checkpointed — its only document had nothing to copy');
  });

  await t.test('a resumed run that walks the rest of the corpus exits 0', async () => {
    const file = stateFile();
    await backfill(['--live', '--state', file], deps());

    const second = deps();
    const summary = await backfill(['--live', '--state', file], second);

    assert.strictEqual(summary.documents, 1, 'only the partition that was never checkpointed');
    assert.strictEqual(summary.checkpointed, 3, 'read back from the state file');
    assert.strictEqual(exitCodeFor(summary), 0);
  });

  await t.test('a RESUMED run that misses a partition is INCOMPLETE and exits 1', async () => {
    // A resume is not exempt from the coverage check: a run that exits 0 is never run again.
    const file = stateFile();
    await backfill(['--live', '--state', file], deps());

    const second = deps();
    second.documents.listDistinctProjectIds = async () => ['', '207'];
    const summary = await backfill(['--live', '--state', file], second);

    assert.strictEqual(summary.documents, 0, 'both enumerated partitions were already done');
    assert.strictEqual(summary.checkpointed + summary.documents, 3);
    assert.strictEqual(summary.expected, 4);
    assert.strictEqual(exitCodeFor(summary), 1);
  });

  await t.test('a state file this script did not write starts a fresh walk', async () => {
    // One fact per finished partition — the document count — so there is no shape that carries a
    // checkpoint without its number. A file holding anything else is read as nothing checkpointed.
    const file = stateFile();
    fs.writeFileSync(file, JSON.stringify({ done: ['208'] }));

    const d = deps();
    const summary = await backfill(['--live', '--state', file], d);

    assert.strictEqual(summary.resumed, 0);
    assert.strictEqual(summary.documents, 4, 'a partition was skipped on the strength of junk');
    assert.strictEqual(exitCodeFor(summary), 0);
  });

  await t.test('a checkpoint survives a kill in the middle of the write', async (t2) => {
    // An in-place write truncates first, so a kill leaves a fragment read as "nothing checkpointed".
    const file = stateFile();
    await backfill(['--live', '--state', file], deps());
    const before = fs.readFileSync(file, 'utf8');

    // '208' now has something to copy, so this run reaches a checkpoint write.
    const second = deps({
      documents: fakeDocuments([...DOCS.filter(d => d.id !== 'd3'),
        { id: 'd3', projectId: '208', typeId: TYPE_ID }])
    });
    const realWrite = fs.writeFileSync;
    t2.mock.method(fs, 'writeFileSync', (target, data) => {
      // A kill lands with the first bytes on disk and the rest never written.
      realWrite(target, String(data).slice(0, 10));
      throw new Error('killed mid-write');
    });

    await assert.rejects(() => backfill(['--live', '--state', file], second), /killed mid-write/);
    t2.mock.restoreAll();

    assert.strictEqual(fs.readFileSync(file, 'utf8'), before,
      'the half-written state replaced the checkpoint that was already there');
    assert.deepStrictEqual(Object.keys(JSON.parse(before).walked).sort(), ['', '207'],
      'and what survived is still the checkpoint, not a fragment that happens to match');
  });

  await t.test('the corpus total is snapshotted on the first run', async () => {
    // The number a resume is held to, and the moment it was taken — without the second, an
    // operator reading an INCOMPLETE cannot tell how much ingest has happened since.
    const file = stateFile();
    await backfill(['--live', '--state', file], deps());

    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(state.expected, 4);
    assert.match(state.expectedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  await t.test('documents ingested since the backfill started do not fail a resume', async () => {
    // Chunks ingested after the start are stamped at ingest, so coverage is measured against the
    // starting snapshot, not a fresh count.
    const file = stateFile();
    await backfill(['--live', '--state', file], deps());

    const second = deps({
      documents: fakeDocuments([...DOCS, { id: 'd9', projectId: '207', typeId: TYPE_ID }])
    });
    const summary = await backfill(['--live', '--state', file], second);

    assert.strictEqual(summary.expectedNow, 5, 'the corpus grew under the backfill');
    assert.strictEqual(summary.expected, 4, 'and coverage is measured against what it was');
    assert.strictEqual(summary.documents + summary.checkpointed, 4);
    assert.strictEqual(exitCodeFor(summary), 0);
  });

  await t.test('both numbers are logged when the corpus has moved', async (t2) => {
    const file = stateFile();
    await backfill(['--live', '--state', file], deps());
    const said = [];
    t2.mock.method(logger, 'info', (message) => said.push(String(message)));

    await backfill(['--live', '--state', file], deps({
      documents: fakeDocuments([...DOCS, { id: 'd9', projectId: '207', typeId: TYPE_ID }])
    }));
    t2.mock.restoreAll();

    const line = said.find(m => m.includes('5 documents now'));
    assert.ok(line, `the two totals were not reported: ${said.join(' | ')}`);
    assert.ok(line.includes('4 when this backfill started'), line);
  });

  await t.test('a resume that is short against the SNAPSHOT still exits 1', async () => {
    // The snapshot is not an amnesty: a partition that was never enumerated is still a hole, and
    // the run must not exit 0 over it however much the corpus has grown since.
    const file = stateFile();
    await backfill(['--live', '--state', file], deps());

    const second = deps({
      documents: fakeDocuments([...DOCS, { id: 'd9', projectId: '207', typeId: TYPE_ID }])
    });
    second.documents.listDistinctProjectIds = async () => ['', '207'];
    const summary = await backfill(['--live', '--state', file], second);

    assert.strictEqual(summary.documents, 0, 'both enumerated partitions were already done');
    assert.strictEqual(summary.checkpointed, 3);
    assert.strictEqual(summary.expected, 4);
    assert.strictEqual(exitCodeFor(summary), 1);
  });

  await t.test('a state file with no snapshot keeps the fail-closed comparison', async () => {
    // With no snapshot, a fresh count is the only baseline. It is not saved as the snapshot, since
    // that run never measured it.
    const file = stateFile();
    fs.writeFileSync(file, JSON.stringify({ done: ['208'], walked: { 208: 1 } }));

    const d = deps({
      documents: fakeDocuments([...DOCS, { id: 'd9', projectId: '209', typeId: TYPE_ID }])
    });
    d.documents.listDistinctProjectIds = async () => ['', '207', '208'];
    const summary = await backfill(['--live', '--state', file], d);

    assert.strictEqual(summary.expected, 5, 'a fresh count, because the file carries no snapshot');
    assert.strictEqual(exitCodeFor(summary), 1);
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).expected, undefined,
      'a mid-backfill count must not be adopted as the baseline');
  });

  await t.test('--pending repairs a document whose projectId is null', async () => {
    // `String(null)` is `'null'`, a partition no document lives in.
    const d = deps({
      documents: fakeDocuments([
        { id: 'd1', projectId: '207', typeId: TYPE_ID },
        { id: 'd6', projectId: null, typeId: TYPE_ID, parentFieldsPending: true }
      ])
    });
    const summary = await backfill(['--live', '--pending', '--state', stateFile()], d);

    assert.deepStrictEqual(d.documents.state.partitions, [NULL_PARTITION]);
    assert.deepStrictEqual(d.chunks.state.patched, ['d6']);
    assert.strictEqual(summary.pendingCleared, 1);
    assert.deepStrictEqual(d.documents.state.pendingWrites,
      [{ id: 'd6', projectId: null, pending: false, pendingAt: PENDING_AT }]);
  });

  await t.test('--pending leaves the flag raised when the row moved under the run', async () => {
    // A newer write raised the flag for chunks this run never saw; clearing it would hide drift.
    const d = deps({
      documents: fakeDocuments([
        { id: 'd1', projectId: '207', typeId: TYPE_ID, parentFieldsPending: true },
        { id: 'd2', projectId: '207', milestoneId: 'm1', parentFieldsPending: true }
      ], { movedOn: ['d1'] })
    });
    const summary = await backfill(['--live', '--pending', '--state', stateFile()], d);

    assert.strictEqual(summary.pendingConflicts, 1);
    assert.strictEqual(summary.pendingCleared, 1, 'the other document is still cleared');
    assert.deepStrictEqual(d.documents.state.pendingWrites.map(w => w.id), ['d2']);
  });

  await t.test('--project clears the flag on every document it verified', async () => {
    // The repair the poison alert names; it holds the same proof as `--pending`.
    const d = deps({
      documents: fakeDocuments([
        // Stale chunks, so it is patched here.
        { id: 'd1', projectId: '207', typeId: TYPE_ID, parentFieldsPending: true },
        // Flagged, but something else already fixed its chunks: proof is proof.
        { id: 'd2', projectId: '207', typeId: TYPE_ID, parentFieldsPending: true },
        // Never flagged: no write belongs to it at all.
        { id: 'd3', projectId: '207', milestoneId: 'm1' }
      ]),
      chunks: fakeChunks({
        rows: { d2: [{ id: 'd2::p1::c0', projectId: '207', typeId: TYPE_ID,
          parentFieldsVersion: V }] }
      })
    });
    const summary = await backfill(['--live', '--project', '207', '--state', stateFile()], d);

    assert.deepStrictEqual(d.documents.state.pendingWrites.map(w => w.id).sort(), ['d1', 'd2']);
    assert.strictEqual(summary.pendingCleared, 2);
    assert.deepStrictEqual(d.documents.state.pendingWrites.map(w => w.pendingAt),
      [PENDING_AT, PENDING_AT], 'the clear must carry the token the flag was raised with');
  });

  await t.test('a document whose chunks were lost keeps its flag while its neighbours lose theirs',
    async () => {
      // Per document: one lost chunk must not keep every other document flagged.
      const d = deps({
        documents: fakeDocuments([
          { id: 'd1', projectId: '207', typeId: TYPE_ID, parentFieldsPending: true },
          { id: 'd2', projectId: '207', milestoneId: 'm1', parentFieldsPending: true }
        ]),
        chunks: fakeChunks({ failOn: ['d1'] })
      });
      const summary = await backfill(['--live', '--project', '207', '--state', stateFile()], d);

      assert.deepStrictEqual(d.documents.state.pendingWrites.map(w => w.id), ['d2']);
      assert.strictEqual(summary.pendingCleared, 1);
      assert.strictEqual(summary.failedDocuments, 1);
      assert.strictEqual(exitCodeFor(summary), 1, 'the lost chunk is still a failure');
    });

  await t.test('a flag whose row the clear cannot find is counted and exits non-zero', async () => {
    // The row is gone, or lives under another key; the flag is still up.
    const d = deps({
      documents: fakeDocuments([
        { id: 'd1', projectId: '207', typeId: TYPE_ID, parentFieldsPending: true }
      ], { missingOn: ['d1'] })
    });
    const summary = await backfill(['--live', '--pending', '--state', stateFile()], d);

    assert.strictEqual(summary.pendingMissed, 1);
    assert.strictEqual(summary.pendingCleared, 0);
    assert.strictEqual(exitCodeFor(summary), 1);
  });

  await t.test('--pending counts and names the flagged rows the walk never reached', async (t2) => {
    // The row's partition key changed after `listParentFieldsPending`, so the walk never sees it.
    const documents = fakeDocuments([
      { id: 'd1', projectId: '207', typeId: TYPE_ID, parentFieldsPending: true }
    ]);
    documents.listParentFieldsPending = async () => [
      { id: 'd1', projectId: '207' },
      { id: 'd9', projectId: '207' }
    ];
    const said = [];
    t2.mock.method(logger, 'error', (message) => said.push(String(message)));

    const summary = await backfill(['--live', '--pending', '--state', stateFile()],
      deps({ documents }));

    assert.strictEqual(summary.pendingLeftRaised, 1);
    assert.strictEqual(summary.pendingCleared, 1, 'the document the walk did reach is cleared');
    assert.strictEqual(exitCodeFor(summary), 1);
    assert.ok(said.some(line => line.includes('d9') && !line.includes('d1')),
      `the id has to be named for anyone to repair it: ${said.join(' | ')}`);
  });

  await t.test('--pending is clean when every flagged row was reached', async () => {
    const summary = await backfill(['--live', '--pending', '--state', stateFile()], deps({
      documents: fakeDocuments([
        { id: 'd1', projectId: '207', typeId: TYPE_ID, parentFieldsPending: true }
      ])
    }));

    assert.strictEqual(summary.pendingLeftRaised, 0);
    assert.strictEqual(exitCodeFor(summary), 0);
  });

  await t.test('a dry --pending run is not held to a flag it was never going to clear', async () => {
    const summary = await backfill(['--pending', '--state', stateFile()], deps({
      documents: fakeDocuments([
        { id: 'd1', projectId: '207', typeId: TYPE_ID, parentFieldsPending: true }
      ])
    }));

    assert.strictEqual(summary.pendingLeftRaised, 0);
    assert.strictEqual(exitCodeFor(summary), 0);
  });

  await t.test('deletes the index rows whose Cosmos chunk is gone', async () => {
    // The indexer never sees deletes, so such rows stay unstamped and hold back facets.
    const search = fakeSearch({
      rows: {
        207: [
          // Gone from Cosmos: its document keeps only ::c0.
          { id: 'a2V5MQ', chunkId: 'd1::p1::c9', documentId: 'd1' },
          // Merely unstamped — the indexer has not caught up with the patch this run just made.
          { id: 'a2V5Mg', chunkId: 'd1::p1::c0', documentId: 'd1' },
          // In Cosmos, but under a document this partition never walked: not an orphan, and only
          // the point read can tell.
          { id: 'a2V5Mw', chunkId: 'd3::p1::c0', documentId: 'd3' }
        ]
      }
    });
    const summary = await backfill(['--live', '--project', '207', '--state', stateFile()],
      deps({ search }));

    assert.deepStrictEqual(search.state.deleted, ['a2V5MQ']);
    assert.strictEqual(summary.orphansFound, 1);
    assert.strictEqual(summary.orphansPurged, 1);
    assert.strictEqual(summary.orphansFailed, 0);
    assert.deepStrictEqual(search.state.queried,
      [{ version: V, projectId: '207', maxRows: 2000 }]);
  });

  await t.test('a dry run reports the orphans and deletes none', async () => {
    const search = fakeSearch({
      rows: { 207: [{ id: 'a2V5MQ', chunkId: 'd1::p1::c9', documentId: 'd1' }] }
    });
    const summary = await backfill(['--project', '207', '--state', stateFile()], deps({ search }));

    assert.strictEqual(summary.orphansFound, 1);
    assert.strictEqual(summary.orphansPurged, 0);
    assert.deepStrictEqual(search.state.deleted, []);
  });

  await t.test('a row the service refused to delete is counted, not claimed', async () => {
    // It stays searchable and unstamped, so the count it holds up is still held up. Reporting it
    // as purged is how a run that fixed nothing reads as a run that fixed everything.
    const search = fakeSearch({
      rows: { 207: [{ id: 'a2V5MQ', chunkId: 'd1::p1::c9', documentId: 'd1' }] },
      failDelete: ['a2V5MQ']
    });
    const summary = await backfill(['--live', '--project', '207', '--state', stateFile()],
      deps({ search }));

    assert.strictEqual(summary.orphansPurged, 0);
    assert.strictEqual(summary.orphansFailed, 1);
  });

  await t.test('--pending never purges, because it walks a handful of documents', async () => {
    // Its chunk ids say nothing about which of the partition's index rows have a chunk behind
    // them, so every row of every document it skipped would look orphaned.
    const search = fakeSearch({
      rows: { 207: [{ id: 'a2V5MQ', chunkId: 'd1::p1::c0', documentId: 'd1' }] }
    });
    await backfill(['--live', '--pending', '--state', stateFile()], deps({
      documents: fakeDocuments([{ id: 'd2', projectId: '207', milestoneId: 'm1',
        parentFieldsPending: true }]),
      search
    }));

    assert.deepStrictEqual(search.state.queried, []);
    assert.deepStrictEqual(search.state.deleted, []);
  });

  await t.test('an index that cannot say which rows are unstamped is never purged from', async () => {
    // "Cannot say" is not "none": those rows are still there and still unstamped. A live run that
    // reported zero orphans found and exited 0 said the purge had happened.
    const search = fakeSearch({ cannotSay: true });
    const summary = await backfill(['--live', '--project', '207', '--state', stateFile()],
      deps({ search }));

    assert.deepStrictEqual(search.state.deleted, []);
    assert.strictEqual(summary.orphansFound, 0);
    assert.strictEqual(summary.orphansSkipped, 1);
    assert.match(summary.orphansSkippedReason, /parentFieldsVersion/);
    assert.strictEqual(exitCodeFor(summary), 1, 'a live run whose purge never ran must not exit 0');
  });

  await t.test('a dry run whose orphan scan could not run still exits 0', async () => {
    // Nothing was going to be deleted, so nothing was left undone — holding the dry run to it
    // would make the reading pass of every unconfigured environment look like a failure.
    const summary = await backfill(['--project', '207', '--state', stateFile()],
      deps({ search: fakeSearch({ cannotSay: true }) }));

    assert.strictEqual(summary.orphansSkipped, 1);
    assert.strictEqual(exitCodeFor(summary), 0);
  });

  await t.test('a dry run leaves no checkpoint behind', async () => {
    // A checkpoint written by a dry run would make the live run that follows skip everything.
    const file = stateFile();
    await backfill(['--state', file], deps());

    assert.strictEqual(fs.existsSync(file), false);
  });
});

test('every stamp is guarded on an instant, so a walk cannot overwrite a newer one', async (t) => {
  const START = '2026-09-09T11:00:00.000Z';

  await t.test('a flagged row uses its flag token, every other row the walk start', async () => {
    // The walk start, not the partition's turn, lets a long corpus pass lose to later re-stamps.
    const d = deps({
      documents: fakeDocuments([
        { id: 'd1', projectId: '207', typeId: TYPE_ID, parentFieldsPending: true },
        { id: 'd2', projectId: '207', milestoneId: 'm1' }
      ])
    });
    await backfill(['--live', '--state', stateFile()], { ...d, now: START });

    assert.deepStrictEqual(d.chunks.state.stamps, { d1: PENDING_AT, d2: START });
  });

  await t.test('the retry budget reaches the chunk patch, default and raised', async () => {
    // The whole point of `--max-attempts`. A budget parsed and then dropped on the way to the patch
    // looks exactly like one that arrived: the walk runs, and gives up on the same throttle.
    const d = deps();
    await backfill(['--live', '--state', stateFile()], d);

    assert.ok(d.chunks.state.budgets.length > 0, 'the walk patched nothing, so nothing was proven');
    assert.deepStrictEqual([...new Set(d.chunks.state.budgets)], [DEFAULT_MAX_ATTEMPTS],
      'every patch runs on this walk\'s budget, not the request-path default');

    const raised = deps();
    await backfill(['--live', '--max-attempts', '20', '--state', stateFile()], raised);

    assert.deepStrictEqual([...new Set(raised.chunks.state.budgets)], [20],
      'the operator raised the budget for a walk that keeps running out of it');

    // The budget alone does not outlast a throttle: the request-path ceiling would clip a 45s hint
    // back to 20s and spend an attempt resending into a partition Cosmos said has no budget.
    assert.deepStrictEqual([...new Set(d.chunks.state.backoffCeilings)], [60000],
      'the walk waits out a hint the request paths are not allowed to');
  });

  await t.test('chunks a newer walk already stamped are reported, not counted as patched',
    async () => {
      // 412 means a newer stamp is there: not a failure, but counted so the summary adds up.
      const d = deps({
        documents: fakeDocuments([
          { id: 'd1', projectId: '207', typeId: TYPE_ID, parentFieldsPending: true }
        ]),
        chunks: fakeChunks({ skipNewerOn: ['d1'] })
      });
      const summary = await backfill(['--live', '--pending', '--state', stateFile()], d);

      assert.strictEqual(summary.skippedNewer, 1);
      assert.strictEqual(summary.patched, 0);
      assert.strictEqual(summary.failedChunks, 0);
      assert.strictEqual(summary.pendingCleared, 1);
      assert.strictEqual(exitCodeFor(summary), 0);
    });
});

test('exitCodeFor is non-zero when a chunk was lost', () => {
  // A wrapper reading 0 would take it as "every chunk filter works now"; the unwritten chunks are
  // exactly the ones that answer no filter at all, under a 200.
  assert.strictEqual(exitCodeFor({ documents: 0, failedDocuments: 0, failedChunks: 0 }), 0);
  assert.strictEqual(exitCodeFor({ documents: 0, failedDocuments: 0, failedChunks: 1 }), 1);
  assert.strictEqual(exitCodeFor({ documents: 0, failedDocuments: 1, failedChunks: 0 }), 1);
});

test('exitCodeFor covers the work a run left undone', async (t) => {
  const clean = { documents: 0, failedDocuments: 0, failedChunks: 0, mode: 'live' };

  await t.test('a pending flag the clear could not find is a failure', () => {
    assert.strictEqual(exitCodeFor({ ...clean, pendingMissed: 1 }), 1);
    // A flag left for a newer write is not: that write is the one that clears it.
    assert.strictEqual(exitCodeFor({ ...clean, pendingConflicts: 2 }), 0);
  });

  await t.test('an orphan purge that did not finish is a failure on a live run only', () => {
    assert.strictEqual(exitCodeFor({ ...clean, orphansSkipped: 1 }), 1);
    assert.strictEqual(exitCodeFor({ ...clean, orphansFailed: 1 }), 1);
    assert.strictEqual(exitCodeFor({ ...clean, mode: 'dry-run', orphansSkipped: 1 }), 0);
    assert.strictEqual(exitCodeFor({ ...clean, mode: 'dry-run', orphansFailed: 1 }), 0);
  });
});

test('exitCodeFor holds a RESUMED run to the corpus total', async (t) => {
  await t.test('the checkpointed counts make up the difference', () => {
    assert.strictEqual(exitCodeFor({ documents: 200, checkpointed: 400, resumed: 3, expected: 600 }),
      0);
  });

  await t.test('a resumed run that is short still exits 1', () => {
    // The bug this replaced: `resumed > 0` skipped the check outright, so a resume that reached two
    // partitions of a thousand printed its figures and exited 0.
    assert.strictEqual(exitCodeFor({ documents: 20, checkpointed: 400, resumed: 3, expected: 600 }),
      1);
  });

  await t.test('documents deleted between runs are not a missed partition', () => {
    // `covered` exceeding a freshly-taken `expected` means rows went away since the checkpoint —
    // failing on it would make every long resume look broken.
    assert.strictEqual(exitCodeFor({ documents: 200, checkpointed: 450, resumed: 3, expected: 600 }),
      0);
  });
});
