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

test('the response says which keys it could not express', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  // A filter the index cannot express was named in `logger.warn` and NOWHERE ELSE. The caller got
  // a 200 and a full-corpus page: measured against test, `and[proponent]=<ObjectId>` on Project
  // answers `pageSize` rows under `searchResultsTotal: 348`, which is the unfiltered corpus.
  await t.test('a dropped filter key is named in meta, not only in the log', async () => {
    t.mock.method(aiSearch, 'searchDocuments', async () => ({ count: 61, items: [] }));

    const { out, res } = capture();
    await searchController.search(
      anonymous({ dataset: 'Document', keywords: '', 'and[isFeatured]': 'true', pageSize: '5' }), res);

    assert.deepStrictEqual(out.body[0].meta[0].dropped.filter, ['isFeatured']);
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
  await t.test('the Cosmos list path reports through the same key', async () => {
    t.mock.method(projectsRepo, 'listVisible', async () => ({ items: [] }));
    t.mock.method(projectsRepo, 'countVisible', async () => 348);

    const { out, res } = capture();
    await searchController.search(
      anonymous({ dataset: 'Project', keywords: '', project: '207', pageSize: '10' }), res);

    assert.deepStrictEqual(out.body[0].meta[0].dropped, { filter: ['project'], sort: [] });
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
