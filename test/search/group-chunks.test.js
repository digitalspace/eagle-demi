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
      [chunk('d2', 1, 'a'), chunk('d1', 1, 'b'), chunk('d2', 2, 'c')]);
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
    const [row] = groupByDocument([chunk('d1', 4, 'lead'), chunk('d1', 9, 'second')]);
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

  // KNOWN AND NOT FIXED, pinned so nobody reads the module as covering it. Grouping happens per
  // window with no carry-over, so a document whose passages straddle a window boundary comes back
  // on both pages with a partial count on each. Statelessness is what buys that; a true per-document
  // total needs a second aggregate query or a cursor. The test asserts the CURRENT behaviour — if
  // it starts failing, someone made paging stateful and this comment is the thing to re-read.
  await t.test('a document straddling two windows is counted per window, not per corpus', () => {
    const windowOne = groupByDocument([chunk('d9', 99, 'first half')]);
    const windowTwo = groupByDocument([chunk('d9', 100, 'second half')]);
    assert.strictEqual(windowOne[0].matchCount, 1);
    assert.strictEqual(windowTwo[0].matchCount, 1, 'two rows for one document, 1 + 1, never 2');
    assert.strictEqual(windowOne[0]._id, windowTwo[0]._id);
  });

  await t.test('a chunk with no parent id is skipped, never grouped under empty', () => {
    const rows = groupByDocument([{ _id: 'x', snippet: 'a' }, chunk('d1', 1, 'b')]);
    assert.deepStrictEqual(rows.map(r => r._id), ['d1']);
  });
});

// Hardcoded, NOT computed from FANOUT: importing the constant under test makes the assertion true
// by construction. Mutating FANOUT to 5 left this file green until these numbers were written out.
test('windowFor — the fetch unit is a window of chunks', () => {
  assert.strictEqual(windowFor(10, 250), 100);
  assert.strictEqual(windowFor(1, 250), 10);
  assert.strictEqual(windowFor(0, 250), 10, 'a zero page still fetches a window');
  assert.strictEqual(FANOUT, 10, 'the numbers above are this one; change both or neither');
});

// No default ceiling, on purpose: a default would be a second copy of a constant that lives in
// ai-search, silently wrong the day that one moves — which is the exact failure the clamp exists
// to prevent. A caller that forgets it is told, not quietly given a guess.
test('windowFor refuses to guess the ceiling', () => {
  assert.throws(() => windowFor(10), /fetch ceiling/);
  assert.throws(() => windowFor(10, 0), /fetch ceiling/);
});

// The clamp is the FETCH ceiling, not Azure's `$top` limit. `runSearch` silently clamps a larger
// `top` to MAX_PAGE_ROWS while `skip` still advances by the full window, so chunks past the clamp
// are never requested and the documents in them are unreachable from any page.
test('windowFor clamps to what the fetch layer will actually ask for', () => {
  assert.strictEqual(windowFor(100, 250), 250, 'not 1000 — runSearch would fetch far less');
  assert.strictEqual(windowFor(500, 250), 250);
  assert.strictEqual(windowFor(10, 250), 100, 'under the ceiling, the window is untouched');
});
