'use strict';

// `GET /projects` on the native list contract: the projects kind spec, driven through the real
// handler with the index faked at `searchProjects` and Cosmos at `query`.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const querystring = require('node:querystring');

// First: the logger's uncaughtException handler would swallow a load failure here into a green run.
// native-index ahead of the controller, which loads the logger before it.
require('../../../src/search/native-index');
const projectController = require('../../../src/controllers/nosql/project');
const aiSearch = require('../../../src/search/ai-search');
const cosmos = require('../../../src/db/cosmos-nosql');
const audit = require('../../../src/utils/audit');
const { makeRes } = require('../../../src/http/router');
const { recordEvents } = require('../../helpers/record-events');

const ROWS = [{ id: 'p1', name: 'Mine One', read: ['public'] }, { id: 'p2', name: 'Mine Two', read: ['public'] }];

function fakeStores(t) {
  t.mock.method(aiSearch, 'searchProjects', async () => ({ count: 2, items: ROWS.map(row => ({ id: row.id })) }));
  t.mock.method(cosmos, 'query', async (container, spec) =>
    (spec.query.includes('COUNT(1)') ? { items: [ROWS.length] } : { items: structuredClone(ROWS) }));
}

async function call(qs) {
  const req = { query: querystring.parse(qs), params: {}, headers: {}, header: () => undefined };
  const res = makeRes('test');
  await projectController.getProjects(req, res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
}

test('GET /projects native list', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a keyword list logs one search event for the projects kind', async (t) => {
    fakeStores(t);
    const events = recordEvents(t);

    const res = await call('q=mine&count=true');
    assert.strictEqual(res.status, 200);

    const [search] = await events(audit.EVENTS_STREAM);
    assert.strictEqual(search.EventName, 'search');
    assert.strictEqual(search.SearchTerm, 'mine');
    assert.strictEqual(search.Detail.kind, 'projects');
  });

  await t.test('continuationToken is refused; paging is by page', async (t) => {
    fakeStores(t);
    const res = await call('continuationToken=abc');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /unknown parameter: continuationToken/);
  });

  await t.test('projectState takes several values; another filter given twice is refused', async (t) => {
    fakeStores(t);
    assert.strictEqual((await call('projectState=Active&projectState=Closed')).status, 200);
    assert.strictEqual((await call('region=Peace&region=Cariboo')).status, 400);
  });
});
