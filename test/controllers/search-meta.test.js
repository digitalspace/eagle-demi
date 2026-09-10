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

test('the LIVE chunks index decides what a facet filter can do', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const chunk = { chunkId: 'd1::p1::c0', documentId: 'd1', projectId: '207', pageNumber: 1, snippet: 'x' };
  const stubChunkSearch = (tt, onFilter) => {
    tt.mock.method(documentsRepo, 'listByIds', async () => ([{ id: 'd1', displayName: 'A' }]));
    tt.mock.method(projectsRepo, 'listByIds', async () => ([{ id: '207', name: 'Site C' }]));
    tt.mock.method(aiSearch, 'searchChunks', async (opts) => {
      if (onFilter) onFilter(opts.filter);
      return { count: 1, items: [chunk] };
    });
  };
  const stubStatus = (tt, status) =>
    tt.mock.method(aiSearch, 'chunkParentFieldStatus', async () => status);

  const typeIsMissing = tt => stubStatus(tt, {
    known: true, available: ['milestoneId', 'projectPhaseId', 'documentAuthorTypeId'],
    missing: ['typeId'], unstamped: 0
  });

  await t.test('a field the live index does not carry is never sent', async (tt) => {
    // THE DEPLOY HAZARD. Expressibility used to come from the packaged `chunks.json`, so between an
    // app release and the index PUT the app emitted `typeId eq …` against an index with no such
    // field: a 400, which this route answers as 502 "Deep Search is unavailable" — the whole tab,
    // for every caller, not just the ones filtering.
    let chunkFilter = null;
    stubChunkSearch(tt, f => { chunkFilter = f; });
    typeIsMissing(tt);
    tt.mock.method(aiSearch, 'documentIdsMatching', async () =>
      ({ ids: [], total: 4000, withinCap: false }));

    const { out, res } = capture();
    await searchController.search(anonymous({
      dataset: 'DocumentChunk', keywords: 'river', 'and[type]': '5cf00c03a266b7e1877504e9'
    }), res);

    assert.strictEqual(out.status, undefined, 'the page must still answer 200');
    assert.deepStrictEqual(out.body[0].meta[0].dropped.filter, ['type']);
    assert.ok(!/typeId/.test(chunkFilter),
      `the clause the live index cannot answer was still sent: ${chunkFilter}`);
    // A REASON OF ITS OWN, because the three clear differently and this one clears only when an
    // operator applies the index definition. Naming it as an unknown would tell them to wait for
    // something that is not coming; naming nothing at all — which is what this did — put a key in
    // `dropped.filter` with no reason beside it, the exact shape of an ordinary over-cap drop, so
    // the deploy window was indistinguishable on the wire from a filter this API never supported.
    assert.deepStrictEqual(out.body[0].meta[0].degraded.reasons, ['chunk-parent-fields-missing']);
    assert.deepStrictEqual(Object.keys(out.body[0].meta[0].degraded), ['reasons'],
      `no count may reach the caller: ${JSON.stringify(out.body[0].meta[0].degraded)}`);
  });

  await t.test('the missing-column reason waits for the recovery to run out of room too',
    async (tt) => {
      // Same rule as the other two: the documents index answers the facet in full up to the scope
      // cap, and a page that is not short has nothing to report. Marking on the absent column alone
      // would banner every project-scoped Deep Search for the length of a deploy window.
      stubChunkSearch(tt);
      typeIsMissing(tt);
      tt.mock.method(projectsRepo, 'getByEagleId', async () => null);
      tt.mock.method(aiSearch, 'documentIdsMatching', async () =>
        ({ ids: ['d1'], total: 1, withinCap: true }));

      const { out, res } = capture();
      await searchController.search(anonymous({
        dataset: 'DocumentChunk', keywords: 'river', 'and[type]': '5cf00c03a266b7e1877504e9'
      }), res);

      assert.strictEqual(out.body[0].meta[0].degraded, undefined,
        'a facet answered in full through the documents index is not a degraded page');
    });

  await t.test('a field the live index does not carry is resolved through documents', async (tt) => {
    // AND THE DEPLOY WINDOW KEEPS THE OLD BEHAVIOUR. The facet is inexpressible on the CHUNKS index
    // only; `documents` carries it, and that is exactly what this route did before the chunk copy
    // existed. Taking the key out of the query instead — which is what the first version did — put
    // it past `dropped` and past this recovery, so the one filter the caller sent quietly did
    // nothing for the length of the window the probe exists to cover.
    let chunkFilter = null;
    let docFilter = null;
    stubChunkSearch(tt, f => { chunkFilter = f; });
    typeIsMissing(tt);
    tt.mock.method(projectsRepo, 'getByEagleId', async () => null);
    tt.mock.method(aiSearch, 'documentIdsMatching', async (f) => {
      docFilter = f;
      return { ids: ['d1'], total: 1, withinCap: true };
    });

    const { out, res } = capture();
    await searchController.search(anonymous({
      dataset: 'DocumentChunk',
      keywords: 'river',
      project: '207',
      'and[type]': '5cf00c03a266b7e1877504e9'
    }), res);

    // THE CALLER'S OWN PROJECT SCOPE COMES ALONG, and it is what decides whether the rest fits: a
    // corpus-wide `type` resolves to 2,911 documents and is over the cap, where the project-scoped
    // set is a handful. `project` is never in `dropped` here — chunks carry `projectId` — which is
    // why a `narrowed` object built only from `dropped` would have asked corpus-wide.
    assert.ok(docFilter && docFilter.includes("projectId eq '207'"),
      `the document query must carry the caller's project scope, got: ${docFilter}`);
    assert.ok(docFilter.includes("typeId eq '5cf00c03a266b7e1877504e9'"),
      `and the facet itself, got: ${docFilter}`);
    assert.match(chunkFilter, /search\.in\(documentId, 'd1', ','\)/,
      `the chunk query must be scoped to the resolved documents, got: ${chunkFilter}`);
    assert.ok(!/typeId/.test(chunkFilter), `and never emit the facet itself: ${chunkFilter}`);
    assert.strictEqual(out.body[0].meta[0].dropped, undefined,
      `a recovered key must not be reported as dropped: ${JSON.stringify(out.body[0].meta[0])}`);
  });

  await t.test('the nested and:{} shape is recovered through documents too', async (tt) => {
    // THE RECOVERY READS THE WIRE SHAPE BACK. `recoverChunkFilters` rebuilds a `dropped` base name
    // (`type`) into a query the documents index can be asked with, and it reads the caller's value
    // through `andParams`, which accepts BOTH `and[type]=x` and a nested `and: {type: 'x'}` object.
    // Rebuilding from `query[key]` alone finds nothing under the nested shape, so the key is
    // reported dropped and the filter silently does nothing — a 200 over the unfiltered corpus.
    // Unreachable under the shipped parser, which is exactly what makes it the kind of thing a
    // parser swap turns on with no test to catch it.
    let chunkFilter = null;
    let docFilter = null;
    stubChunkSearch(tt, f => { chunkFilter = f; });
    typeIsMissing(tt);
    tt.mock.method(aiSearch, 'documentIdsMatching', async (f) => {
      docFilter = f;
      return { ids: ['d1'], total: 1, withinCap: true };
    });

    const { out, res } = capture();
    await searchController.search(anonymous({
      dataset: 'DocumentChunk',
      keywords: 'river',
      and: { type: '5cf00c03a266b7e1877504e9' }
    }), res);

    assert.ok(docFilter && docFilter.includes("typeId eq '5cf00c03a266b7e1877504e9'"),
      `the nested value must reach the documents index, got: ${docFilter}`);
    assert.match(chunkFilter, /search\.in\(documentId, 'd1', ','\)/,
      `and the chunk query must be scoped to what it matched, got: ${chunkFilter}`);
    assert.strictEqual(out.body[0].meta[0].dropped, undefined,
      `a recovered key must not be reported as dropped: ${JSON.stringify(out.body[0].meta[0])}`);
  });

  await t.test('no matching document answers nothing, and says the filter ran', async (tt) => {
    // Zero matches is the filter WORKING. Reported as dropped, it would read as "we could not
    // apply this", which sends the caller looking for rows that are correctly not there.
    let chunkFilter = null;
    stubChunkSearch(tt, f => { chunkFilter = f; });
    typeIsMissing(tt);
    tt.mock.method(aiSearch, 'searchChunks', async (opts) => {
      chunkFilter = opts.filter;
      return { count: 0, items: [] };
    });
    tt.mock.method(aiSearch, 'documentIdsMatching', async () =>
      ({ ids: [], total: 0, withinCap: true }));

    const { out, res } = capture();
    await searchController.search(anonymous({
      dataset: 'DocumentChunk', keywords: 'river', 'and[type]': '5cf00c03a266b7e1877504e9'
    }), res);

    assert.match(chunkFilter, /documentId eq ''/, 'a clause that cannot match, not a dropped filter');
    assert.deepStrictEqual(out.body[0].searchResults, []);
    assert.strictEqual(out.body[0].meta[0].dropped, undefined, 'zero matches is the filter WORKING');
  });

  await t.test('a filter the live index CAN answer is still sent', async (tt) => {
    let chunkFilter = null;
    stubChunkSearch(tt, f => { chunkFilter = f; });
    stubStatus(tt, {
      known: true, available: chunksRepo.CHUNK_PARENT_FIELDS.slice(), missing: [], unstamped: 0
    });

    const { out, res } = capture();
    await searchController.search(anonymous({
      dataset: 'DocumentChunk', keywords: 'river', 'and[type]': '5cf00c03a266b7e1877504e9'
    }), res);

    assert.ok(chunkFilter.includes("typeId eq '5cf00c03a266b7e1877504e9'"), chunkFilter);
    assert.strictEqual(out.body[0].meta[0].dropped, undefined);
  });

  // A live index that carries all four columns and a scope the backfill has not finished stamping.
  // The column being present is what the schema probe answers; whether the ROWS hold a value is a
  // different question, and it is the one that decides whether a clause over that column measures
  // anything.
  const carriedButBehind = (tt, behind = 4210) => {
    stubStatus(tt, {
      known: true, available: chunksRepo.CHUNK_PARENT_FIELDS.slice(), missing: [], unstamped: behind
    });
    tt.mock.method(aiSearch, 'staleChunkCount', async () => behind);
    searchController.resetStaleChunkScopeCache();
  };

  await t.test('an unstamped scope sends the facet to the documents index, not the chunk query',
    async (tt) => {
      // THE DEFECT. A column the index carries but the backfill has not filled holds `null` on
      // every chunk it has not reached, so `milestoneId eq 'm1'` over it is not a narrower answer —
      // it is zero rows under a 200, which reads as "this project has no such documents". The
      // schema probe cannot see it: the column is there and the clause is valid. Withheld, the key
      // is dropped, and dropped is what the documents index answers — the same path that served
      // this filter before a chunk carried a copy at all.
      let chunkFilter = null;
      let docFilter = null;
      stubChunkSearch(tt, f => { chunkFilter = f; });
      carriedButBehind(tt);
      tt.mock.method(aiSearch, 'documentIdsMatching', async (f) => {
        docFilter = f;
        return { ids: ['d1'], total: 1, withinCap: true };
      });

      const { out, res } = capture();
      await searchController.search(anonymous({
        dataset: 'DocumentChunk', keywords: 'river', 'and[milestone]': 'm1'
      }), res);

      assert.ok(!/milestoneId/.test(chunkFilter),
        `a clause over an unstamped column was emitted anyway: ${chunkFilter}`);
      assert.ok(docFilter && docFilter.includes("milestoneId eq 'm1'"),
        `the facet must be answered through the documents index, got: ${docFilter}`);
      assert.match(chunkFilter, /search\.in\(documentId, 'd1', ','\)/,
        `and the chunk query scoped to what it matched, got: ${chunkFilter}`);
      assert.strictEqual(out.body[0].meta[0].dropped, undefined,
        `a recovered key must not be reported as dropped: ${JSON.stringify(out.body[0].meta[0])}`);
      assert.strictEqual(out.body[0].meta[0].degraded, undefined,
        'a filter answered correctly through another index is not a degraded page');
    });

  await t.test('the mark is for the recovery that ran out of room, not for the backfill',
    async (tt) => {
      // The one state with nowhere left to go: the scope is mid-backfill AND the documents-index
      // recovery is over the scope cap, so the page really is short. Marking on the backfill alone
      // put this banner in front of every filtered Deep Search for the length of a backfill run,
      // including the ones the recovery answered in full.
      stubChunkSearch(tt);
      carriedButBehind(tt);
      tt.mock.method(aiSearch, 'documentIdsMatching', async () =>
        ({ ids: [], total: 4000, withinCap: false }));

      const { out, res } = capture();
      await searchController.search(anonymous({
        dataset: 'DocumentChunk', keywords: 'river', 'and[milestone]': 'm1'
      }), res);

      assert.deepStrictEqual(out.body[0].meta[0].degraded.reasons, ['chunk-parent-fields-unstamped']);
      // THE REASON, NEVER THE NUMBER. This route is reachable anonymously, and the number behind
      // the mark is a backfill statistic nobody outside can act on — the named reason is the whole
      // of what a UI can render.
      assert.deepStrictEqual(Object.keys(out.body[0].meta[0].degraded), ['reasons'],
        `no count may reach the caller: ${JSON.stringify(out.body[0].meta[0].degraded)}`);
      assert.deepStrictEqual(out.body[0].meta[0].dropped.filter, ['milestone'],
        'and the key it could not answer is named');
    });

  await t.test('a backfill state the service could not report is not a stamped one', async (tt) => {
    // `unstamped: null` is "the index cannot tell" — a live index carrying the four columns but no
    // version stamp, and a scoped count that cannot answer either. UNKNOWN IS NOT ZERO in either
    // direction: nothing may be marked off it, and nothing may be filtered on it. Sending the
    // clause on the optimistic reading is the zero-rows-under-a-200 above; the documents index has
    // no stamp to be behind on, so that is where the key goes.
    let chunkFilter = null;
    let docFilter = null;
    stubChunkSearch(tt, f => { chunkFilter = f; });
    stubStatus(tt, {
      known: true, available: chunksRepo.CHUNK_PARENT_FIELDS.slice(), missing: [], unstamped: null
    });
    tt.mock.method(aiSearch, 'staleChunkCount', async () => null);
    searchController.resetStaleChunkScopeCache();
    tt.mock.method(aiSearch, 'documentIdsMatching', async (f) => {
      docFilter = f;
      return { ids: ['d1'], total: 1, withinCap: true };
    });

    const { out, res } = capture();
    await searchController.search(anonymous({
      dataset: 'DocumentChunk', keywords: 'river', 'and[milestone]': 'm1'
    }), res);

    assert.ok(!/milestoneId/.test(chunkFilter),
      `a clause was applied while the stamp state was unknown: ${chunkFilter}`);
    assert.ok(docFilter && docFilter.includes("milestoneId eq 'm1'"),
      `the facet must still be answered, got: ${docFilter}`);
    assert.strictEqual(out.body[0].meta[0].degraded, undefined,
      'a mark nobody can clear is a mark nobody reads');
  });

  await t.test('an unknown stamp state marks the short page as unknown, not as a backlog',
    async (tt) => {
      // The other half of the same rule. The page IS short here — the recovery ran out of room —
      // and the caller has to be told, because a filter named in `dropped` with no reason beside it
      // reads as a key this API never supported. But "the backfill is behind" is a claim about the
      // corpus and the count that would support it went unanswered, so what is reported is the
      // unanswered question, which clears when the service answers again.
      stubChunkSearch(tt);
      stubStatus(tt, {
        known: true, available: chunksRepo.CHUNK_PARENT_FIELDS.slice(), missing: [], unstamped: null
      });
      tt.mock.method(aiSearch, 'staleChunkCount', async () => null);
      searchController.resetStaleChunkScopeCache();
      tt.mock.method(aiSearch, 'documentIdsMatching', async () =>
        ({ ids: [], total: 4000, withinCap: false }));

      const { out, res } = capture();
      await searchController.search(anonymous({
        dataset: 'DocumentChunk', keywords: 'river', 'and[milestone]': 'm1'
      }), res);

      assert.deepStrictEqual(out.body[0].meta[0].degraded.reasons, ['chunk-parent-fields-unknown'],
        'an unanswered count may not be reported as a measured backlog');
      assert.deepStrictEqual(out.body[0].meta[0].dropped.filter, ['milestone']);
    });

  await t.test('a probe shape the service never promised does not 502 the tab', async (tt) => {
    // The reader takes `available` off whatever the probe resolved with, and the probe now resolves
    // rather than rejects on a failure — an object with no field list at all is what that recovery
    // is closest to. Reading `.available` off it unguarded throws, and this route answers a throw
    // with 502 over the whole Deep Search tab.
    let chunkFilter = null;
    stubChunkSearch(tt, f => { chunkFilter = f; });
    stubStatus(tt, { known: false });
    tt.mock.method(aiSearch, 'documentIdsMatching', async () =>
      ({ ids: [], total: 4000, withinCap: false }));

    const { out, res } = capture();
    await searchController.search(anonymous({
      dataset: 'DocumentChunk', keywords: 'river', 'and[milestone]': 'm1'
    }), res);

    assert.strictEqual(out.status, undefined, 'the page must still answer 200');
    assert.ok(!/milestoneId/.test(chunkFilter), chunkFilter);
    assert.deepStrictEqual(out.body[0].meta[0].dropped.filter, ['milestone']);
  });

  await t.test('a finished backfill leaves the page unmarked', async (tt) => {
    stubChunkSearch(tt);
    stubStatus(tt, {
      known: true, available: chunksRepo.CHUNK_PARENT_FIELDS.slice(), missing: [], unstamped: 0
    });

    const { out, res } = capture();
    await searchController.search(anonymous({
      dataset: 'DocumentChunk', keywords: 'river', 'and[milestone]': 'm1'
    }), res);

    assert.strictEqual(out.body[0].meta[0].degraded, undefined,
      'a mark nobody can clear is a mark nobody reads');
  });

  await t.test('a search naming no facet asks the service nothing', async (tt) => {
    // The probe is cached, but a chunk search that filters on nothing must not depend on it at all
    // — Deep Search with no filter panel open is the commonest request there is.
    let asked = 0;
    stubChunkSearch(tt);
    tt.mock.method(aiSearch, 'chunkParentFieldStatus', async () => {
      asked += 1;
      return { known: true, available: [], missing: [], unstamped: 0 };
    });

    const { res } = capture();
    await searchController.search(
      anonymous({ dataset: 'DocumentChunk', keywords: 'river' }), res);

    assert.strictEqual(asked, 0);
  });

  await t.test('a probe that could not run never sends the facet to the live index', async (tt) => {
    // `known: false` is "the question was not answered", and the unknown that matters is the one
    // the probe exists for: the app is live and the index PUT has not happened yet. Sending the
    // clause on a guess is a 400, which this route answers as 502 — the whole Deep Search tab, for
    // every caller, not only the ones filtering. Withholding it costs one filter, and the caller is
    // told which one.
    let chunkFilter = null;
    stubChunkSearch(tt, f => { chunkFilter = f; });
    stubStatus(tt, { known: false, available: [], missing: [], unstamped: null });
    tt.mock.method(aiSearch, 'documentIdsMatching', async () =>
      ({ ids: [], total: 4000, withinCap: false }));

    const { out, res } = capture();
    await searchController.search(anonymous({
      dataset: 'DocumentChunk', keywords: 'river', 'and[type]': '5cf00c03a266b7e1877504e9'
    }), res);

    assert.ok(!/typeId/.test(chunkFilter),
      `a clause the probe could not vouch for was sent anyway: ${chunkFilter}`);
    assert.strictEqual(out.status, undefined, 'the page must still answer 200');
    assert.deepStrictEqual(out.body[0].meta[0].dropped.filter, ['type']);
  });

  await t.test('a probe that could not run leaves the facet to the documents index', async (tt) => {
    // And the drop is not the end of it. `dropped` is the input to the documents-index recovery, so
    // a facet the chunks index cannot be vouched for is still answered — by the index that answered
    // it before a chunk carried a copy at all, which is the whole reason it is dropped rather than
    // deleted from the query.
    let chunkFilter = null;
    let docFilter = null;
    stubChunkSearch(tt, f => { chunkFilter = f; });
    stubStatus(tt, { known: false, available: [], missing: [], unstamped: null });
    tt.mock.method(aiSearch, 'documentIdsMatching', async (f) => {
      docFilter = f;
      return { ids: ['d1'], total: 1, withinCap: true };
    });

    const { out, res } = capture();
    await searchController.search(anonymous({
      dataset: 'DocumentChunk', keywords: 'river', 'and[type]': '5cf00c03a266b7e1877504e9'
    }), res);

    assert.ok(docFilter && docFilter.includes("typeId eq '5cf00c03a266b7e1877504e9'"),
      `the facet must reach the documents index, got: ${docFilter}`);
    assert.match(chunkFilter, /search\.in\(documentId, 'd1', ','\)/,
      `and the chunk query must be scoped to what it matched, got: ${chunkFilter}`);
    assert.strictEqual(out.body[0].meta[0].dropped, undefined,
      `a recovered key must not be reported as dropped: ${JSON.stringify(out.body[0].meta[0])}`);
    assert.strictEqual(out.body[0].meta[0].degraded, undefined,
      'a filter the documents index answered in full is not a degraded page, whatever the probe said');
  });

  await t.test('only the columns a facet filters on are probed', async (tt) => {
    // `projectId` is stamped beside the four List refs, but no facet filters on it and the probe
    // costs one service request per field on a cold cache. The request is the smaller half: a
    // `projectId` probe that comes back undecided withholds every facet in the request over a
    // column nobody asked about.
    let probed = null;
    stubChunkSearch(tt);
    tt.mock.method(aiSearch, 'chunkParentFieldStatus', async (fields) => {
      probed = fields;
      return {
        known: true, available: chunksRepo.CHUNK_PARENT_LIST_REFS.slice(), missing: [], unstamped: 0
      };
    });

    const { res } = capture();
    await searchController.search(anonymous({
      dataset: 'DocumentChunk', keywords: 'river', 'and[milestone]': 'm1'
    }), res);

    assert.deepStrictEqual(probed, chunksRepo.CHUNK_PARENT_LIST_REFS,
      'the probe must ask about exactly the columns a facet can filter on');
  });

  await t.test('a facet withheld on an unanswered probe is named as unknown, not as unstamped',
    async (tt) => {
      // The state that had no reason at all: one field's probe died, so that facet is withheld,
      // and the documents-index recovery that should have answered it was over the cap. The page
      // is short and nothing said why — a key in `dropped` with no reason beside it reads as a
      // filter this API does not support, rather than as one that will work again shortly.
      stubChunkSearch(tt);
      stubStatus(tt, {
        known: false, available: ['milestoneId'], missing: [],
        unknown: ['typeId', 'projectPhaseId', 'documentAuthorTypeId'], unstamped: null
      });
      tt.mock.method(aiSearch, 'staleChunkCount', async () => 0);
      searchController.resetStaleChunkScopeCache();
      tt.mock.method(aiSearch, 'documentIdsMatching', async () =>
        ({ ids: [], total: 4000, withinCap: false }));

      const { out, res } = capture();
      await searchController.search(anonymous({
        dataset: 'DocumentChunk', keywords: 'river', 'and[type]': '5cf00c03a266b7e1877504e9'
      }), res);

      assert.deepStrictEqual(out.body[0].meta[0].degraded.reasons, ['chunk-parent-fields-unknown']);
      assert.deepStrictEqual(out.body[0].meta[0].dropped.filter, ['type']);
    });

  await t.test('a probe that only got partway keeps the fields it did settle', async (tt) => {
    // A probe asks one question per field and can die on the third. Answering that with "nothing
    // is known" drops every facet in the request over one field's hiccup, so the probe reports per
    // field and this route sends exactly the ones it vouched for.
    let chunkFilter = null;
    stubChunkSearch(tt, f => { chunkFilter = f; });
    stubStatus(tt, {
      known: false, available: ['milestoneId'], missing: [],
      unknown: ['typeId', 'projectPhaseId', 'documentAuthorTypeId'], unstamped: null
    });
    // A partial schema answer carries no index-wide count, so the stamp state is decided under this
    // request's own scope — stamped here, or the settled field would be withheld for that instead
    // and this case would be measuring the backfill rather than the probe.
    tt.mock.method(aiSearch, 'staleChunkCount', async () => 0);
    searchController.resetStaleChunkScopeCache();
    tt.mock.method(aiSearch, 'documentIdsMatching', async () =>
      ({ ids: [], total: 4000, withinCap: false }));

    const { out, res } = capture();
    await searchController.search(anonymous({
      dataset: 'DocumentChunk',
      keywords: 'river',
      'and[type]': '5cf00c03a266b7e1877504e9',
      'and[milestone]': '5cf00c03a266b7e1877504ef'
    }), res);

    assert.match(chunkFilter, /milestoneId eq '5cf00c03a266b7e1877504ef'/,
      `the settled facet must still be sent, got: ${chunkFilter}`);
    assert.ok(!/typeId/.test(chunkFilter),
      `the unsettled facet was sent anyway: ${chunkFilter}`);
    assert.deepStrictEqual(out.body[0].meta[0].dropped.filter, ['type']);
    // The page is short by the one facet the recovery could not absorb, and the caller is told
    // which kind of short it is — the settled facet beside it does not make the page whole.
    assert.deepStrictEqual(out.body[0].meta[0].degraded.reasons, ['chunk-parent-fields-unknown']);
  });
});

test('the unstamped-backfill mark is measured over the rows the caller asked for', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  // The counts outlive a test by the schema TTL, so without this the assertions below would be
  // measuring which test ran first.
  t.beforeEach(() => searchController.resetStaleChunkScopeCache());

  const chunk = { chunkId: 'd1::p1::c0', documentId: 'd1', projectId: '207', pageNumber: 1, snippet: 'x' };

  // Index-wide, something is behind. That is the state in which the question "is anything behind
  // for THIS caller" is worth asking, and the state in which the old corpus-wide gate marked every
  // page there was.
  const somethingIsBehindSomewhere = tt =>
    tt.mock.method(aiSearch, 'chunkParentFieldStatus', async () => ({
      known: true, available: chunksRepo.CHUNK_PARENT_FIELDS.slice(), missing: [], unstamped: 4210
    }));

  // The clause is `ai-search`'s to build — this route's job is to hand it the scope the page was
  // read under, so what is asserted here is the ARGUMENT, not the OData it renders to.
  const stubScopedCount = (tt, count, onFilter) => {
    const probes = [];
    tt.mock.method(documentsRepo, 'listByIds', async () => ([{ id: 'd1', displayName: 'A' }]));
    tt.mock.method(projectsRepo, 'listByIds', async () => ([{ id: '207', name: 'Site C' }]));
    tt.mock.method(aiSearch, 'searchChunks', async (opts) => {
      if (onFilter) onFilter(opts.filter);
      return { count: 1, items: [chunk] };
    });
    tt.mock.method(aiSearch, 'staleChunkCount', async (opts) => {
      probes.push(opts);
      return count;
    });
    return probes;
  };

  await t.test('the count is taken under the caller\'s own predicate and project scope', async (tt) => {
    // THE RULE THIS FILE STATES ELSEWHERE: a count answered under a different predicate than the
    // rows is a count of something the caller did not ask about.
    const probes = stubScopedCount(tt, 4210);
    somethingIsBehindSomewhere(tt);

    const { res } = capture();
    await searchController.search(anonymous({
      dataset: 'DocumentChunk', keywords: 'river', project: '207', 'and[milestone]': 'm1'
    }), res);

    assert.strictEqual(probes.length, 1, 'the scope is counted, once');
    assert.strictEqual(probes[0].version, chunksRepo.CHUNK_PARENT_FIELDS_VERSION,
      'the revision the write side stamps is what a stale chunk is measured against');
    assert.deepStrictEqual(probes[0].projectIds, ['207'],
      'the count must carry the request\'s project scope');
    assert.ok(probes[0].aclFilter && probes[0].aclFilter.includes("'public'"),
      `and the caller's ACL, or it counts rows they cannot see: ${probes[0].aclFilter}`);
  });

  await t.test('a scope with nothing behind filters the chunks directly', async (tt) => {
    // The whole point, and now both halves of it. One project mid-backfill used to put "filter
    // partially applied" on every other project's page for the length of the backfill, over rows
    // that are all stamped — and a corpus-wide backlog must not push a fully stamped scope's facet
    // onto the documents index and its cap either. A stamped scope is the fast path.
    let chunkFilter = null;
    const probes = stubScopedCount(tt, 0, f => { chunkFilter = f; });
    somethingIsBehindSomewhere(tt);
    let resolvedThroughDocuments = 0;
    tt.mock.method(aiSearch, 'documentIdsMatching', async () => {
      resolvedThroughDocuments += 1;
      return { ids: [], total: 0, withinCap: true };
    });

    const { out, res } = capture();
    await searchController.search(anonymous({
      dataset: 'DocumentChunk', keywords: 'river', project: '901', 'and[milestone]': 'm1'
    }), res);

    assert.strictEqual(probes.length, 1, 'the scope was asked about at all');
    assert.ok(chunkFilter && chunkFilter.includes("milestoneId eq 'm1'"),
      `a stamped scope must filter on the chunk row itself, got: ${chunkFilter}`);
    assert.strictEqual(resolvedThroughDocuments, 0,
      'and must not pay the documents-index round trip or its cap');
    assert.strictEqual(out.body[0].meta[0].degraded, undefined,
      'a page whose own rows are stamped must not carry a mark for a backfill elsewhere');
  });

  await t.test('a request with no project scope still counts under the ACL', async (tt) => {
    // The corpus-wide read is not the unscoped read: nothing invents a project the caller did not
    // name, and the ACL is the scope that is always there.
    const probes = stubScopedCount(tt, 4210);
    somethingIsBehindSomewhere(tt);
    // Over the cap, which is what turns a withheld facet into a page that is actually short. Under
    // it the documents index answers the filter in full and there is nothing to mark.
    tt.mock.method(aiSearch, 'documentIdsMatching', async () =>
      ({ ids: [], total: 4000, withinCap: false }));

    const { out, res } = capture();
    await searchController.search(anonymous({
      dataset: 'DocumentChunk', keywords: 'river', 'and[milestone]': 'm1'
    }), res);

    assert.deepStrictEqual(probes[0].projectIds, [],
      'no project scope may be invented');
    assert.ok(probes[0].aclFilter.includes("'public'"),
      `the ACL still applies, got: ${probes[0].aclFilter}`);
    assert.deepStrictEqual(out.body[0].meta[0].degraded.reasons, ['chunk-parent-fields-unstamped']);
  });

  await t.test('two scopes do not share one count', async (tt) => {
    // A cache keyed on anything less than the scope answers one project's question with another
    // project's number, which is the defect one level down from the one above.
    const probes = stubScopedCount(tt, 4210);
    somethingIsBehindSomewhere(tt);

    for (const project of ['903', '904']) {
      const { res } = capture();
      await searchController.search(anonymous({
        dataset: 'DocumentChunk', keywords: 'river', project, 'and[milestone]': 'm1'
      }), res);
    }

    assert.strictEqual(probes.length, 2, 'each scope is counted for itself');
    assert.deepStrictEqual(probes[1].projectIds, ['904'],
      'the second count is the second scope');
  });

  await t.test('the same scope is counted once', async (tt) => {
    // Deep Search is issued on a debounced keystroke. A count per request would double the cost of
    // every filtered search on the tab.
    const probes = stubScopedCount(tt, 4210);
    somethingIsBehindSomewhere(tt);

    const keystroke = () => searchController.search(anonymous({
      dataset: 'DocumentChunk', keywords: 'river', project: '905', 'and[milestone]': 'm1'
    }), capture().res);
    await keystroke();
    await keystroke();

    assert.strictEqual(probes.length, 1, 'the second request reads the cached count');
  });

  // A count of `null` is `staleChunkCount` RESOLVING with "cannot say" — an index carrying no stamp
  // column answers that, and so does a version this process could not supply. It is not a fact
  // about the backfill, and the two cases below are the same rule the schema probe already applies
  // to `known: false`.
  const keystrokeOn = project => searchController.search(anonymous({
    dataset: 'DocumentChunk', keywords: 'river', project, 'and[milestone]': 'm1'
  }), capture().res);

  await t.test('a count the service could not answer is re-asked in seconds', async (tt) => {
    tt.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-09T12:00:00Z') });
    const probes = stubScopedCount(tt, null);
    somethingIsBehindSomewhere(tt);

    await keystrokeOn('906');
    assert.strictEqual(probes.length, 1);

    tt.mock.timers.tick(aiSearch.UNKNOWN_STATUS_TTL_MS);
    await keystrokeOn('906');
    assert.strictEqual(probes.length, 2,
      'an unanswerable scope was pinned for the ten-minute schema TTL');
  });

  await t.test('the scope being searched hardest is not the one evicted', async (tt) => {
    // The map is bounded at 32 scopes, and eviction takes the oldest INSERTION. Without a hit
    // moving its key back to the end, "oldest insertion" means the scope that has been searched
    // continuously since the process started — the busiest one on the box — while 32 one-off
    // reads keep their entries. It evicts exactly backwards, and the cost is a count request per
    // keystroke on the tab that is actually in use.
    const probes = stubScopedCount(tt, 4210);
    somethingIsBehindSomewhere(tt);
    tt.mock.method(aiSearch, 'documentIdsMatching', async () =>
      ({ ids: [], total: 4000, withinCap: false }));

    const busy = '800';
    await keystrokeOn(busy);
    // 31 other scopes: with `busy` that is exactly the 32 the map holds, so nothing is evicted yet.
    for (let i = 0; i < 31; i++) await keystrokeOn(`81${i}`);
    // The busy tab, still being typed in. A cache HIT — and the only thing that can save it.
    await keystrokeOn(busy);
    // One more scope tips the map over its bound and something has to go.
    await keystrokeOn('899');
    await keystrokeOn(busy);

    const busyProbes = probes.filter(p => p.projectIds[0] === busy);
    assert.strictEqual(busyProbes.length, 1,
      'the scope with a hit inside the window was evicted ahead of 31 idle ones');
  });

  await t.test('a count the service DID answer is held for the full schema TTL', async (tt) => {
    // The other half: demoting every entry would put a count request back on every keystroke past
    // 30 seconds, which is what the cache exists to prevent.
    tt.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-09T12:00:00Z') });
    const probes = stubScopedCount(tt, 4210);
    somethingIsBehindSomewhere(tt);

    await keystrokeOn('907');
    tt.mock.timers.tick(aiSearch.UNKNOWN_STATUS_TTL_MS);
    await keystrokeOn('907');

    assert.strictEqual(probes.length, 1, 'an answered count is a fact, and it keeps for the TTL');
  });
});

test('chunk filters land on the chunks index itself', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const chunk = { chunkId: 'd1::p1::c0', documentId: 'd1', projectId: '207', pageNumber: 1, snippet: 'x' };
  const stubHydration = (tt) => {
    tt.mock.method(documentsRepo, 'listByIds', async () => ([{ id: 'd1', displayName: 'A', type: 'Letter' }]));
    tt.mock.method(projectsRepo, 'listByIds', async () => ([{ id: '207', name: 'Site C' }]));
  };
  // ONE service call. The filter used to be resolved by querying `documents` for matching ids and
  // scoping the chunk query to them, which is bounded by what a single request returns — every
  // filter measured on prod was over that bound and came back reported as inexpressible. A second
  // read appearing here means that design is back.
  const onlyChunkCall = (tt, onFilter) => {
    let calls = 0;
    // THE PREMISE OF THIS SUITE: a live index that carries all four parent fields. Left unstubbed
    // the probe answers `known: false` here — no SEARCH_ENDPOINT in a test process — and an
    // unanswered probe is UNEXPRESSIBLE, so every facet below would be dropped and this suite
    // would be measuring the deploy window instead of the filter. `unstamped: 0` keeps it to one
    // service call: a corpus with nothing behind is never re-counted per scope.
    tt.mock.method(aiSearch, 'chunkParentFieldStatus', async () => ({
      known: true, available: chunksRepo.CHUNK_PARENT_FIELDS.slice(), missing: [], unstamped: 0
    }));
    tt.mock.method(aiSearch, 'searchDocuments', async () => { calls += 1; return { count: 0, items: [] }; });
    tt.mock.method(aiSearch, 'searchChunks', async (opts) => {
      onFilter(opts.filter);
      return { count: 1, items: [chunk] };
    });
    return () => calls;
  };

  await t.test('a multi-select type becomes one OR group on the chunk query', async (tt) => {
    // The measured defect this closes: `and[type]=<id>` on DocumentChunk answered 399,872 hits,
    // identical to no filter, where prod answered 0. `chunks` now carries `typeId`.
    let chunkFilter = null;
    const documentReads = onlyChunkCall(tt, f => { chunkFilter = f; });
    stubHydration(tt);

    const { out, res } = capture();
    await searchController.search(anonymous({
      dataset: 'DocumentChunk',
      keywords: 'river',
      'and[type]': '5cf00c03a266b7e1877504e9,5cf00c03a266b7e1877504cf'
    }), res);

    assert.ok(chunkFilter.includes(
      "(typeId eq '5cf00c03a266b7e1877504e9' or typeId eq '5cf00c03a266b7e1877504cf')"),
    `both ids must be ORed onto the chunk field, got: ${chunkFilter}`);
    assert.ok(chunkFilter.includes("'public'"), 'and the ACL still gates it');
    assert.ok(!/search\.in\(documentId/.test(chunkFilter),
      `no document-id scope may be built, got: ${chunkFilter}`);
    assert.strictEqual(documentReads(), 0, 'and no documents index read is issued');
    assert.strictEqual(out.body[0].meta[0].dropped, undefined,
      `an applied key must not be reported dropped: ${JSON.stringify(out.body[0].meta[0])}`);
  });

  await t.test('all four document facets are expressible, alongside the project scope', async (tt) => {
    // All four together, because they are one shared table in `eagle-query.ALIASES` and a test for
    // `type` alone would pass with the other three still missing from the chunk index.
    let chunkFilter = null;
    onlyChunkCall(tt, f => { chunkFilter = f; });
    stubHydration(tt);
    tt.mock.method(projectsRepo, 'getByEagleId', async () => null);

    const { out, res } = capture();
    await searchController.search(anonymous({
      dataset: 'DocumentChunk',
      keywords: 'river',
      project: '207',
      'and[milestone]': 'm1',
      'and[projectPhase]': 'p1',
      'and[documentAuthorType]': 'a1'
    }), res);

    assert.ok(chunkFilter.includes("milestoneId eq 'm1'"), chunkFilter);
    assert.ok(chunkFilter.includes("projectPhaseId eq 'p1'"), chunkFilter);
    assert.ok(chunkFilter.includes("documentAuthorTypeId eq 'a1'"), chunkFilter);
    assert.ok(chunkFilter.includes("projectId eq '207'"), chunkFilter);
    assert.strictEqual(out.body[0].meta[0].dropped, undefined);
  });

  await t.test('the nested and:{} wire shape reaches the chunk query too', async (tt) => {
    // `andParams` accepts BOTH shapes — `and[type]=x` and a nested `and: {type: 'x'}` object, which
    // is what a qs/extended parser produces. Unreachable under the shipped parser, which is
    // precisely what makes it the kind of thing a parser swap turns on silently.
    let chunkFilter = null;
    onlyChunkCall(tt, f => { chunkFilter = f; });
    stubHydration(tt);

    const { out, res } = capture();
    await searchController.search(anonymous({
      dataset: 'DocumentChunk',
      keywords: 'river',
      and: { type: '5cf00c03a266b7e1877504cf' }
    }), res);

    assert.ok(chunkFilter.includes("typeId eq '5cf00c03a266b7e1877504cf'"),
      `the nested shape must reach the chunk query, got: ${chunkFilter}`);
    assert.strictEqual(out.body[0].meta[0].dropped, undefined);
  });

  await t.test('a key the chunks index cannot express is still reported as dropped', async (tt) => {
    // `documentAuthor` is in no demi index at all. Sent alongside a key that IS expressible,
    // because the failure this closes is reporting a working filter and an inexpressible one
    // identically — in either direction.
    let chunkFilter = null;
    onlyChunkCall(tt, f => { chunkFilter = f; });
    stubHydration(tt);

    const { out, res } = capture();
    await searchController.search(anonymous({
      dataset: 'DocumentChunk',
      keywords: 'river',
      'and[type]': '5cf00c03a266b7e1877504e9',
      'and[documentAuthor]': 'x'
    }), res);

    assert.deepStrictEqual(out.body[0].meta[0].dropped.filter, ['documentAuthor'],
      'the expressible key applied and only the unexpressible one is named');
    assert.ok(chunkFilter.includes("typeId eq '5cf00c03a266b7e1877504e9'"), chunkFilter);
  });

  await t.test('a document-only key is still resolved through the documents index', async (tt) => {
    // THE RESIDUE. A chunk carries no `datePosted`, so the only way to answer a date range on Deep
    // Search is to ask which documents match and scope the chunk query to their ids. That path was
    // deleted along with the facet resolver it also served, which silently turned every date,
    // `isFeatured`, `legislation` and `documentSource` filter on this dataset into no filter at all.
    let chunkFilter = null;
    let docFilter = null;
    onlyChunkCall(tt, f => { chunkFilter = f; });
    stubHydration(tt);
    tt.mock.method(aiSearch, 'documentIdsMatching', async (f) => {
      docFilter = f;
      return { ids: ['d1', 'd2'], total: 2, withinCap: true };
    });

    const { out, res } = capture();
    await searchController.search(anonymous({
      dataset: 'DocumentChunk', keywords: 'river', 'and[datePostedStart]': '2020-01-01'
    }), res);

    assert.ok(docFilter && docFilter.includes('2020-01-01'),
      `the document query must carry the caller's own value, got: ${docFilter}`);
    assert.match(chunkFilter, /search\.in\(documentId, 'd1,d2', ','\)/,
      `the chunk query must be scoped to the resolved documents, got: ${chunkFilter}`);
    assert.ok(chunkFilter.includes("'public'"), 'and the ACL still gates it');
    assert.strictEqual(out.body[0].meta[0].dropped, undefined,
      `a recovered key must not be reported as dropped: ${JSON.stringify(out.body[0].meta[0])}`);
  });

  await t.test('a facet never reaches the documents index', async (tt) => {
    // The inverse, and the whole point of the chunk copy: `type` is answerable on the chunk row, so
    // resolving it through documents would put the 249-document cap back in front of the one filter
    // eagle-public sends most.
    let resolved = 0;
    onlyChunkCall(tt, () => {});
    stubHydration(tt);
    tt.mock.method(aiSearch, 'documentIdsMatching', async () => {
      resolved += 1;
      return { ids: [], total: 0, withinCap: true };
    });

    const { res } = capture();
    await searchController.search(anonymous({
      dataset: 'DocumentChunk', keywords: 'river', 'and[type]': '5cf00c03a266b7e1877504e9'
    }), res);

    assert.strictEqual(resolved, 0, 'a facet was resolved through the documents index');
  });

  await t.test('an over-cap document set leaves the key reported as dropped', async (tt) => {
    // A truncated scope would answer "the chunks matching your filter" about a subset nobody chose,
    // and the caller could not tell it from a complete answer.
    let chunkFilter = null;
    onlyChunkCall(tt, f => { chunkFilter = f; });
    stubHydration(tt);
    tt.mock.method(aiSearch, 'documentIdsMatching', async () =>
      ({ ids: [], total: 4000, withinCap: false }));

    const { out, res } = capture();
    await searchController.search(anonymous({
      dataset: 'DocumentChunk', keywords: 'river', 'and[datePostedStart]': '2020-01-01'
    }), res);

    assert.deepStrictEqual(out.body[0].meta[0].dropped.filter, ['datePostedStart']);
    assert.ok(!/search\.in\(documentId/.test(chunkFilter),
      `no partial scope may be applied, got: ${chunkFilter}`);
  });

  await t.test('the size of the matching document set no longer decides anything', async (tt) => {
    // The inversion. `type` matches 2,911 documents on prod, `projectPhase` 1,425, `milestone`
    // 36,471 — every one of them over the old 249-document scoping bound, so every one of them was
    // answered UNFILTERED with the key named in `meta.dropped`. Nothing counts documents now, so a
    // corpus-wide filter is applied exactly like a project-scoped one.
    let chunkFilter = null;
    const documentReads = onlyChunkCall(tt, f => { chunkFilter = f; });
    stubHydration(tt);

    const { out, res } = capture();
    await searchController.search(
      anonymous({ dataset: 'DocumentChunk', keywords: 'river', 'and[milestone]': 'm1' }), res);

    assert.strictEqual(documentReads(), 0, 'no document count is taken');
    assert.ok(chunkFilter.includes("milestoneId eq 'm1'"), chunkFilter);
    assert.strictEqual(out.body[0].meta[0].dropped, undefined,
      'a broad filter is applied, not reported inexpressible');
  });

  // A CREDENTIAL NAMES A FIELD, AND THE FIELD DIFFERS PER INDEX: a document-scoped grant compares
  // `documentId` on chunks and `id` on documents. Sending the chunk clause to the documents index
  // is a 400 naming `documentId`, which this route answers as 502 — every Deep Search with a
  // document-only key, for every holder of such a credential.
  const holding = (query, scope) => ({
    query,
    header: () => null,
    user: { sub: 'bceid-1', realm_access: { roles: ['public'] } },
    credentials: [{ id: 'cred-1', party: { type: 'user', id: 'bceid-1' }, scope, levels: [2] }]
  });

  await t.test('a document-scoped credential resolves through the documents index', async (tt) => {
    let docFilter = null;
    let chunkFilter = null;
    onlyChunkCall(tt, f => { chunkFilter = f; });
    stubHydration(tt);
    tt.mock.method(aiSearch, 'documentIdsMatching', async (f) => {
      docFilter = f;
      return { ids: ['d1'], total: 1, withinCap: true };
    });

    const { out, res } = capture();
    await searchController.search(holding(
      { dataset: 'DocumentChunk', keywords: 'river', 'and[datePostedStart]': '2020-01-01' },
      { type: 'document', ids: ['d9'] }
    ), res);

    assert.ok(docFilter, 'the documents index must be asked');
    assert.ok(docFilter.includes("search.in(id, 'd9', ',')"),
      `the grant must compare the documents index's own key, got: ${docFilter}`);
    assert.ok(!/documentId/.test(docFilter),
      `a field the documents index does not carry was sent, which is a 400: ${docFilter}`);
    assert.ok(chunkFilter.includes("search.in(documentId, 'd9', ',')"),
      `and the chunk query keeps its own spelling of the grant, got: ${chunkFilter}`);
    assert.strictEqual(out.status, undefined, 'the page answers 200, not the 502 a 400 becomes');
  });

  await t.test('a project-scoped credential resolves through the documents index', async (tt) => {
    // The same grant one scope up. `projectId` is the partition field in BOTH indexes, so this case
    // is the guard that the fix picked the document field and left the partition field alone.
    let docFilter = null;
    onlyChunkCall(tt, () => {});
    stubHydration(tt);
    tt.mock.method(aiSearch, 'documentIdsMatching', async (f) => {
      docFilter = f;
      return { ids: ['d1'], total: 1, withinCap: true };
    });

    const { out, res } = capture();
    await searchController.search(holding(
      { dataset: 'DocumentChunk', keywords: 'river', 'and[datePostedStart]': '2020-01-01' },
      { type: 'project', ids: ['207'] }
    ), res);

    assert.ok(docFilter && docFilter.includes("search.in(projectId, '207', ',')"),
      `a project grant compares projectId in both indexes, got: ${docFilter}`);
    assert.ok(!/documentId/.test(docFilter), `got: ${docFilter}`);
    assert.strictEqual(out.body[0].meta[0].dropped, undefined,
      `the key was answered, not dropped: ${JSON.stringify(out.body[0].meta[0])}`);
  });

  await t.test('a PRIVILEGED caller does not get "(undefined) and ..." into the service', async (tt) => {
    // `filterFor` returns `{filter: null, empty: false}` for an unscoped privileged caller — an
    // unfiltered read. A bare template over that produces the literal string "(undefined) and ...",
    // which the service 400s and this route turns into a 502. That is how the provenance clause
    // took staging down, and every probe that missed it was anonymous.
    let chunkFilter = null;
    onlyChunkCall(tt, f => { chunkFilter = f; });
    stubHydration(tt);

    const { out, res } = capture();
    await searchController.search(
      privileged({ dataset: 'DocumentChunk', keywords: 'river', 'and[type]': '5cf00c03a266b7e1877504e9' }), res);

    assert.strictEqual(chunkFilter,
      "typeId eq '5cf00c03a266b7e1877504e9' and not read/any(r: r eq 'compliance')",
      `no placeholder may reach the service, got: ${chunkFilter}`);
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
    t.mock.method(chunksRepo, 'getById', async (access, chunkId, documentId) => ({
      id: chunkId, documentId, content: `text of ${chunkId}`
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
