'use strict';

// The anonymous page cap on the two unauthenticated list routes.
//
// `GET /projects` and `GET /documents` are reachable with no credential, and every row they
// return is a cross-partition Cosmos read. An anonymous caller therefore gets 100 rows a page;
// an authenticated one keeps the 1000-row ceiling `repositories/_sql.pageOptions` clamps to.
//
// Over the cap is REFUSED, not truncated, so a caller cannot mistake a short page for the
// end of the data.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const projects = require('../../../src/repositories/projects');
const documents = require('../../../src/repositories/documents');
const projectController = require('../../../src/controllers/nosql/project');
const documentController = require('../../../src/controllers/nosql/document');
const { ANON_MAX_PAGE_SIZE, MAX_PAGE_SIZE } = require('../../../src/helpers/access-sql');

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    setHeader(k, v) { this.headers[k] = v; }
  };
}

const STAFF = { realm_access: { roles: ['staff'] } };

// Both routes take the same shape: a repository `listVisible(access, opts)` behind a controller
// that decides `opts.pageSize`. One table drives both so neither can be hardened alone.
const ROUTES = [
  { name: 'projects', repo: projects, handler: (req, res) => projectController.getProjects(req, res) },
  { name: 'documents', repo: documents, handler: (req, res) => documentController.getDocuments(req, res) }
];

for (const route of ROUTES) {
  test(`GET /${route.name} anonymous page cap`, async (t) => {
    t.afterEach(() => t.mock.restoreAll());

    // The repository must never be reached on a refusal — the point of the 400 is that the
    // expensive read does not happen, not merely that the response is short.
    const stub = () => {
      let seenOpts = null;
      t.mock.method(route.repo, 'listVisible', async (access, opts) => {
        seenOpts = opts;
        return { items: [], continuationToken: undefined };
      });
      return () => seenOpts;
    };

    await t.test(`anonymous ${ANON_MAX_PAGE_SIZE + 1} is refused with 400`, async () => {
      const opts = stub();
      const res = mockRes();
      await route.handler({ query: { pageSize: String(ANON_MAX_PAGE_SIZE + 1) }, params: {} }, res);

      assert.strictEqual(res.statusCode, 400);
      assert.match(res.body.error, /pageSize above 100/);
      assert.strictEqual(opts(), null, 'the refused request must not query Cosmos');
    });

    await t.test(`anonymous ${ANON_MAX_PAGE_SIZE} is served`, async () => {
      const opts = stub();
      const res = mockRes();
      await route.handler({ query: { pageSize: String(ANON_MAX_PAGE_SIZE) }, params: {} }, res);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(opts().pageSize, ANON_MAX_PAGE_SIZE);
    });

    await t.test('an anonymous request naming no pageSize gets the anonymous cap', async () => {
      const opts = stub();
      await route.handler({ query: {}, params: {} }, mockRes());
      assert.strictEqual(opts().pageSize, ANON_MAX_PAGE_SIZE,
        'the default must be the cap, or the cap only applies to callers who ask');
    });

    await t.test('staff 500 is served in full', async () => {
      const opts = stub();
      const res = mockRes();
      await route.handler({ query: { pageSize: '500' }, params: {}, user: STAFF }, res);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(opts().pageSize, 500, 'authenticated callers keep the existing ceiling');
    });

    await t.test(`staff above ${MAX_PAGE_SIZE} still clamps rather than 400s`, async () => {
      const opts = stub();
      const res = mockRes();
      await route.handler({ query: { pageSize: '5000' }, params: {}, user: STAFF }, res);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(opts().pageSize, MAX_PAGE_SIZE);
    });
  });
}
