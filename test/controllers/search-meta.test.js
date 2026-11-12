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

// `filterFor` answers `{filter: null, empty: false}` here: an unfiltered read. Anonymous callers
// always have a filter, so they cannot catch a clause built as `(undefined) and ...`.
const privileged = query => ({
  query,
  header: () => null,
  user: { realm_access: { roles: ['sysadmin'] } }
});

test('the response says which keys it could not express', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  // A dropped filter still answers 200 over the unfiltered corpus, so the caller must be told.
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

  // No `chunks` field is sortable, so `sortBy` on DocumentChunk is always discarded and must
  // still be reported.
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

  // Same `dropped` shape on every dataset and both backends.
  await t.test('a project filter the dataset cannot express answers NOTHING, and says so', async () => {
    // `projects` has no `projectId` column, so the key drops; answering the whole visible corpus
    // to a request for one project is the widest reading of the narrowest ask.
    let searched = false;
    t.mock.method(projectsRepo, 'listPage', async () => { searched = true; return []; });
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

  // `parseInt('abc')` is NaN and `Math.min(NaN, 5000)` is NaN; a NaN page size reaching the
  // repository answers the whole visible corpus.
  await t.test('pageSize=abc asks for the same page an absent pageSize does', async () => {
    const asked = [];
    t.mock.method(projectsRepo, 'listPage', async (access, opts) => {
      asked.push(opts.pageSize);
      return [];
    });
    t.mock.method(projectsRepo, 'countVisible', async () => 348);

    const { res } = capture();
    await searchController.search(anonymous({ dataset: 'Project', keywords: '', pageSize: 'abc' }), res);
    const { res: res2 } = capture();
    await searchController.search(anonymous({ dataset: 'Project', keywords: '' }), res2);

    assert.deepStrictEqual(asked, [10, 10], 'unparseable and absent must land on the same default');
  });

  // `|| 10` never fires on -1, `Math.min(-1, 5000)` is -1 and the `> MAX_PAGE_ROWS` refusal
  // misses negatives, so without the clamp `pageSize=-5&pageNum=3` sends `{top: -5, skip: -15}`.
  await t.test('a zero or negative pageSize takes the default too', async () => {
    const asked = [];
    t.mock.method(projectsRepo, 'listPage', async (access, opts) => {
      asked.push(opts.pageSize);
      return [];
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
    // Between an app release and the index PUT, `typeId eq …` against the live index is a 400,
    // which this route answers as 502 for the whole Deep Search tab.
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
    // Its own reason: this state clears only when an operator applies the index definition, and
    // without a reason it looks like a filter the API never supported.
    assert.deepStrictEqual(out.body[0].meta[0].degraded.reasons, ['chunk-parent-fields-missing']);
    assert.deepStrictEqual(Object.keys(out.body[0].meta[0].degraded), ['reasons'],
      `no count may reach the caller: ${JSON.stringify(out.body[0].meta[0].degraded)}`);
  });

  await t.test('the missing-column reason waits for the recovery to run out of room too',
    async (tt) => {
      // The documents index answers the facet in full up to the scope cap; marking on the absent
      // column alone would banner every project-scoped Deep Search during a deploy window.
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
    // The facet is missing on the chunks index only; `documents` carries it. The key must stay in
    // the query so `dropped` and this recovery see it.
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

    // The project scope must come along or a corpus-wide `type` runs over the cap. `project` is never
    // in `dropped` (chunks carry `projectId`), so it cannot be read from there.
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
    // `recoverChunkFilters` must read values through `andParams`; `query[key]` alone misses the
    // nested shape. Unreachable under the shipped parser, but a parser swap would expose it.
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

  // All four columns present, but the backfill has not stamped this scope: the schema probe sees
  // the column, not whether rows hold a value.
  const carriedButBehind = (tt, behind = 4210) => {
    stubStatus(tt, {
      known: true, available: chunksRepo.CHUNK_PARENT_FIELDS.slice(), missing: [], unstamped: behind
    });
    tt.mock.method(aiSearch, 'staleChunkCount', async () => behind);
    searchController.resetStaleChunkScopeCache();
  };

  await t.test('an unstamped scope sends the facet to the documents index, not the chunk query',
    async (tt) => {
      // Unstamped chunks hold `null`, so `milestoneId eq 'm1'` answers zero rows under a 200.
      // The key is withheld and answered through the documents index instead.
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
      // Marked only when the scope is mid-backfill AND the documents-index recovery is over the
      // scope cap, so the page really is short.
      stubChunkSearch(tt);
      carriedButBehind(tt);
      tt.mock.method(aiSearch, 'documentIdsMatching', async () =>
        ({ ids: [], total: 4000, withinCap: false }));

      const { out, res } = capture();
      await searchController.search(anonymous({
        dataset: 'DocumentChunk', keywords: 'river', 'and[milestone]': 'm1'
      }), res);

      assert.deepStrictEqual(out.body[0].meta[0].degraded.reasons, ['chunk-parent-fields-unstamped']);
      // The reason, never the number: the route is anonymous and the count is an internal
      // backfill statistic.
      assert.deepStrictEqual(Object.keys(out.body[0].meta[0].degraded), ['reasons'],
        `no count may reach the caller: ${JSON.stringify(out.body[0].meta[0].degraded)}`);
      assert.deepStrictEqual(out.body[0].meta[0].dropped.filter, ['milestone'],
        'and the key it could not answer is named');
    });

  await t.test('a backfill state the service could not report is not a stamped one', async (tt) => {
    // `unstamped: null` means the index cannot tell. Unknown is not zero: nothing is marked off it
    // and nothing filtered on it, so the key goes to the documents index.
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
      // The page is short, so it is marked, but the backlog count went unanswered: the reason is
      // "unknown", which clears when the service answers again.
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
    // The probe resolves rather than rejects on failure; reading `.available` off a bare object
    // unguarded throws, and a throw is a 502 over the whole Deep Search tab.
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
    // `known: false` may mean the index PUT has not happened yet; sending the clause on a guess is
    // a 400 and a 502 over the whole tab. Withholding costs one filter, and the caller is told.
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
    // `dropped` feeds the documents-index recovery, which is why the key is dropped rather than
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
    // No facet filters on `projectId`; probing it costs a request and, if undecided, would
    // withhold every facet over a column nobody asked about.
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
      // One field's probe died and the recovery is over the cap; without a reason the key in
      // `dropped` reads as a filter the API does not support.
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
    // The probe reports per field, so one field's failure must not withhold the facets it did
    // settle.
    let chunkFilter = null;
    stubChunkSearch(tt, f => { chunkFilter = f; });
    stubStatus(tt, {
      known: false, available: ['milestoneId'], missing: [],
      unknown: ['typeId', 'projectPhaseId', 'documentAuthorTypeId'], unstamped: null
    });
    // A partial answer has no index-wide count, so the scope is stamped here; otherwise this would
    // measure the backfill, not the probe.
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

  // Index-wide, something is behind: the state where "is anything behind for this caller" matters.
  const somethingIsBehindSomewhere = tt =>
    tt.mock.method(aiSearch, 'chunkParentFieldStatus', async () => ({
      known: true, available: chunksRepo.CHUNK_PARENT_FIELDS.slice(), missing: [], unstamped: 4210
    }));

  // `ai-search` builds the clause; this route hands it the scope, so the argument is asserted.
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
    // A backlog elsewhere must not mark this page or push its facet onto the documents index and
    // its cap. A stamped scope is the fast path.
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

  // `null` from `staleChunkCount` means "cannot say", not a backlog: the same rule the schema
  // probe applies to `known: false`.
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
    // The map holds 32 scopes and evicts the oldest insertion; a hit must move its key to the end
    // or the busiest scope is evicted first.
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
  // One service call: resolving facets through `documents` ids is bounded by one request's
  // size, and real facets exceed it.
  const onlyChunkCall = (tt, onFilter) => {
    let calls = 0;
    // Unstubbed, the probe answers `known: false` (no SEARCH_ENDPOINT) and every facet drops.
    // `unstamped: 0` means no per-scope recount.
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
    // A qs/extended parser produces the nested shape. Unreachable under the shipped parser, but a
    // parser swap would turn it on silently.
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
    // `documentAuthor` is in no demi index. Sent beside an expressible key so the two cannot be
    // reported the same way.
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
    // A chunk has no `datePosted`, so date, `isFeatured`, `legislation` and `documentSource`
    // filters resolve matching document ids and scope the chunk query to them.
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
    // `type` is answerable on the chunk row; resolving it through documents would put the
    // 249-document cap in front of eagle-public's most used filter.
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
    // Real facets match thousands of documents, far over the 249-document cap, so facets are not
    // resolved by document count at all.
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

  // A document grant compares `documentId` on chunks but `id` on documents; the chunk clause on
  // the documents index is a 400, answered as 502.
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
    // A null filter in a bare template renders "(undefined) and ...", which the service 400s and
    // this route turns into a 502.
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

  // The merge stores Eagle's `location` as `address`; the row mapper must read it back for the
  // `/projects` map popups and tooltips.
  await t.test('location comes from the stored address', async () => {
    t.mock.method(projectsRepo, 'listPage', async () => [{
        id: '207',
        name: 'Site C Clean Energy Project',
        address: '10 km south-west of Fort St. John',
        read: ['public']
      }]);
    t.mock.method(projectsRepo, 'countVisible', async () => 1);

    const { out, res } = capture();
    await searchController.search(anonymous({ dataset: 'Project', keywords: '', pageSize: '10' }), res);

    assert.strictEqual(out.body[0].searchResults[0].location, '10 km south-west of Fort St. John');
  });
});

test('the summary is gated on the parent document, like the chunk search', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  // A chunk's `read[]` is an ingest snapshot that can outlive its document's visibility, so the
  // summary gates on the parent document, as chunk search does.
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
