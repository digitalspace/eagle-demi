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
  compareCase
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
  assert.strictEqual(expandCases().length, CASES.length * PAGES.length);
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

test('a different total is a DIFF and names both numbers', () => {
  const rows = [{ _id: 'a' }];
  const verdict = compareCase(respond(rows, 60578), respond(rows, 61582));
  assert.strictEqual(verdict.pass, false);
  assert.deepStrictEqual(verdict.diffs, [{ field: 'searchResultsTotal', demi: 60578, eagle: 61582 }]);
});

test('the same rows in a different order is a DIFF', () => {
  // A set comparison would call this PASS, and a paging client would still see rows repeat and
  // vanish between pages. Order is the fact being compared.
  const verdict = compareCase(
    respond([{ _id: 'a' }, { _id: 'b' }], 2),
    respond([{ _id: 'b' }, { _id: 'a' }], 2));
  assert.strictEqual(verdict.pass, false);
  assert.deepStrictEqual(verdict.diffs, [{ field: 'rowIds', demi: ['a', 'b'], eagle: ['b', 'a'] }]);
});

test('REGRESSION 1: a dropped filter shows up as the unfiltered corpus', () => {
  // Recorded 2026-08-22 against `and[type]=Mines`, dataset=Project: eagle applies the filter,
  // DEMI's `projects` index has no EAO project type so eagle-query.js drops the key and answers
  // with all 382 projects. This is the case the differ exists to keep visible.
  const verdict = compareCase(
    respond([{ _id: '58851158aaecd9001b81e83f', name: '29694 Marshall Road Extension' }], 382),
    respond([{ _id: '5885175daaecd9001b83e8f0', name: 'Ajax Mine' }], 107));
  assert.strictEqual(verdict.pass, false);
  const fields = verdict.diffs.map(d => d.field);
  assert.ok(fields.includes('searchResultsTotal'));
  assert.ok(fields.includes('rowIds'));
});

test('REGRESSION 2: DocumentChunk rows are a different shape on each side', () => {
  // Recorded 2026-08-22, keywords=water. demi returns one row per PASSAGE keyed by chunkId;
  // eagle returns rows grouped per DOCUMENT with `snippets` and `matchCount`.
  const demiRow = {
    _id: '58868f40e036fb0105767fbc::p60::c79', _schemaName: 'DocumentChunk', content: '',
    documentId: '58868f40e036fb0105767fbc', documentName: 'x', documentType: 'PDF Document',
    pageNumber: 60, project: {}, projectId: '1', projectName: 'p', snippet: '…water…'
  };
  const eagleRow = {
    _id: '5886db48a4acd4014b8209ed', _schemaName: 'DocumentChunk', datePosted: '2017-01-01',
    documentId: '5886db48a4acd4014b8209ed', documentName: 'x', documentType: 'PDF',
    documentTypeId: 't', matchCount: 3, milestone: 'm', milestoneId: 'm', project: {},
    projectId: '588510dcaaecd9001b816cff', read: [], snippets: ['…water…']
  };
  const verdict = compareCase(respond([demiRow], 382916), respond([eagleRow], 418190));
  assert.strictEqual(verdict.pass, false);
  const keys = verdict.diffs.find(d => d.field === 'rowKeys');
  assert.ok(keys.demiOnly.includes('snippet'), keys.demiOnly.join(','));
  assert.ok(keys.demiOnly.includes('pageNumber'));
  assert.ok(keys.eagleOnly.includes('snippets'), keys.eagleOnly.join(','));
  assert.ok(keys.eagleOnly.includes('matchCount'));
  // The ids diverge because they are ids of different THINGS — chunk vs document.
  assert.ok(verdict.diffs.some(d => d.field === 'rowIds'));
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

test('two empty pages agree — no rows means no key comparison to make', () => {
  const verdict = compareCase(respond([], 0), respond([], 0));
  assert.strictEqual(verdict.pass, true);
});
