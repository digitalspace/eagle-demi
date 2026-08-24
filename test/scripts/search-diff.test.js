'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  CASES,
  PAGES,
  parseArgs,
  credential,
  expandCases,
  buildUrl,
  summarize,
  compareCase,
  selectivity,
  pagingReport,
  baselineOf,
  specKey,
  EXPECTED_DIVERGENCE,
} = require('../../src/scripts/search-diff');

// No network anywhere in this file. The transport fails loudly — a 401 or a DNS error is visible in
// the first line of a run — while the comparison can be wrong QUIETLY, reporting PASS on a contract
// that moved. Only the pure half is worth pinning, and it is the half the exit code comes from.

/** A response as `get()` builds one, from the row shapes both services actually returned today. */
const respond = (rows, total, status = 200) => ({
  status,
  payload: [{ searchResults: rows, count: total, meta: [{ searchResultsTotal: total }] }]
});

test('parseArgs takes the documented flags and refuses the rest', () => {
  assert.deepStrictEqual(parseArgs([]), { case: 0, json: false, delayMs: 250, pageSize: 10, user: '' });
  assert.strictEqual(parseArgs(['--case=7']).case, 7);
  assert.strictEqual(parseArgs(['--json']).json, true);
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
  assert.throws(() => parseArgs(['--case=-1']), /positive integer/);
  assert.throws(() => parseArgs(['--delay=x']), /milliseconds/);
  assert.throws(() => parseArgs(['--page-size=0']), /positive integer/);
});

test('a password holding an = survives --user, and --user beats the environment', () => {
  // Splitting on every '=' would truncate it and every demi request would 401 — with a credential
  // in play the failure has to be loud, not silently wrong.
  assert.strictEqual(parseArgs(['--user=bob:p=ss=word']).user, 'bob:p=ss=word');
  const env = { DEMI_DIFF_USER: 'env', DEMI_DIFF_PASS: 'envpass' };
  assert.strictEqual(credential({ user: 'flag:flagpass' }, env), 'flag:flagpass');
  assert.strictEqual(credential({ user: '' }, env), 'env:envpass');
});

test('a missing credential stops the run instead of going anonymous', () => {
  // Anonymous means rproxy 401s every demi call and the report is 39 DIFFs that say nothing.
  assert.throws(() => credential({ user: '' }, {}), /DEMI_DIFF_USER/);
  assert.throws(() => credential({ user: '' }, { DEMI_DIFF_USER: 'u' }), /DEMI_DIFF_PASS/);
});

test('expandCases is specs x pages, numbered from 1 for --case', () => {
  const cases = expandCases([{ dataset: 'Project' }, { dataset: 'Document', keywords: 'water' }], [0, 1, 2]);
  assert.strictEqual(cases.length, 6);
  assert.deepStrictEqual(cases.map(c => c.n), [1, 2, 3, 4, 5, 6]);
  assert.deepStrictEqual(cases.map(c => c.pageNum), [0, 1, 2, 0, 1, 2]);
  assert.strictEqual(cases[4].keywords, 'water');
  // Not `CASES.length * PAGES.length` any more — a case may declare its own range, and hardcoding
  // the product meant adding one such case broke a test that had nothing to say about it.
  const expected = CASES.reduce((n, c) => n + (c.pages || PAGES).length, 0);
  assert.strictEqual(expandCases().length, expected);
  assert.deepStrictEqual(expandCases().map(c => c.n), [...Array(expected).keys()].map(i => i + 1));
});

test('the shipped matrix still covers every dimension it claims to', () => {
  // Guards the matrix against being quietly gutted: a differ that only exercises unfiltered
  // Project page 1 would report far fewer DIFFs and look like progress.
  for (const dataset of ['Project', 'Document', 'DocumentChunk']) {
    assert.ok(CASES.some(c => c.dataset === dataset), `no ${dataset} case`);
  }
  assert.ok(CASES.some(c => !c.keywords) && CASES.some(c => c.keywords));
  assert.ok(CASES.some(c => c.filter), 'no filter case — diff class (1) would go unseen');
  assert.ok(CASES.some(c => c.sortBy === '-datePosted'));
  assert.ok(CASES.some(c => c.sortBy === '+displayName'));
  assert.deepStrictEqual(PAGES, [0, 1, 2]);
});

test('buildUrl repeats sortBy when a case carries two, the way the client does', () => {
  const url = buildUrl('https://example.test/search',
    { dataset: 'Document', sortBy: ['-datePosted', '+displayName'], pageNum: 0 }, 10);
  assert.deepStrictEqual(new URL(url).searchParams.getAll('sortBy'), ['-datePosted', '+displayName']);
});

test('buildUrl encodes a leading + unambiguously', () => {
  const url = buildUrl('https://example.test/search',
    { dataset: 'Document', keywords: 'water', filter: 'milestone=abc123', sortBy: '+displayName', pageNum: 2 }, 10);
  // '+' must arrive as %2B: unencoded it decodes to a space and the sort becomes ' displayName'.
  assert.match(url, /sortBy=%2BdisplayName/);
  assert.match(url, /and%5Bmilestone%5D=abc123/);
  assert.match(url, /pageNum=2/);
  assert.match(url, /pageSize=10/);
  assert.match(url, /keywords=water/);
});

test('buildUrl omits what the case did not ask for', () => {
  // An empty `keywords=` is not the same query as no keywords — it is a keyword search for nothing.
  const url = buildUrl('https://example.test/search', { dataset: 'Project', pageNum: 0 }, 25);
  assert.ok(!url.includes('keywords'), url);
  assert.ok(!url.includes('sortBy'), url);
  assert.ok(!url.includes('and%5B'), url);
});

test('summarize keeps "not measured" distinct from zero', () => {
  const missing = summarize({ status: 200, payload: [{ searchResults: [] }] });
  assert.strictEqual(missing.total, null);
  assert.deepStrictEqual(missing.ids, []);
  assert.strictEqual(missing.keys, null);
  assert.strictEqual(summarize(respond([], 0)).total, 0);
});

test('identical answers PASS', () => {
  const rows = [{ _id: 'a', name: 'one' }, { _id: 'b', name: 'two' }];
  const verdict = compareCase(respond(rows, 42), respond(rows, 42));
  assert.strictEqual(verdict.pass, true);
  assert.deepStrictEqual(verdict.diffs, []);
});

test('a different total, on its own, is NOT a finding', () => {
  // THE WHOLE POINT OF THE REWRITE. demi holds 60,560 documents and eagle 61,582 because demi was
  // seeded from eagle-DEV; asserting on that gap made every one of the 42 cases fail and the tool
  // useless. Totals are still summarised for the reader, never graded.
  const rows = [{ _id: 'a' }];
  const verdict = compareCase(respond(rows, 60560), respond(rows, 61582));
  assert.strictEqual(verdict.pass, true, JSON.stringify(verdict.diffs));
  assert.strictEqual(verdict.demi.total, 60560);
  assert.strictEqual(verdict.eagle.total, 61582);
});

test('a filter one service applies and the other ignores IS a finding, at any totals', () => {
  // The measured case: Document + and[isFeatured]=true. demi answers the unfiltered corpus
  // (60,560 -> 60,560, no such column) while eagle narrows 61,582 to 336. Two DIFFERENT corpora,
  // two different baselines, and the disagreement still surfaces — which is what makes the signal
  // usable here at all.
  const verdict = compareCase(
    respond([{ _id: 'a' }], 60560),
    respond([{ _id: 'b' }], 336),
    {
      // `Document` rather than `DocumentChunk`, and the swap is not cosmetic: the chunk dataset now
      // carries a DECLARED acceptance for this field, so using it here would assert that the
      // acceptance table is empty rather than that the signal works. `isFeatured` is the same
      // shape with no acceptance behind it — demi has no such column, eagle narrows 61,582 to 336.
      dataset: 'Document',
      demi: { total: 60560, ids: ['a'] },
      eagle: { total: 61582, ids: ['b'] }
    });
  assert.strictEqual(verdict.pass, false);
  assert.deepStrictEqual(
    verdict.diffs.filter(d => d.field === 'selective'),
    [{ field: 'selective', demi: false, eagle: true }]);
});

test('both services applying the same filter passes even when the counts differ', () => {
  // demi 102 and eagle 107 for and[type]=Mines: different corpora, same BEHAVIOUR. The old
  // comparison failed this; failing it is what taught the reader to ignore the report.
  const verdict = compareCase(
    respond([{ _id: 'a' }], 102),
    respond([{ _id: 'b' }], 107),
    { dataset: 'Project', demi: { total: 348, ids: ['a'] }, eagle: { total: 358, ids: ['b'] } });
  assert.strictEqual(verdict.pass, true, JSON.stringify(verdict.diffs));
});

test('selectivity is undefined, not false, when a total is missing', () => {
  // "The service did not report a total" and "the filter matched everything" must not collapse:
  // a broken response would otherwise read as a working filter on whichever side reported nothing.
  assert.strictEqual(selectivity({ total: null }, { total: 5 }), undefined);
  assert.strictEqual(selectivity({ total: 5 }, { total: null }), undefined);
  assert.strictEqual(selectivity({ total: 5 }, null), undefined);
  assert.strictEqual(selectivity({ total: 5 }, { total: 5 }), false);
  assert.strictEqual(selectivity({ total: 4 }, { total: 5 }), true);
});

test('a sort one service honours and the other drops IS a finding', () => {
  // Measured: sortBy=+project.name on Document returns demi's unsorted page byte-for-byte, because
  // no project-name field exists in demi's documents index. Graded within each service, so the two
  // corpora never enter into it.
  const verdict = compareCase(
    respond([{ _id: 'a' }, { _id: 'b' }], 2),
    respond([{ _id: 'y' }, { _id: 'x' }], 2),
    {
      dataset: 'Document',
      demi: { total: 2, ids: ['a', 'b'] },   // identical to the sorted answer: dropped
      eagle: { total: 2, ids: ['x', 'y'] }   // reordered: honoured
    });
  assert.strictEqual(verdict.pass, false);
  assert.deepStrictEqual(
    verdict.diffs.filter(d => d.field === 'sortHonoured'),
    [{ field: 'sortHonoured', demi: false, eagle: true }]);
});

test('an EXPECTED key delta passes; an unexpected one does not', () => {
  // The DocumentChunk row unit genuinely differs — demi one row per PASSAGE, eagle one per
  // DOCUMENT — and that difference is declared, so it must not fail every chunk case forever.
  const demiRow = {
    _id: 'x::p60::c79', _schemaName: 'DocumentChunk', content: '', chunkId: 'c79',
    documentId: 'x', documentName: 'n', documentType: 'PDF Document', matchCount: 1,
    pageNumber: 60, project: {}, projectId: '1', projectName: 'p', snippet: '…', snippets: ['…'],
    // The three chip fields. Present on BOTH sides now, which is why they are no longer in the
    // eagle-only delta — this fixture is what would fail if they were dropped again.
    datePosted: '2017-01-01', milestone: 'm', milestoneId: 'm'
  };
  const eagleRow = {
    _id: 'x', _schemaName: 'DocumentChunk', datePosted: '2017-01-01', documentId: 'x',
    documentName: 'n', documentType: 'PDF', documentTypeId: 't', matchCount: 1, milestone: 'm',
    milestoneId: 'm', project: {}, projectId: '1', read: [], snippets: ['…']
  };
  const declared = compareCase(respond([demiRow], 1), respond([eagleRow], 1), { dataset: 'DocumentChunk' });
  assert.strictEqual(declared.pass, true, JSON.stringify(declared.diffs));

  // One key nobody declared, and the run must go red — otherwise the delta list is a mute button
  // rather than an acceptance.
  const surprise = compareCase(
    respond([{ ...demiRow, somethingNew: 1 }], 1), respond([eagleRow], 1),
    { dataset: 'DocumentChunk' });
  assert.strictEqual(surprise.pass, false);
  assert.deepStrictEqual(surprise.diffs.find(d => d.field === 'rowKeys').demiOnly, ['somethingNew']);
});

test('pagingReport names a row that appears on two pages', () => {
  // The invariant a pager depends on, graded within ONE service: a row on two pages is a row
  // reachable from none. Measured on demi for keywords=pattullo — 63 ids across 13 pages.
  const clean = pagingReport([
    { pageNum: 0, ids: ['a', 'b'] }, { pageNum: 1, ids: ['c', 'd'] }]);
  assert.deepStrictEqual(clean.repeated, []);
  assert.strictEqual(clean.distinct, 4);
  assert.strictEqual(clean.slots, 4);

  const dirty = pagingReport([
    { pageNum: 0, ids: ['a', 'b'] }, { pageNum: 1, ids: ['b', 'c'] }, { pageNum: 2, ids: ['a'] }]);
  assert.strictEqual(dirty.slots, 5);
  assert.strictEqual(dirty.distinct, 3);
  assert.deepStrictEqual(dirty.repeated,
    [{ id: 'a', pages: [0, 2] }, { id: 'b', pages: [0, 1] }]);
});

test('baselineOf strips exactly the two dimensions selectivity is measured against', () => {
  assert.strictEqual(baselineOf({ dataset: 'Project', pageNum: 0 }), null);
  assert.deepStrictEqual(
    baselineOf({ dataset: 'Document', keywords: 'water', filter: 'type=x', sortBy: '-datePosted', pageNum: 2 }),
    { dataset: 'Document', keywords: 'water', pageNum: 2 });
});

test('a DECLARED divergence is surfaced with its reason and does not fail the run', () => {
  // demi never sorts chunks — every field in the chunks index is sortable:false — and that is a
  // decision with a paragraph behind it, not an oversight. It must still be VISIBLE: an acceptance
  // that prints nothing is indistinguishable from a fix.
  const verdict = compareCase(
    respond([{ _id: 'a' }, { _id: 'b' }], 2),
    respond([{ _id: 'y' }, { _id: 'x' }], 2),
    {
      dataset: 'DocumentChunk',
      demi: { total: 2, ids: ['a', 'b'] },
      eagle: { total: 2, ids: ['x', 'y'] }
    });
  assert.strictEqual(verdict.pass, true, JSON.stringify(verdict.diffs));
  assert.deepStrictEqual(verdict.diffs, []);
  assert.strictEqual(verdict.accepted.length, 1);
  assert.strictEqual(verdict.accepted[0].field, 'sortHonoured');
  assert.match(verdict.accepted[0].reason, /sortable:false/);
});

test('the same divergence on a dataset with no declared reason still fails', () => {
  // The acceptance is keyed dataset:field, not field. A dropped sort on Document is a defect even
  // though the identical shape on DocumentChunk is decided.
  const verdict = compareCase(
    respond([{ _id: 'a' }, { _id: 'b' }], 2),
    respond([{ _id: 'y' }, { _id: 'x' }], 2),
    {
      dataset: 'Document',
      demi: { total: 2, ids: ['a', 'b'] },
      eagle: { total: 2, ids: ['x', 'y'] }
    });
  assert.strictEqual(verdict.pass, false);
  assert.deepStrictEqual(verdict.accepted, []);
  assert.ok(verdict.diffs.some(d => d.field === 'sortHonoured'));
});

test('an empty page is excused only when the side\'s own total explains it', () => {
  // Measured: `keywords=pattullo` page 26 at pageSize 10 — demi 250 matches against eagle's 262, so
  // `skip 250 >= 250` and demi is legitimately out of rows while eagle is not. Comparing keys there
  // reported every key eagle emits as unexpected, thirteen of them, on a case simply past the end.
  const row = { _id: 'a', displayName: 'x', datePosted: '2020-01-01' };
  const atPage = (n) => ({ dataset: 'Document', kase: { pageNum: n }, pageSize: 10 });

  const demiRanOut = compareCase(respond([], 250), respond([row], 262), atPage(25));
  assert.strictEqual(demiRanOut.pass, true, JSON.stringify(demiRanOut.diffs));
  const eagleRanOut = compareCase(respond([row], 262), respond([], 250), atPage(25));
  assert.strictEqual(eagleRanOut.pass, true, JSON.stringify(eagleRanOut.diffs));

  // THE SIGNAL THE BLUNT VERSION OF THIS FIX THREW AWAY. An empty page whose own total says it
  // should be full is a service failing, not a corpus ending — and "both sides have rows" alone
  // would have passed it in silence.
  const shouldHaveRows = compareCase(respond([], 60560), respond([row], 61582), atPage(0));
  assert.strictEqual(shouldHaveRows.pass, false);
  assert.deepStrictEqual(
    shouldHaveRows.diffs.find(d => d.field === 'emptyPage'), { field: 'emptyPage', demi: 60560, eagle: null });

  // BOTH SIDES, and the mirror is not symmetry for its own sake: this differ exists to grade demi,
  // so the eagle branch is the one a reader would assume is decorative and delete. eagle answering
  // an unexplained empty page is prod misbehaving, which is worth knowing before it is copied.
  const eagleShouldHaveRows = compareCase(respond([row], 60560), respond([], 61582), atPage(0));
  assert.strictEqual(eagleShouldHaveRows.pass, false);
  assert.deepStrictEqual(
    eagleShouldHaveRows.diffs.find(d => d.field === 'emptyPage'),
    { field: 'emptyPage', demi: null, eagle: 61582 });

  // A side that reported NO total cannot use it as an excuse either.
  const noTotal = compareCase(respond([], null), respond([row], 262), atPage(25));
  assert.strictEqual(noTotal.pass, false, 'unknown is not the same as expected');

  // And the key check is still live where both sides have rows — otherwise this is a mute button.
  const real = compareCase(
    respond([{ ...row, somethingNew: 1 }], 10), respond([row], 10), atPage(0));
  assert.strictEqual(real.pass, false);
  assert.deepStrictEqual(real.diffs.find(d => d.field === 'rowKeys').demiOnly, ['somethingNew']);
});

test('a case-scoped acceptance does not silence its siblings', () => {
  // THE MUTE-BUTTON BUG, and it was mine. A `DocumentChunk:selective` entry written for the
  // broad-filter case also passed the NARROW-filter case that exists precisely to catch chunk
  // scoping breaking — and the whole run went green against a deployed app that had no scoping at
  // all. An acceptance that holds for some requests belongs on the case, never on the dataset.
  const sides = {
    dataset: 'DocumentChunk',
    demi: { total: 399872, ids: ['a'] },
    eagle: { total: 430345, ids: ['b'] }
  };
  const ignored = () => [respond([{ _id: 'a' }], 399872), respond([{ _id: 'b' }], 0)];

  const broad = compareCase(...ignored(), {
    ...sides,
    kase: { accept: { selective: 'over DOCUMENT_SCOPE_CAP, reported in meta.dropped' } }
  });
  assert.strictEqual(broad.pass, true, JSON.stringify(broad.diffs));
  assert.strictEqual(broad.accepted.length, 1);

  const narrow = compareCase(...ignored(), { ...sides, kase: {} });
  assert.strictEqual(narrow.pass, false,
    'the same dataset and the same field, with no acceptance on THIS case, must still fail');
  assert.ok(narrow.diffs.some(d => d.field === 'selective'));
});

test('a dataset-wide acceptance still applies to every case of it', () => {
  // The other scope, which is correct where it is used: demi cannot sort chunks at all, so the
  // divergence is a property of the dataset and not of any one request.
  const verdict = compareCase(
    respond([{ _id: 'a' }, { _id: 'b' }], 2),
    respond([{ _id: 'y' }, { _id: 'x' }], 2),
    {
      dataset: 'DocumentChunk',
      kase: {},
      demi: { total: 2, ids: ['a', 'b'] },
      eagle: { total: 2, ids: ['x', 'y'] }
    });
  assert.strictEqual(verdict.pass, true, JSON.stringify(verdict.diffs));
  assert.match(verdict.accepted[0].reason, /sortable:false/);
});

test('every declared divergence carries a reason', () => {
  // The reason is the acceptance. A blank one turns this table into a mute button.
  for (const [key, reason] of Object.entries(EXPECTED_DIVERGENCE)) {
    assert.match(key, /^[A-Za-z]+:[A-Za-z]+$/, key);
    assert.ok(typeof reason === 'string' && reason.length > 40, `${key} has no real reason`);
  }
});

test('specKey drops the page instead of stripping a rendered suffix', () => {
  // `label` prints pageNum + 1, so a null page renders as "page=1" — the first version stripped
  // " page=null", matched nothing, and every paging line claimed to be about page 1.
  const key = specKey({ dataset: 'Document', keywords: 'water', pageNum: 2 });
  assert.strictEqual(key, 'Document keywords="water"');
  assert.strictEqual(key, specKey({ dataset: 'Document', keywords: 'water', pageNum: 0 }));
  assert.ok(!/page=/.test(key), key);
});

test('a case may carry its own page range', () => {
  // Three pages cannot see a paging defect that starts at page 7.
  const cases = expandCases([{ dataset: 'Document', keywords: 'x', pages: [0, 1, 2, 3] }], [0, 1]);
  assert.strictEqual(cases.length, 4);
  assert.deepStrictEqual(cases.map(c => c.pageNum), [0, 1, 2, 3]);
  assert.ok(!('pages' in cases[0]), 'the range must not survive onto the case as a query param');
});

test('a non-200 is the only finding made about that case', () => {
  const verdict = compareCase({ status: 502, payload: { error: 'Deep Search is unavailable' } }, respond([{ _id: 'a' }], 1));
  assert.strictEqual(verdict.pass, false);
  assert.deepStrictEqual(verdict.diffs, [{ field: 'httpStatus', demi: 502, eagle: 200 }]);
});

test('a 200 that is not the search envelope is called out as such', () => {
  // "no row array" and "no rows" are different failures; conflating them sends whoever reads the
  // report looking at the corpus instead of at the response shape.
  const verdict = compareCase({ status: 200, payload: { error: 'nope' } }, respond([{ _id: 'a' }], 1));
  assert.strictEqual(verdict.pass, false);
  assert.deepStrictEqual(verdict.diffs, [{ field: 'envelope', demi: true, eagle: false }]);
});

test('two empty pages agree when the query genuinely matched nothing', () => {
  // Page 0 of a zero-result query: `0 * 10 >= 0`, so both sides are past the end and the emptiness
  // is explained. No rows means no key comparison to make.
  const bases = { dataset: 'Document', kase: { pageNum: 0 }, pageSize: 10 };
  assert.strictEqual(compareCase(respond([], 0), respond([], 0), bases).pass, true);
});
