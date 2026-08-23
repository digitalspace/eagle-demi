'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { groupByDocument, windowFor, FANOUT, MAX_SNIPPETS } = require('../../src/search/group-chunks');

const chunk = (doc, n, snippet) => ({
  _id: `${doc}::p${n}`, documentId: doc, projectId: '207', pageNumber: n,
  documentName: `${doc} name`, projectName: 'Site C', snippet
});

test('groupByDocument', async (t) => {
  await t.test('one row per document, ordered by the first hit', () => {
    const rows = groupByDocument(
      [chunk('d2', 1, 'a'), chunk('d1', 1, 'b'), chunk('d2', 2, 'c')], 10);
    assert.deepStrictEqual(rows.map(r => r._id), ['d2', 'd1'],
      'BM25 order is preserved — the first chunk sets its document position');
    assert.strictEqual(rows[0].matchCount, 2);
  });

  await t.test('snippets are capped, matchCount is not', () => {
    const rows = groupByDocument(
      Array.from({ length: 7 }, (_, i) => chunk('d1', i, `s${i}`)), 10);
    assert.strictEqual(rows[0].matchCount, 7);
    assert.strictEqual(rows[0].snippets.length, MAX_SNIPPETS);
  });

  // DEMI's own frontend reads `snippet`, `pageNumber` and the chunk id off these rows
  // (registry-state.service.ts:1160-1175). The grouped row carries BOTH shapes rather than
  // replacing one with the other, so no frontend release is coupled to this change.
  await t.test('the lead chunk keeps its singular shape for DEMI', () => {
    const [row] = groupByDocument([chunk('d1', 4, 'lead'), chunk('d1', 9, 'second')], 10);
    assert.strictEqual(row.snippet, 'lead');
    assert.strictEqual(row.pageNumber, 4);
    assert.strictEqual(row.chunkId, 'd1::p4');
    assert.strictEqual(row._id, 'd1', 'and _id is the DOCUMENT, which is what the card links to');
  });

  // Truncating chunk rows before grouping would drop matches and snippets from documents that are
  // still on the page — the count would then understate what the index found.
  await t.test('the PAGE SIZE truncates documents, not chunks', () => {
    const rows = groupByDocument(
      [chunk('d1', 1, 'a'), chunk('d1', 2, 'b'), chunk('d2', 1, 'c'), chunk('d3', 1, 'd')], 2);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].matchCount, 2, 'both of d1 chunks counted, not just the first');
  });

  await t.test('a chunk with no parent id is skipped, never grouped under empty', () => {
    const rows = groupByDocument([{ _id: 'x', snippet: 'a' }, chunk('d1', 1, 'b')], 10);
    assert.deepStrictEqual(rows.map(r => r._id), ['d1']);
  });
});

test('windowFor — the fetch unit is a window of chunks, clamped to Azure $top', () => {
  assert.strictEqual(windowFor(10), 10 * FANOUT);
  assert.strictEqual(windowFor(500), 1000, 'clamped: $top rejects more');
  assert.strictEqual(windowFor(0), FANOUT, 'a zero page still fetches a window');
});
