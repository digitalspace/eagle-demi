'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const boundaries = require('../../../src/repositories/boundaries');
const boundaryController = require('../../../src/controllers/nosql/boundary');
const { pageOptions } = require('../../../src/repositories/_sql');

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
    t2.mock.method(boundaries, 'listByType', async (_access, o) => { opts = o; return { items: [] }; });

    await boundaryController.getBoundaries({ query: {} }, mockRes());

    // Asserted THROUGH pageOptions, not just as a number. A pageSize the controller passes but
    // pageOptions discards would leave maxItemCount unset and the read unbounded again — which is
    // the actual defect, and a bare `assert.strictEqual(opts.pageSize, 1000)` cannot see it.
    assert.ok(pageOptions({ pageSize: opts.pageSize }).maxItemCount,
      'the value the controller passes must survive into maxItemCount');
    assert.strictEqual(pageOptions({ pageSize: opts.pageSize }).maxItemCount, 1000);
  });

  await t.test('honours a smaller page and clamps a larger one', async (t2) => {
    const seen = [];
    t2.mock.method(boundaries, 'listByType', async (_a, o) => { seen.push(o.pageSize); return { items: [] }; });

    await boundaryController.getBoundaries({ query: { pageSize: '50' } }, mockRes());
    await boundaryController.getBoundaries({ query: { pageSize: '99999' } }, mockRes());

    assert.strictEqual(seen[0], 50);
    assert.strictEqual(seen[1], 1000, '1000 is the ceiling pageOptions enforces anyway');
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
