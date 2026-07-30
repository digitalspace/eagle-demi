'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { parseArgs, purge, CLEARED_EXTRACTION } = require('../../src/scripts/purge-extraction');
const { TIER } = require('../../src/helpers/access-sql');

/** Documents repository double. Pages through `docs` so the continuation-token loop is exercised. */
function fakeDocuments(docs, opts = {}) {
  const state = { patched: [], listCalls: [] };
  return {
    state,
    async listVisible(access, listOpts) {
      state.listCalls.push({ access, listOpts });
      const start = listOpts.continuationToken ? Number(listOpts.continuationToken) : 0;
      const end = Math.min(start + listOpts.pageSize, docs.length);
      return {
        items: docs.slice(start, end),
        continuationToken: end < docs.length ? String(end) : undefined
      };
    },
    async patchExtraction(id, projectId, fields) {
      if (opts.failFlagsFor === id) throw new Error('patch boom');
      state.patched.push({ id, projectId, fields });
    }
  };
}

function fakeChunks(perDoc, opts = {}) {
  const state = { removed: [], counted: [] };
  return {
    state,
    async idsForDocument(access, documentId) {
      state.counted.push(documentId);
      return Array.from({ length: perDoc[documentId] || 0 }, (_, i) => `${documentId}::p0::c${i}`);
    },
    async removeForDocument(access, documentId) {
      if (opts.failFor === documentId) throw new Error('cosmos boom');
      state.removed.push(documentId);
      return { succeeded: perDoc[documentId] || 0, failed: opts.partialFor === documentId ? 2 : 0 };
    }
  };
}

function fakeTypesense() {
  const state = { deleted: [] };
  return {
    state,
    async deleteChunksForDocument(documentId) {
      state.deleted.push(documentId);
      return 3;
    }
  };
}

const DOCS = [
  { id: 'd1', projectId: '207' },
  { id: 'd2', projectId: '207' },
  { id: 'd3', projectId: '311' }
];
const PER_DOC = { d1: 10, d2: 5, d3: 7 };

test('parseArgs defaults to a dry run', () => {
  assert.deepStrictEqual(parseArgs([]), { live: false, pageSize: 200 });
});

test('parseArgs requires --live to write and validates --page-size', () => {
  assert.strictEqual(parseArgs(['--live']).live, true);
  assert.strictEqual(parseArgs(['--page-size', '50']).pageSize, 50);
  assert.throws(() => parseArgs(['--page-size', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--page-size', 'abc']), /positive integer/);
  assert.throws(() => parseArgs(['--wipe-everything']), /unknown argument/);
});

test('a dry run counts chunks but writes nothing', async () => {
  const docs = fakeDocuments(DOCS);
  const chunks = fakeChunks(PER_DOC);
  const index = fakeTypesense();

  const summary = await purge([], { documents: docs, chunks, typesense: index });

  assert.strictEqual(summary.mode, 'dry-run');
  assert.strictEqual(summary.documents, 3);
  assert.strictEqual(summary.chunksRemoved, 22);      // 10 + 5 + 7, the real number
  assert.deepStrictEqual(chunks.state.removed, []);   // nothing deleted
  assert.deepStrictEqual(docs.state.patched, []);     // no flags touched
  assert.deepStrictEqual(index.state.deleted, []);    // index untouched
});

test('a live run removes chunks, clears flags and drops index entries', async () => {
  const docs = fakeDocuments(DOCS);
  const chunks = fakeChunks(PER_DOC);
  const index = fakeTypesense();

  const summary = await purge(['--live'], { documents: docs, chunks, typesense: index });

  assert.strictEqual(summary.mode, 'live');
  assert.strictEqual(summary.chunksRemoved, 22);
  assert.strictEqual(summary.indexEntriesRemoved, 9); // 3 per document
  assert.deepStrictEqual(chunks.state.removed, ['d1', 'd2', 'd3']);
  assert.deepStrictEqual(index.state.deleted, ['d1', 'd2', 'd3']);
  assert.deepStrictEqual(summary.failures, []);

  // The partition key must be the document's own project, or the patch silently misses.
  assert.deepStrictEqual(docs.state.patched.map(p => [p.id, p.projectId]),
    [['d1', '207'], ['d2', '207'], ['d3', '311']]);
  for (const p of docs.state.patched) {
    assert.deepStrictEqual(p.fields, CLEARED_EXTRACTION);
  }
});

test('clearing contentExtracted is what re-enters a document into the work list', () => {
  // If this ever stops being false, the purge deletes chunks and the extractor never rebuilds them.
  assert.strictEqual(CLEARED_EXTRACTION.contentExtracted, false);
  assert.strictEqual(CLEARED_EXTRACTION.contentPageCount, 0);
  assert.strictEqual(CLEARED_EXTRACTION.contentExtractionError, null);
});

test('a document whose chunks fail to delete keeps its flags', async () => {
  // The dangerous outcome: chunks still in Cosmos but the document advertised as unextracted.
  // Re-ingest would then reconcile against rows nobody knows are there.
  const docs = fakeDocuments(DOCS);
  const chunks = fakeChunks(PER_DOC, { failFor: 'd2' });
  const index = fakeTypesense();

  const summary = await purge(['--live'], { documents: docs, chunks, typesense: index });

  assert.deepStrictEqual(docs.state.patched.map(p => p.id), ['d1', 'd3']);
  assert.deepStrictEqual(index.state.deleted, ['d1', 'd3']);
  assert.strictEqual(summary.failures.length, 1);
  assert.strictEqual(summary.failures[0].id, 'd2');
  assert.strictEqual(summary.failures[0].stage, 'chunks');
});

test('a partial bulk failure is recorded rather than counted as success', async () => {
  const docs = fakeDocuments(DOCS);
  const chunks = fakeChunks(PER_DOC, { partialFor: 'd1' });

  const summary = await purge(['--live'], { documents: docs, chunks, typesense: fakeTypesense() });

  assert.strictEqual(summary.failures.length, 1);
  assert.match(summary.failures[0].message, /bulk operation/);
});

test('paging follows continuation tokens instead of reading one page', async () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ id: `x${i}`, projectId: '1' }));
  const docs = fakeDocuments(many);
  const chunks = fakeChunks({});

  const summary = await purge(['--live', '--page-size', '3'], {
    documents: docs, chunks, typesense: fakeTypesense()
  });

  assert.strictEqual(summary.documents, 7);
  assert.strictEqual(docs.state.listCalls.length, 3);   // 3 + 3 + 1
});

test('the purge reads with the privileged tier, or it orphans what it cannot see', async () => {
  // removeForDocument enumerates ids via idsForDocument. A scoped context would delete only the
  // visible chunks and still clear the flag — a silent partial purge.
  const docs = fakeDocuments(DOCS);
  await purge([], { documents: docs, chunks: fakeChunks(PER_DOC), typesense: fakeTypesense() });

  const { access } = docs.state.listCalls[0];
  assert.strictEqual(access.tier, TIER.PRIVILEGED);
  assert.strictEqual(access.projectScope, null);
});

test('only documents flagged contentExtracted are selected', async () => {
  const docs = fakeDocuments(DOCS);
  await purge([], { documents: docs, chunks: fakeChunks(PER_DOC), typesense: fakeTypesense() });
  assert.strictEqual(docs.state.listCalls[0].listOpts.extracted, true);
});
