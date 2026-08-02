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

test('parseArgs defaults to a dry run over every extracted document', () => {
  assert.deepStrictEqual(parseArgs([]), { live: false, errorsOnly: false, errorLike: '', pageSize: 200 });
});

test('parseArgs requires --live to write and validates --page-size', () => {
  assert.strictEqual(parseArgs(['--live']).live, true);
  assert.strictEqual(parseArgs(['--errors-only']).errorsOnly, true);
  assert.strictEqual(parseArgs(['--page-size', '50']).pageSize, 50);
  assert.throws(() => parseArgs(['--page-size', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--page-size', 'abc']), /positive integer/);
  assert.throws(() => parseArgs(['--wipe-everything']), /unknown argument/);
});

test('a dry run counts chunks but writes nothing', async () => {
  const docs = fakeDocuments(DOCS);
  const chunks = fakeChunks(PER_DOC);
  const index = fakeTypesense();

  const summary = await purge([], { documents: docs, chunks, index });

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

  const summary = await purge(['--live'], { documents: docs, chunks, index });

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

  const summary = await purge(['--live'], { documents: docs, chunks, index });

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

// A recorded failure sets contentExtracted TOO, so the query cannot tell the two apart. These are
// the documents the extraction host parked as permanent failures — 855 in the 2026-07-30 cascade,
// 5,908 after the 2026-08-02 full-corpus run.
const MIXED = [
  { id: 'ok1', projectId: '207' },
  { id: 'failed', projectId: '207', contentExtractionError: 'docling-serve HTTP 500' },
  { id: 'ok2', projectId: '311', contentExtractionError: null }
];

// Two failure classes side by side, which is the state the corpus is actually in: 5,802 documents
// whose source 404s (false — the dev object store is a partial copy) against ~106 that are
// genuinely unreadable. `--errors-only` cannot tell them apart.
const TWO_CLASSES = [
  { id: 'ok1', projectId: '207' },
  { id: 'gone1', projectId: '207', contentExtractionError: 'download failed: 404 Client Error: Not Found for url: https://x/a?X-Amz-Signature=abc' },
  { id: 'gone2', projectId: '311', contentExtractionError: 'download failed: 404 Client Error: Not Found for url: https://x/b?X-Amz-Signature=def' },
  { id: 'broken', projectId: '311', contentExtractionError: 'unsupported format: msg' }
];
const TWO_CLASSES_CHUNKS = { ok1: 10, gone1: 0, gone2: 0, broken: 0 };

test('--errors-only leaves a successfully extracted document completely alone', async () => {
  // The whole point of the flag. Without it the only lever is a blanket purge that deletes every
  // good chunk in the corpus to requeue the failures.
  const docs = fakeDocuments(MIXED);
  const chunks = fakeChunks({ ok1: 10, failed: 0, ok2: 7 });
  const index = fakeTypesense();

  const summary = await purge(['--live', '--errors-only'], { documents: docs, chunks, index });

  assert.deepStrictEqual(docs.state.patched.map(p => p.id), ['failed']);
  assert.deepStrictEqual(chunks.state.removed, ['failed']);
  assert.deepStrictEqual(index.state.deleted, ['failed']);
  assert.strictEqual(summary.documents, 1);
  assert.strictEqual(summary.chunksRemoved, 0);   // a failure wrote no chunks
});

test('--errors-only reports what it skipped, so a dry run is readable as a count', async () => {
  // "1 of 3" is the check before the live run: it must be the failure count, not the corpus.
  const docs = fakeDocuments(MIXED);
  const summary = await purge(['--errors-only'], {
    documents: docs, chunks: fakeChunks({ ok1: 10, failed: 0, ok2: 7 }), index: fakeTypesense()
  });

  assert.strictEqual(summary.errorsOnly, true);
  assert.strictEqual(summary.scanned, 3);
  assert.strictEqual(summary.documents, 1);
});

test('parseArgs: --error-like implies --errors-only and refuses an empty substring', () => {
  const args = parseArgs(['--error-like', 'download failed: 404']);
  assert.strictEqual(args.errorLike, 'download failed: 404');
  // Implied, not required alongside. Asking for one class of failure already says "failures only".
  assert.strictEqual(args.errorsOnly, true);
  // An empty substring matches every error — `--errors-only` in disguise, and the disguise is the
  // danger: the operator asked to narrow the set and would silently get all of it.
  assert.throws(() => parseArgs(['--error-like', '']), /non-empty substring/);
});

test('--error-like purges one class of failure and leaves the other classes alone', async () => {
  // The check that matters: without it, requeuing the 5,802 false 404s also sends every genuine
  // failure back through the GPU to fail again in exactly the same way.
  const docs = fakeDocuments(TWO_CLASSES);
  const chunks = fakeChunks(TWO_CLASSES_CHUNKS);
  const index = fakeTypesense();

  const summary = await purge(['--live', '--error-like', 'download failed: 404'],
    { documents: docs, chunks, index });

  assert.deepStrictEqual(docs.state.patched.map(p => p.id), ['gone1', 'gone2']);
  assert.deepStrictEqual(chunks.state.removed, ['gone1', 'gone2']);
  assert.strictEqual(summary.scanned, 4);
  assert.strictEqual(summary.documents, 2);
});

test('--errors-only without --error-like still takes every failure, both classes', async () => {
  // The other half of the distinction. If this ever stops being true the new flag has quietly
  // become mandatory, and every existing recovery recipe is wrong.
  const docs = fakeDocuments(TWO_CLASSES);
  const summary = await purge(['--errors-only'], {
    documents: docs, chunks: fakeChunks(TWO_CLASSES_CHUNKS), index: fakeTypesense()
  });
  assert.strictEqual(summary.documents, 3);
});

test('--error-like matches a substring, not the whole message', async () => {
  // Every real 404 message ends in a different presigned URL, so equality would match nothing and
  // report a clean "0 documents" — a purge that looks like it ran and did not.
  const docs = fakeDocuments(TWO_CLASSES);
  const summary = await purge([], {
    documents: docs, chunks: fakeChunks(TWO_CLASSES_CHUNKS), index: fakeTypesense()
  });
  assert.strictEqual(summary.documents, 4, 'guard: all four are visible without a filter');

  const exact = fakeDocuments(TWO_CLASSES);
  const whole = await purge(['--error-like', TWO_CLASSES[1].contentExtractionError], {
    documents: exact, chunks: fakeChunks(TWO_CLASSES_CHUNKS), index: fakeTypesense()
  });
  assert.strictEqual(whole.documents, 1, 'a full message matches only its own document');
});

test('without --errors-only every extracted document is still purged', async () => {
  const docs = fakeDocuments(MIXED);
  const summary = await purge(['--live'], {
    documents: docs, chunks: fakeChunks({ ok1: 10, failed: 0, ok2: 7 }), index: fakeTypesense()
  });

  assert.deepStrictEqual(docs.state.patched.map(p => p.id), ['ok1', 'failed', 'ok2']);
  assert.strictEqual(summary.scanned, 3);
  assert.strictEqual(summary.documents, 3);
});
