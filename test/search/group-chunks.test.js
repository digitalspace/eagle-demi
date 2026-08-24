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

  // WHERE THE CHIPS COME FROM, and specifically that a neighbouring date cannot stand in.
  // `dateUploaded` is a real, populated sibling on every document (`src/seed/transform.js:124`),
  // so `row.datePosted || row.dateUploaded || null` would render a WRONG BUT PLAUSIBLE date on
  // every card whose document has no posting date — nothing looks broken, which for a public
  // registry is the worst shape a defect can take. That mutation used to survive the whole suite.
  await t.test('datePosted comes from datePosted alone, never a neighbouring date', () => {
    const [row] = groupByDocument([{
      ...chunk('d1', 1, 'lead'),
      dateUploaded: '2020-01-01T00:00:00.000Z'
    }]);
    assert.strictEqual(row.datePosted, null,
      'a document with no posting date has none — the upload date is a different fact');
    assert.strictEqual(row.dateUploaded, undefined, 'and it is not passed through under its own name');

    const [posted] = groupByDocument([{
      ...chunk('d1', 1, 'lead'),
      datePosted: '2018-07-31T06:40:37.626Z',
      dateUploaded: '2020-01-01T00:00:00.000Z'
    }]);
    assert.strictEqual(posted.datePosted, '2018-07-31T06:40:37.626Z',
      'and when both exist the posting date wins, not merely "some date is present"');
  });

  // The chip renders `{{result().milestone}}` raw, so this key carries the LABEL — the one place a
  // chunk row deliberately differs from a Document row, where the same key is the List ObjectId.
  await t.test('milestone is the label and milestoneId the id, both carried', () => {
    const [row] = groupByDocument([{
      ...chunk('d1', 1, 'lead'),
      milestone: 'Other', milestoneId: '5d0d212c7d50161b92a80eed'
    }]);
    assert.strictEqual(row.milestone, 'Other', 'an id here puts a GUID on screen');
    assert.strictEqual(row.milestoneId, '5d0d212c7d50161b92a80eed');
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

  // Prod eagle-search renders a date chip on every chunk card and a milestone chip on a third of
  // them; demi rendered neither, because these two never left the parent document. Values written
  // out rather than read off the input, and named the way the Document dataset names them — a
  // consumer must not have to special-case a chunk row.
  await t.test('the parent document date and milestone reach the grouped row', () => {
    const [row] = groupByDocument([{
      ...chunk('d1', 1, 'lead'),
      milestone: '5cf00c03a266b7e1877504ca',
      datePosted: '2019-05-30T07:00:00.000Z'
    }]);
    assert.strictEqual(row.milestone, '5cf00c03a266b7e1877504ca',
      'the List ObjectId, not the label beside it — Amendment is two rows across the two Acts');
    assert.strictEqual(row.datePosted, '2019-05-30T07:00:00.000Z');
  });

  await t.test('a document with neither still carries both keys, explicitly null', () => {
    const [row] = groupByDocument([chunk('d1', 1, 'lead')]);
    assert.strictEqual(row.milestone, null, 'null, never undefined — the key must not vanish');
    assert.strictEqual(row.datePosted, null);
    assert.ok('milestone' in row && 'datePosted' in row);
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
