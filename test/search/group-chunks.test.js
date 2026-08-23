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

  // THE DEFECT THAT MADE THIS DIVERGE FROM THE ORIGINAL. eagle-search slices the grouped rows to
  // `pageSize`; the caller pages by WINDOW, so a document grouped out of the window and then sliced
  // off the end is skipped past on the next page and reachable from none. Measured on a
  // 300-passage / 150-document corpus at pageSize=10: page 0 ended at d9, page 1 began at d50, and
  // 30 of 150 documents were servable in total. Every document its window covered comes back.
  await t.test('every document in the window is returned — no slice, nothing unreachable', () => {
    const rows = groupByDocument(
      [chunk('d1', 1, 'a'), chunk('d1', 2, 'b'), chunk('d2', 1, 'c'), chunk('d3', 1, 'd')]);
    assert.deepStrictEqual(rows.map(r => r._id), ['d1', 'd2', 'd3'],
      'a page carries every document its window covered, not the first pageSize of them');
    assert.strictEqual(rows[0].matchCount, 2, 'both d1 chunks counted, not just the first');
  });

  await t.test('a chunk with no parent id is skipped, never grouped under empty', () => {
    const rows = groupByDocument([{ _id: 'x', snippet: 'a' }, chunk('d1', 1, 'b')], 10);
    assert.deepStrictEqual(rows.map(r => r._id), ['d1']);
  });
});

// Hardcoded, NOT computed from FANOUT: importing the constant under test makes the assertion true
// by construction. Mutating FANOUT to 5 left this file green until these numbers were written out.
test('windowFor — the fetch unit is a window of chunks', () => {
  assert.strictEqual(windowFor(10), 100);
  assert.strictEqual(windowFor(1), 10);
  assert.strictEqual(windowFor(0), 10, 'a zero page still fetches a window');
  assert.strictEqual(FANOUT, 10, 'the two numbers above are this one; change both or neither');
});

// The clamp is the FETCH ceiling, not Azure's `$top` limit. `runSearch` silently clamps a larger
// `top` to MAX_PAGE_ROWS while `skip` still advances by the full window, so chunks past the clamp
// are never requested and the documents in them are unreachable from any page.
test('windowFor clamps to what the fetch layer will actually ask for', () => {
  assert.strictEqual(windowFor(100, 500), 500, 'not 1000 — runSearch would only fetch 500');
  assert.strictEqual(windowFor(500, 500), 500);
  assert.strictEqual(windowFor(10, 500), 100, 'under the ceiling, the window is untouched');
});
