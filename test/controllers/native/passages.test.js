'use strict';

// Native passages, driven through the real handler over a stubbed chunks index and stubbed parent
// reads, so the gate, the facet refusal and the row shape are observed in the response.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const querystring = require('node:querystring');

// First: the logger's uncaughtException handler would swallow a load failure here into a green run.
const passages = require('../../../src/controllers/native/passages');
const { listHandler } = require('../../../src/controllers/nosql/mirror-reads');
const aiSearch = require('../../../src/search/ai-search');
const chunkQuery = require('../../../src/search/chunk-query');
const documentsRepo = require('../../../src/repositories/documents');
const projectsRepo = require('../../../src/repositories/projects');
const { logger } = require('../../../src/utils/logger');
const { makeRes } = require('../../../src/http/router');

const STAFF = { realm_access: { roles: ['staff'] } };

const PROJECT = { id: 'p1', name: 'Site C', eagleId: 'bbbbbbbbbbbbbbbbbbbbbbbb', read: ['public'] };

const HITS = [
  { chunkId: 'd1::p3::c0', documentId: 'd1', projectId: 'p1', pageNumber: 3, pageNumbered: true, snippet: 'the <mark>water</mark> line', content: 'whole chunk text' },
  { chunkId: 'd2::p1::c0', documentId: 'd2', projectId: 'p1', pageNumber: 1, pageNumbered: false, snippet: 'hidden <mark>water</mark>' },
  { chunkId: 'd1::p4::c1', documentId: 'd1', projectId: 'p1', pageNumber: 4, pageNumbered: true, snippet: 'more <mark>water</mark>' }
];

/** d1 is readable, d2 is not; answers the searchChunks mock so its calls can be read. */
function stubIndex(t, { hits = HITS, count = 40 } = {}) {
  const search = t.mock.method(aiSearch, 'searchChunks', async () => ({ items: structuredClone(hits), count }));
  t.mock.method(documentsRepo, 'listByIds', async () => [{ id: 'd1', projectId: 'p1', read: ['public'] }]);
  t.mock.method(projectsRepo, 'listByIds', async () => [structuredClone(PROJECT)]);
  t.mock.method(projectsRepo, 'listRowsByIds', async () => [structuredClone(PROJECT)]);
  return search;
}

async function call(handler, qs, { user } = {}) {
  const req = { query: querystring.parse(qs), params: {}, headers: {}, header: () => undefined, user };
  const res = makeRes('test');
  await handler(req, res);
  return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : undefined };
}

test('passages', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const get = passages.getPassages;

  await t.test('no q 400', async (t) => {
    const search = stubIndex(t);
    for (const qs of ['', 'q=%20%20']) {
      const res = await call(get, qs);
      assert.strictEqual(res.status, 400, qs);
      assert.match(res.body.error, /q is required/);
    }
    assert.strictEqual(search.mock.callCount(), 0);
  });

  await t.test('ids 400', async (t) => {
    const search = stubIndex(t);
    const res = await call(get, 'q=water&ids=d1::p3::c0');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /ids/);
    assert.strictEqual(search.mock.callCount(), 0);
  });

  await t.test('pageSize 101 400', async (t) => {
    const search = stubIndex(t);
    // Staff, so the contract's own cap is 1000 and only this list's cap can refuse it.
    const res = await call(get, 'q=water&pageSize=101', { user: STAFF });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /at most 100/);
    assert.strictEqual(search.mock.callCount(), 0);

    const ok = await call(get, 'q=water', { user: STAFF });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(search.mock.calls[0].arguments[0].top, 100, 'absent pageSize is 100, not 1000');
  });

  await t.test('sort is refused', async (t) => {
    stubIndex(t);
    const res = await call(get, 'q=water&sort=pageNumber');
    assert.strictEqual(res.status, 400);
  });

  await t.test('hidden parent dropped, count net, logger.warn called', async (t) => {
    stubIndex(t);
    const warn = t.mock.method(logger, 'warn', () => {});
    const res = await call(get, 'q=water&count=true');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.map(row => row.id), ['d1::p3::c0', 'd1::p4::c1']);
    assert.strictEqual(res.headers['x-total-count'], '39');
    assert.strictEqual(warn.mock.callCount(), 1);
    assert.deepStrictEqual(warn.mock.calls[0].arguments[1], { withheld: 1, returned: 2 });
  });

  await t.test('rows carry snippet, never content', async (t) => {
    stubIndex(t);
    t.mock.method(logger, 'warn', () => {});
    const res = await call(get, 'q=water');
    assert.deepStrictEqual(res.body[0], {
      id: 'd1::p3::c0',
      documentId: 'd1',
      projectId: 'p1',
      pageNumber: 3,
      pageNumbered: true,
      snippet: 'the <mark>water</mark> line',
      projectName: 'Site C',
      projectEagleId: 'bbbbbbbbbbbbbbbbbbbbbbbb'
    });
    assert.ok(res.body.every(row => !('content' in row)));
  });

  await t.test('rows carry projectName and projectEagleId', async (t) => {
    stubIndex(t);
    t.mock.method(logger, 'warn', () => {});
    const res = await call(get, 'q=water');
    for (const row of res.body) {
      assert.strictEqual(row.projectName, 'Site C');
      assert.strictEqual(row.projectEagleId, PROJECT.eagleId);
    }
  });

  await t.test('filters and paging reach the index under the caller ACL', async (t) => {
    const search = stubIndex(t, { hits: [] });
    const res = await call(get, 'q=water&project=p1&documentId=d1&documentId=d3&page=3&pageSize=10');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, []);
    const opts = search.mock.calls[0].arguments[0];
    assert.strictEqual(opts.keywords, 'water');
    assert.strictEqual(opts.skip, 20);
    assert.strictEqual(opts.top, 10);
    assert.match(opts.filter, /read\/any\(r: /);
    assert.match(opts.filter, /projectId eq 'p1'/);
    assert.match(opts.filter, /search\.in\(documentId, 'd1,d3', ','\)/);
  });

  await t.test('unstamped facet scope 503 and logger.warn called', async (t) => {
    chunkQuery.resetStaleChunkScopeCache();
    const search = stubIndex(t);
    t.mock.method(aiSearch, 'chunkParentFieldStatus', async () => (
      { available: ['typeId', 'milestoneId', 'projectPhaseId', 'documentAuthorTypeId'], missing: [], unstamped: 12 }
    ));
    const stale = t.mock.method(aiSearch, 'staleChunkCount', async () => 3);
    const warn = t.mock.method(logger, 'warn', () => {});

    const res = await call(get, 'q=water&project=p1&typeId=t1');

    assert.strictEqual(res.status, 503);
    assert.match(res.body.error, /typeId/);
    assert.match(res.body.error, /chunk-parent-fields-unstamped/);
    assert.deepStrictEqual(stale.mock.calls[0].arguments[0].projectIds, ['p1']);
    assert.strictEqual(search.mock.callCount(), 0, 'no index read once the facet is refused');
    assert.strictEqual(warn.mock.callCount(), 1);
    assert.deepStrictEqual(warn.mock.calls[0].arguments[1],
      { columns: ['typeId'], reasons: ['chunk-parent-fields-unstamped'] });
  });

  await t.test('a fully stamped facet scope is sent to the index', async (t) => {
    chunkQuery.resetStaleChunkScopeCache();
    const search = stubIndex(t, { hits: [] });
    t.mock.method(aiSearch, 'chunkParentFieldStatus', async () => (
      { available: ['typeId', 'milestoneId', 'projectPhaseId', 'documentAuthorTypeId'], missing: [], unstamped: 0 }
    ));
    const res = await call(get, 'q=water&typeId=t1');
    assert.strictEqual(res.status, 200);
    assert.match(search.mock.calls[0].arguments[0].filter, /typeId eq 't1'/);
  });
});

test('list handler status pass-through', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const handlerThrowing = err => listHandler({
    entity: 'passages',
    repository: { list: async () => { throw err; }, count: async () => 0 }
  });

  await t.test('a 503 error passes through as 503 with its message', async () => {
    const err = Object.assign(new Error('not stamped yet'), { status: 503 });
    const res = await call(handlerThrowing(err), '');
    assert.strictEqual(res.status, 503);
    assert.deepStrictEqual(res.body, { error: 'not stamped yet' });
  });

  await t.test('any other error is still a 500 without its message', async (t) => {
    t.mock.method(logger, 'error', () => {});
    const res = await call(handlerThrowing(new Error('secret detail')), '');
    assert.strictEqual(res.status, 500);
    assert.ok(!JSON.stringify(res.body).includes('secret detail'));
  });
});
