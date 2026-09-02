'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const searchController = require('../../src/controllers/search');
const aiSearch = require('../../src/search/ai-search');
const documentsRepo = require('../../src/repositories/documents');
const projectsRepo = require('../../src/repositories/projects');
const chunksRepo = require('../../src/repositories/chunks');
const summarizer = require('../../src/ai/summarize');

// The controller REPLACES `res.json` to attach `meta`, so a fake response has to expose it as a
// writable property and record whatever the wrapper finally calls through with.
function capture() {
  const out = {};
  const res = {
    json: (data) => { out.body = data; return res; },
    status: (code) => { out.status = code; return res; }
  };
  return { out, res };
}

const anonymous = query => ({ query, header: () => null });

// A caller `filterFor` answers `{filter: null, empty: false}` for — an UNFILTERED read, not an
// empty one. Every probe in this file was anonymous before, and an anonymous caller always has a
// filter, which is exactly why the last route to compose a clause over `filter` took staging down
// with `(undefined) and ...` and nothing caught it.
const privileged = query => ({
  query,
  header: () => null,
  user: { realm_access: { roles: ['sysadmin'] } }
});

test('the response says which keys it could not express', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  // A filter the index cannot express was named in `logger.warn` and NOWHERE ELSE. The caller got
  // a 200 and a full-corpus page: measured against test, `and[proponent]=<ObjectId>` on Project
  // answers `pageSize` rows under `searchResultsTotal: 348`, which is the unfiltered corpus.
  await t.test('a dropped filter key is named in meta, not only in the log', async () => {
    t.mock.method(aiSearch, 'searchDocuments', async () => ({ count: 61, items: [] }));

    const { out, res } = capture();
    await searchController.search(
      anonymous({ dataset: 'Document', keywords: '', 'and[documentAuthor]': 'x', pageSize: '5' }), res);

    assert.deepStrictEqual(out.body[0].meta[0].dropped.filter, ['documentAuthor']);
    assert.strictEqual(out.body[0].meta[0].searchResultsTotal, 61,
      'and the existing keys are untouched — eagle-public pages off this one');
  });

  // A dropped SORT is the quieter injury: the rows are right, the ORDER is arbitrary, and nothing
  // about the page says so.
  await t.test('a dropped sort key is named in meta too', async () => {
    t.mock.method(aiSearch, 'searchDocuments', async () => ({ count: 3, items: [] }));

    const { out, res } = capture();
    await searchController.search(
      anonymous({ dataset: 'Document', keywords: '', sortBy: '-notAField', pageSize: '5' }), res);

    assert.deepStrictEqual(out.body[0].meta[0].dropped, { filter: [], sort: ['notAField'] });
  });

  // `sortBy` on DocumentChunk can only ever be discarded — no field in the `chunks` index is
  // sortable, so the branch sends no `$orderby` at all. It used to discard it without a word, which
  // would make `dropped` lie by omission on the one dataset where the drop is unconditional.
  await t.test('a chunk sort is reported even though the branch never builds one', async () => {
    let sent = null;
    t.mock.method(aiSearch, 'searchChunks', async (opts) => {
      sent = opts;
      return { count: 5, items: [] };
    });

    const { out, res } = capture();
    await searchController.search(
      anonymous({ dataset: 'DocumentChunk', keywords: 'caribou', sortBy: 'datePosted' }), res);

    assert.strictEqual(sent.orderby, undefined, 'the branch still orders chunks by relevance only');
    assert.deepStrictEqual(out.body[0].meta[0].dropped.sort, ['datePosted']);
  });

  // ONE SHAPE ACROSS ALL THREE DATASETS, and across both backends: the keywordless Cosmos list
  // can apply no `and[]` filter at all, and `project` is inexpressible against the `projects`
  // index either way. Same key, same two arrays.
  await t.test('a project filter the dataset cannot express answers NOTHING, and says so', async () => {
    // `projects` has no `projectId` column — a project is its own scope — so `buildFilter` drops
    // the key. Reporting the drop and then answering the whole ACL-visible corpus is the widest
    // possible reading of the narrowest possible request: measured, `dataset=Project&project=<id>`
    // returned `count: 348`, every project this caller can see, to someone who asked for one.
    let searched = false;
    t.mock.method(projectsRepo, 'listVisible', async () => { searched = true; return { items: [] }; });
    t.mock.method(projectsRepo, 'countVisible', async () => { searched = true; return 348; });
    t.mock.method(aiSearch, 'searchProjects', async () => { searched = true; return { count: 348, items: [] }; });

    const { out, res } = capture();
    await searchController.search(
      anonymous({ dataset: 'Project', keywords: '', project: '207', pageSize: '10' }), res);

    assert.strictEqual(out.body[0].count, 0, 'a scope this index cannot represent matches nothing');
    assert.deepStrictEqual(out.body[0].searchResults, []);
    assert.deepStrictEqual(out.body[0].meta[0].dropped, { filter: ['project'], sort: [] },
      'and the caller is told which key it was, or an empty answer is indistinguishable from no data');
    assert.strictEqual(searched, false, 'nothing is queried for a scope that cannot be expressed');
  });

  await t.test('a project filter the dataset CAN express is not refused', async () => {
    // The other half. `documents` carries `projectId`, so the same wire shape is a real filter and
    // must reach the index — a guard that refused both would empty every project documents tab.
    let sent = null;
    t.mock.method(aiSearch, 'searchDocuments', async (opts) => { sent = opts; return { count: 0, items: [] }; });

    const { out, res } = capture();
    await searchController.search(
      anonymous({ dataset: 'Document', keywords: 'fish', project: '207' }), res);

    assert.ok(sent, 'the request must be issued');
    assert.ok(sent.filter.includes("projectId eq '207'"), `got: ${sent.filter}`);
    assert.strictEqual(out.body[0].meta[0].dropped, undefined, 'nothing was dropped');
  });

  // ABSENT means nothing was dropped — the same rule `searchResultsTotal` and `countsPassages`
  // already follow. An empty array on every response teaches a reader to stop looking.
  await t.test('the key is absent when the whole request was expressible', async () => {
    t.mock.method(aiSearch, 'searchProjects', async () => ({ count: 2, items: [] }));

    const { out, res } = capture();
    await searchController.search(
      anonymous({ dataset: 'Project', keywords: 'caribou', pageSize: '10' }), res);

    assert.strictEqual('dropped' in out.body[0].meta[0], false,
      `nothing was dropped, so nothing is said: ${JSON.stringify(out.body[0].meta[0])}`);
  });
});

test('an unparseable pageSize takes the documented default', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  // `parseInt('abc')` is NaN, `Math.min(NaN, 5000)` is NaN, and NaN reached the repository's own
  // page size: measured against test, `pageSize=abc` answered 348 rows — the entire visible
  // corpus — where `pageSize=10` answers 10.
  await t.test('pageSize=abc asks for the same page an absent pageSize does', async () => {
    const asked = [];
    t.mock.method(projectsRepo, 'listVisible', async (access, opts) => {
      asked.push(opts.pageSize);
      return { items: [] };
    });
    t.mock.method(projectsRepo, 'countVisible', async () => 348);

    const { res } = capture();
    await searchController.search(anonymous({ dataset: 'Project', keywords: '', pageSize: 'abc' }), res);
    const { res: res2 } = capture();
    await searchController.search(anonymous({ dataset: 'Project', keywords: '' }), res2);

    assert.deepStrictEqual(asked, [10, 10], 'unparseable and absent must land on the same default');
  });

  // The shapes the first pass missed, and they matter more than `abc` because they are NUMBERS:
  // `|| 10` never fires on -1, `Math.min(-1, 5000)` is -1, and the `> MAX_PAGE_ROWS` refusal
  // cannot fire on a negative either. Measured before the clamp, `pageSize=-5&pageNum=3` reached
  // Azure AI Search as `{top: -5, skip: -15}`.
  await t.test('a zero or negative pageSize takes the default too', async () => {
    const asked = [];
    t.mock.method(projectsRepo, 'listVisible', async (access, opts) => {
      asked.push(opts.pageSize);
      return { items: [] };
    });
    t.mock.method(projectsRepo, 'countVisible', async () => 348);

    for (const pageSize of ['0', '-1', '-5']) {
      const { res } = capture();
      await searchController.search(anonymous({ dataset: 'Project', keywords: '', pageSize }), res);
    }

    assert.deepStrictEqual(asked, [10, 10, 10],
      'a page of no rows and a page of minus five rows are both requests nobody means');
  });

  await t.test('a negative pageSize never reaches the search service', async () => {
    // The consumer that actually breaks. A negative `top` and a negative `skip` are not a small
    // page — they are a request the service rejects, from a caller who only typed a bad number.
    let sent = null;
    t.mock.method(aiSearch, 'searchDocuments', async (opts) => { sent = opts; return { count: 0, items: [] }; });

    const { res } = capture();
    await searchController.search(
      anonymous({ dataset: 'Document', keywords: 'fish', pageSize: '-5', pageNum: '3' }), res);

    assert.ok(sent, 'the request is still issued');
    assert.ok(sent.top > 0, `top must be positive, got ${sent.top}`);
    assert.ok(sent.skip >= 0, `skip must not be negative, got ${sent.skip}`);
  });
});

test('chunk filters are resolved through the documents index', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const chunk = { chunkId: 'd1::p1::c0', documentId: 'd1', projectId: '207', pageNumber: 1, snippet: 'x' };
  const stubHydration = (tt) => {
    tt.mock.method(documentsRepo, 'listByIds', async () => ([{ id: 'd1', displayName: 'A', type: 'Letter' }]));
    tt.mock.method(projectsRepo, 'listByIds', async () => ([{ id: '207', name: 'Site C' }]));
  };

  await t.test('a recoverable filter scopes the chunk query and leaves the report clean', async () => {
    // The measured defect: `and[type]=Letter` on DocumentChunk answered 399,872 hits, identical to
    // no filter, where prod answered 0. `chunks.json` has no `type` to filter on.
    let scopeFilter = null;
    let docFilter = null;
    t.mock.method(aiSearch, 'documentIdsMatching', async (f) => {
      docFilter = f;
      return { ids: ['d1', 'd2'], total: 2, withinCap: true };
    });
    t.mock.method(aiSearch, 'searchChunks', async (opts) => {
      scopeFilter = opts.filter;
      return { count: 1, items: [chunk] };
    });
    stubHydration(t);

    const { out, res } = capture();
    await searchController.search(
      anonymous({ dataset: 'DocumentChunk', keywords: 'river', 'and[type]': '5cf00c03a266b7e1877504e9' }), res);

    // THE ASSERTION THAT MATTERS MOST. Without it a resolver that built an EMPTY document filter
    // still looks like it worked: the ACL clause alone keeps the filter non-empty, nothing is
    // reported dropped, and the scope is applied on the strength of a query that never carried the
    // caller's value. That is precisely the bug the first version of this had.
    assert.ok(docFilter && docFilter.includes('5cf00c03a266b7e1877504e9'),
      `the document query must carry the caller's own value, got: ${docFilter}`);
    assert.match(scopeFilter, /search\.in\(documentId, 'd1,d2', ','\)/,
      `the chunk query must be scoped to the resolved documents, got: ${scopeFilter}`);
    assert.ok(scopeFilter.includes("'public'"), 'and the ACL still gates it');
    // The key WORKED, so naming it as dropped would be the mirror of the defect being fixed.
    assert.strictEqual(out.body[0].meta[0].dropped, undefined,
      `a recovered key must not be reported as dropped: ${JSON.stringify(out.body[0].meta[0])}`);
  });

  await t.test("the caller's own project scope narrows the document resolution", async () => {
    // Without this the resolver asked the documents index corpus-wide and discarded the narrowing
    // the caller had already supplied. `project` is never in `dropped` on this dataset — chunks
    // carry `projectId`, so it is expressible and applied to the chunk query directly — which is
    // exactly why it was invisible to a `narrowed` object built only from `dropped`. Measured: a
    // `type` filter inside one project resolved to 2,911 documents corpus-wide and was reported
    // inexpressible, where the project-scoped set is small enough to scope.
    let docFilter = null;
    t.mock.method(aiSearch, 'documentIdsMatching', async (f) => {
      docFilter = f;
      return { ids: ['d1'], total: 1, withinCap: true };
    });
    t.mock.method(aiSearch, 'searchChunks', async () => ({ count: 1, items: [chunk] }));
    stubHydration(t);

    const { out, res } = capture();
    await searchController.search(anonymous({
      dataset: 'DocumentChunk',
      keywords: 'river',
      project: '207',
      'and[type]': '5cf00c03a266b7e1877504cf'
    }), res);

    assert.ok(docFilter.includes("projectId eq '207'"),
      `the document query must carry the caller's project scope, got: ${docFilter}`);
    assert.ok(docFilter.includes('5cf00c03a266b7e1877504cf'), 'and the metadata filter');
    assert.strictEqual(out.body[0].meta[0].dropped, undefined);
  });

  await t.test('the nested and:{} wire shape resolves like the bracketed one', async () => {
    // `andParams` accepts BOTH shapes — `and[type]=x` and a nested `and: {type: 'x'}` object, which
    // is what a qs/extended parser produces — and `buildFilter` reads through it. The resolver used
    // to probe `and[<key>]` by hand instead, so under the nested shape the caller's value never
    // reached the document query while the key was still counted as recovered: a scope built from a
    // filter that carried nothing, reported as applied. Unreachable under the shipped parser, which
    // is precisely what makes it the kind of thing a parser swap turns on silently.
    let docFilter = null;
    t.mock.method(aiSearch, 'documentIdsMatching', async (f) => {
      docFilter = f;
      return { ids: ['d1'], total: 1, withinCap: true };
    });
    t.mock.method(aiSearch, 'searchChunks', async () => ({ count: 1, items: [chunk] }));
    stubHydration(t);

    const { out, res } = capture();
    await searchController.search(anonymous({
      dataset: 'DocumentChunk',
      keywords: 'river',
      and: { type: '5cf00c03a266b7e1877504cf' }
    }), res);

    assert.ok(docFilter && docFilter.includes('5cf00c03a266b7e1877504cf'),
      `the nested shape must reach the document query, got: ${docFilter}`);
    assert.strictEqual(out.body[0].meta[0].dropped, undefined,
      'and the key counts as recovered only because it actually was');
  });

  await t.test('a key NEITHER index can express is still reported as dropped', async () => {
    // `documentAuthor` is in no demi index at all, so resolving it through `documents` recovers
    // nothing — `isFeatured` used to sit here and stopped qualifying the moment 3.3 put it in
    // `documents`, which is where this recovery reads. Sent alongside a key that IS recoverable,
    // because the failure this closes is claiming the whole dropped list as recovered the moment
    // any one of them resolves — which reports a working filter and a broken one identically.
    t.mock.method(aiSearch, 'documentIdsMatching', async () => ({ ids: ['d1'], total: 1, withinCap: true }));
    t.mock.method(aiSearch, 'searchChunks', async () => ({ count: 1, items: [chunk] }));
    stubHydration(t);

    const { out, res } = capture();
    await searchController.search(anonymous({
      dataset: 'DocumentChunk',
      keywords: 'river',
      'and[type]': '5cf00c03a266b7e1877504e9',
      'and[documentAuthor]': 'x'
    }), res);

    assert.deepStrictEqual(out.body[0].meta[0].dropped.filter, ['documentAuthor'],
      'the recoverable key resolved and the unresolvable one must still be named');
  });

  await t.test('too many matching documents leaves the key dropped, never a truncated scope', async () => {
    // The honest failure. A prefix of twelve thousand documents would answer "the chunks matching
    // your filter" about an arbitrary subset — data-shaped, and wrong.
    let scopeFilter = null;
    t.mock.method(aiSearch, 'documentIdsMatching', async () => ({ ids: [], total: 12515, withinCap: false }));
    t.mock.method(aiSearch, 'searchChunks', async (opts) => {
      scopeFilter = opts.filter;
      return { count: 1, items: [chunk] };
    });
    stubHydration(t);

    const { out, res } = capture();
    await searchController.search(
      anonymous({ dataset: 'DocumentChunk', keywords: 'river', 'and[type]': '5cf00c03a266b7e1877504e9' }), res);

    assert.ok(!/search\.in\(documentId/.test(scopeFilter),
      `no partial scope may be applied, got: ${scopeFilter}`);
    assert.deepStrictEqual(out.body[0].meta[0].dropped.filter, ['type'],
      'the caller must be told the filter did not apply');
  });

  await t.test('no matching document answers nothing, and says the filter ran', async () => {
    let scopeFilter = null;
    t.mock.method(aiSearch, 'documentIdsMatching', async () => ({ ids: [], total: 0, withinCap: true }));
    t.mock.method(aiSearch, 'searchChunks', async (opts) => {
      scopeFilter = opts.filter;
      return { count: 0, items: [] };
    });

    const { out, res } = capture();
    await searchController.search(
      anonymous({ dataset: 'DocumentChunk', keywords: 'river', 'and[type]': '5cf00c03a266b7e1877504e9' }), res);

    assert.match(scopeFilter, /documentId eq ''/, 'a clause that cannot match, not a dropped filter');
    assert.deepStrictEqual(out.body[0].searchResults, []);
    assert.strictEqual(out.body[0].meta[0].dropped, undefined, 'zero matches is the filter WORKING');
  });

  await t.test('a PRIVILEGED caller does not get "(undefined) and ..." into the service', async () => {
    // `filterFor` returns `{filter: null, empty: false}` for an unscoped privileged caller — an
    // unfiltered read. A bare template over that produces the literal string "(undefined) and ...",
    // which the service 400s and this route turns into a 502. That is how the provenance clause
    // took staging down, and every probe that missed it was anonymous.
    let scopeFilter = null;
    t.mock.method(aiSearch, 'documentIdsMatching', async () => ({ ids: ['d1'], total: 1, withinCap: true }));
    t.mock.method(aiSearch, 'searchChunks', async (opts) => {
      scopeFilter = opts.filter;
      return { count: 1, items: [chunk] };
    });
    stubHydration(t);

    const { out, res } = capture();
    await searchController.search(
      privileged({ dataset: 'DocumentChunk', keywords: 'river', 'and[type]': '5cf00c03a266b7e1877504e9' }), res);

    assert.ok(!/undefined|null/.test(scopeFilter), `no placeholder may reach the service: ${scopeFilter}`);
    assert.strictEqual(scopeFilter,
      "(not read/any(r: r eq 'compliance')) and search.in(documentId, 'd1', ',')",
      'an unfiltered caller gets the sealed exclusion and the scope, not a clause wrapped around nothing');
    assert.strictEqual(out.status, undefined, 'and it is a 200, not the 502 a 400 becomes');
  });
});

test('a Cosmos project row carries its location', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  // The value has been at rest and unread all along: the merge renames Eagle's `location` to
  // `address` on the way in, and neither row mapper read it back. `/projects` map popups render
  // "Location: -" and the marker tooltip renders the literal string "null".
  await t.test('location comes from the stored address', async () => {
    t.mock.method(projectsRepo, 'listVisible', async () => ({
      items: [{
        id: '207',
        name: 'Site C Clean Energy Project',
        address: '10 km south-west of Fort St. John',
        read: ['public']
      }]
    }));
    t.mock.method(projectsRepo, 'countVisible', async () => 1);

    const { out, res } = capture();
    await searchController.search(anonymous({ dataset: 'Project', keywords: '', pageSize: '10' }), res);

    assert.strictEqual(out.body[0].searchResults[0].location, '10 km south-west of Fort St. John');
  });
});

test('the summary is gated on the parent document, like the chunk search', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  // A chunk's own `read[]` is a snapshot taken at ingest, so it can outlive its document's
  // visibility — which is why the chunk SEARCH path gates on the parent document rather than on
  // the chunk. This path did not, so the full text of a withheld document reached the model and
  // came back paraphrased, with only the citation LABEL falling back to 'Untitled Document'.
  await t.test('a chunk whose parent document is not readable never reaches the model', async () => {
    t.mock.method(aiSearch, 'searchChunks', async () => ({
      items: [
        { chunkId: 'c1', documentId: 'd1', projectId: 'p1', pageNumber: 1 },
        { chunkId: 'c2', documentId: 'd2', projectId: 'p1', pageNumber: 7 }
      ]
    }));
    // The chunk rows themselves are readable — this is the stale-ACL case, and it is the only one
    // the two existing gates cannot catch.
    t.mock.method(chunksRepo, 'getById', async (access, chunkId) => ({
      id: chunkId, content: `text of ${chunkId}`
    }));
    // ACL-enforcing: d2 is simply not returned.
    t.mock.method(documentsRepo, 'listByIds', async () => ([{ id: 'd1', displayName: 'First' }]));
    t.mock.method(projectsRepo, 'listByIds', async () => ([{ id: 'p1', name: 'Site C' }]));

    let summarized = null;
    t.mock.method(summarizer, 'summarize', async (keywords, chunks) => {
      summarized = chunks;
      return { summary: 'a grounded answer', citations: [0], usage: null, estimatedCostCad: 0 };
    });

    const { out, res } = capture();
    await searchController.summarize(anonymous({ keywords: 'caribou' }), res);

    assert.deepStrictEqual(summarized.map(c => c.chunkId), ['c1'],
      'the withheld document contributed no text to the summary');
    assert.strictEqual(out.body.citations[0].documentName, 'First');
  });
});
