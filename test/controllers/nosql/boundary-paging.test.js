'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const boundaries = require('../../../src/repositories/boundaries');
const boundaryController = require('../../../src/controllers/nosql/boundary');
const { pageOptions } = require('../../../src/repositories/_sql');
const cosmos = require('../../../src/db/cosmos-nosql');
const { logger } = require('../../../src/utils/logger');

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    setHeader(k, v) { this.headers[k] = v; }
  };
  return res;
}

// The read is anonymous and cross-partition. Without a pageSize, cosmos.query takes its
// fetchAll() branch and drains the whole container — survivable only because there are 281 rows.
test('GET /boundaries is a bounded read', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('asks for a bounded page even when the caller says nothing', async (t2) => {
    let opts;
    t2.mock.method(cosmos, 'query', async (_c, _spec, o) => { opts = o; return { items: [] }; });

    await boundaryController.getBoundaries({ query: {} }, mockRes());

    // maxItemCount is the whole point: unset, cosmos.query takes fetchAll() and drains the
    // container cross-partition on an anonymous request.
    assert.strictEqual(opts.maxItemCount, 1000);
  });

  // ONE CLAMP, and the guard must compare against it. The controller used to clamp a second time
  // with different arithmetic — `Math.min(parseInt(x), 1000)` against pageOptions'
  // `Math.min(Math.max(Number(x) || 1000, 1), 1000)` — so `?pageSize=abc` gave the controller NaN
  // while the read bounded at 1000, and `1000 >= NaN` is false: a truncated page reported nothing.
  // `0` and `-5` inverted it, firing the warn on complete answers.
  await t.test('hostile pageSize values still bound the read, and agree with the guard', async (t2) => {
    for (const [query, expected] of [['50', 50], ['99999', 1000], ['abc', 1000], ['0', 1000], ['-5', 1]]) {
      let opts;
      const warnings = [];
      const originalWarn = logger.warn;
      logger.warn = (m) => warnings.push(String(m));

      t2.mock.method(cosmos, 'query', async (_c, _spec, o) => {
        opts = o;
        // A SHORT page — one row, complete, nothing left. No caller input may turn this into a
        // warning; the live 281-row corpus lands here on every request.
        return { items: [{ id: 'b1' }] };
      });

      await boundaryController.getBoundaries({ query: { pageSize: query } }, mockRes());
      logger.warn = originalWarn;
      t2.mock.restoreAll();

      assert.strictEqual(opts.maxItemCount, expected, `pageSize=${query} must bound at ${expected}`);
      if (expected > 1) {
        assert.deepStrictEqual(warnings, [], `pageSize=${query} must not warn on a complete page`);
      }
    }
  });

  await t.test('returns the continuation token, and only when there is one', async (t2) => {
    t2.mock.method(boundaries, 'listByType', async () => ({ items: [{ id: 'b1' }], continuationToken: 'tok' }));
    const paged = mockRes();
    await boundaryController.getBoundaries({ query: {} }, paged);
    assert.strictEqual(paged.headers['x-continuation-token'], 'tok',
      'a truncated map with no way to page it is why this read was left unbounded before');
    assert.deepStrictEqual(paged.body, [{ id: 'b1' }], 'the body stays a plain array');

    // BOTH SIDES. Always setting the header would also satisfy the assertion above, and would tell
    // every caller of a complete list that there is another page.
    t2.mock.restoreAll();
    t2.mock.method(boundaries, 'listByType', async () => ({ items: [{ id: 'b1' }] }));
    const whole = mockRes();
    await boundaryController.getBoundaries({ query: {} }, whole);
    assert.ok(!('x-continuation-token' in whole.headers), 'no token when the page is the whole set');
  });

  await t.test('passes the caller continuation token back down', async (t2) => {
    let opts;
    t2.mock.method(boundaries, 'listByType', async (_a, o) => { opts = o; return { items: [] }; });

    await boundaryController.getBoundaries({ query: { continuationToken: 'from-caller' } }, mockRes());

    assert.strictEqual(opts.continuationToken, 'from-caller',
      'without this the second page request re-serves the first page forever');
  });
});

// AT THE LAYER WHERE THE TOKEN IS ACTUALLY LOST. Everything above stubs `listByType` wholesale, so
// it can only prove the controller forwards a value the test itself supplied. The token does not go
// missing there — it goes missing in the SDK, and only on one of the two paths:
//
//   `?type=X`  -> partitionKey set  -> DefaultQueryExecutionContext -> x-ms-continuation propagates
//   no type    -> cross-partition + ORDER BY -> LegacyFetchImplementation, whose mergeHeaders does
//                 NOT copy x-ms-continuation, so continuationToken is undefined with rows left
//
// So these drive the REAL repository and stub `cosmos.query`, asserting on the options it receives
// and modelling each path's answer. That is the seam: the SDK's behaviour is a fact about the SDK,
// not something this repo can assert, but WHICH PATH a request takes is entirely this repo's doing.
test('the two boundary paging paths are not interchangeable', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a type-scoped read is single-partition, which is the path that can page', async (t2) => {
    let opts;
    t2.mock.method(cosmos, 'query', async (_c, _spec, o) => {
      opts = o;
      return { items: [{ id: 'b1' }], continuationToken: 'tok' };
    });

    const res = mockRes();
    await boundaryController.getBoundaries({ query: { type: 'Municipality' } }, res);

    assert.strictEqual(opts.partitionKey, 'Municipality',
      'without partitionKey this is cross-partition and the SDK drops the continuation header');
    assert.strictEqual(opts.maxItemCount, 1000);
    assert.strictEqual(res.headers['x-continuation-token'], 'tok');
  });

  await t.test('the unfiltered read is cross-partition, and a full page there is reported', async (t2) => {
    let opts;
    t2.mock.method(cosmos, 'query', async (_c, _spec, o) => {
      opts = o;
      // What the SDK actually returns on this path: a full page and NO token, however many rows
      // are left. Modelled, not mocked away.
      return { items: Array.from({ length: o.maxItemCount }, (_v, i) => ({ id: `b${i}` })) };
    });

    const warnings = [];
    const originalWarn = logger.warn;
    logger.warn = (m) => warnings.push(String(m));
    t2.after(() => { logger.warn = originalWarn; });

    const res = mockRes();
    await boundaryController.getBoundaries({ query: {} }, res);

    assert.strictEqual(opts.partitionKey, undefined, 'no type means no partition key');
    assert.strictEqual(res.body.length, 1000, 'bounded — not the fetchAll() drain');
    assert.ok(!('x-continuation-token' in res.headers), 'and the SDK gave us nothing to hand on');
    assert.ok(warnings.some(w => w.includes('no continuation token')),
      'a truncated map that says nothing is the failure this endpoint exists to have stopped having');

    // The CALLER's side of it. A warn reaches telemetry; the client still holds a short map it
    // cannot tell from a complete one, and the handler's default `public, max-age=86400` would
    // keep that wrong answer in shared caches for a day.
    assert.strictEqual(res.headers['x-truncated'], 'true');
    assert.strictEqual(res.headers['Cache-Control'], 'no-store');
  });

  // The line is unauthenticated and winston forwards to Application Insights, so echoing a caller
  // value would let anyone write chosen text into telemetry once per request.
  await t.test('the warning quotes no caller-supplied value', async (t2) => {
    t2.mock.method(cosmos, 'query', async (_c, _spec, o) => ({
      items: Array.from({ length: o.maxItemCount }, (_v, i) => ({ id: `b${i}` }))
    }));

    const warnings = [];
    const originalWarn = logger.warn;
    logger.warn = (m) => warnings.push(String(m));
    t2.after(() => { logger.warn = originalWarn; });

    const marker = 'INJECTED-BY-CALLER';
    await boundaryController.getBoundaries({ query: { type: marker, pageSize: '10' } }, mockRes());

    assert.strictEqual(warnings.length, 1, 'the guard fired, so there is something to inspect');
    assert.ok(!warnings[0].includes(marker), 'no caller string may reach the log line');
  });

  // The OTHER half of the guard. Without `!nextPage` this still passes — a full page WITH a token
  // is correctly paged, and calling its remainder unreachable would be a lie the caller can
  // disprove. Reachable today: `?type=Municipality&pageSize=100` against the 160-row partition.
  await t.test('a full page WITH a token is not reported — it is simply the next page', async (t2) => {
    t2.mock.method(cosmos, 'query', async (_c, _spec, o) => ({
      items: Array.from({ length: o.maxItemCount }, (_v, i) => ({ id: `b${i}` })),
      continuationToken: 'more'
    }));

    const warnings = [];
    const originalWarn = logger.warn;
    logger.warn = (m) => warnings.push(String(m));
    t2.after(() => { logger.warn = originalWarn; });

    const res = mockRes();
    await boundaryController.getBoundaries({ query: { type: 'Municipality', pageSize: '100' } }, res);

    assert.strictEqual(res.headers['x-continuation-token'], 'more');
    assert.deepStrictEqual(warnings, [], 'the caller can reach the rest — nothing to report');
    assert.ok(!('x-truncated' in res.headers), 'a resumable page is not truncated');
    assert.strictEqual(res.headers['Cache-Control'], 'public, max-age=86400, s-maxage=86400',
      'and it stays cacheable — the default must survive the path that is fine');
  });

  await t.test('a short page is complete, and says nothing', async (t2) => {
    t2.mock.method(cosmos, 'query', async () => ({ items: [{ id: 'b1' }, { id: 'b2' }] }));

    const warnings = [];
    const originalWarn = logger.warn;
    logger.warn = (m) => warnings.push(String(m));
    t2.after(() => { logger.warn = originalWarn; });

    await boundaryController.getBoundaries({ query: {} }, mockRes());

    // The real corpus is 281 across 3 partitions, largest 160 — every live call lands here. A warn
    // on the normal path would be noise on every map load.
    assert.deepStrictEqual(warnings, []);
  });
});
