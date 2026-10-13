'use strict';

// Keyword lists over the index (search/native-index.js), driven through the real native list
// handler. The index is faked at `searchProjects` and Cosmos at `query`, so the OData filter the
// index is asked with and the SQL the rows are read back with are both observed.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const querystring = require('node:querystring');

const { indexedKind, indexFilter, andOData, INDEX_MAPS, ID_PAGE } = require('../../src/search/native-index');
const aiSearch = require('../../src/search/ai-search');
const cosmos = require('../../src/db/cosmos-nosql');
const { filterFor } = require('../../src/helpers/access-odata');
const { resolveAccess, TIER, SEALED_TOKEN } = require('../../src/helpers/access-sql');
const { makeRes } = require('../../src/http/router');
const { listHandler } = require('../../src/controllers/nosql/mirror-reads');

const ANON = resolveAccess({ query: {}, headers: {}, header: () => undefined });
const MAP = INDEX_MAPS.projects;

// `addedBy` is level 2 on every project; an anonymous caller must never receive it.
const ROWS = ['p1', 'p2', 'p3'].map(id => ({
  id, name: `Project ${id}`, read: ['public'], projectState: 'Active', addedBy: 'staff-only@example.org'
}));

const SPEC = {
  entity: 'projects',
  repository: indexedKind({ index: 'projects', container: 'projects', entity: 'projects', partitionField: 'id', defaultOrder: 'c.name ASC' }),
  sortKeys: ['name', 'dateUpdated'],
  filters: ['projectType', 'region', 'projectState', 'proponentName', 'regionalDistrict'],
  multiValueFilters: ['projectState'],
  qFields: ['name', 'description']
};
const list = listHandler(SPEC);

/** The index ranks p3, p1, p2; Cosmos answers in its own order. Both record what they were asked. */
function fakeStores(t, { ranked = ['p3', 'p1', 'p2'] } = {}) {
  const searches = [];
  const queries = [];
  t.mock.method(aiSearch, 'searchProjects', async (opts) => {
    searches.push(opts);
    return { count: ranked.length, items: ranked.map(id => ({ id })) };
  });
  t.mock.method(cosmos, 'query', async (container, spec) => {
    queries.push(spec);
    if (spec.query.includes('COUNT(1)')) return { items: [ROWS.length] };
    return { items: structuredClone(ROWS) };
  });
  return { searches, queries };
}

async function call(qs) {
  const req = { query: querystring.parse(qs), params: {}, headers: {}, header: () => undefined };
  const res = makeRes('test');
  await list(req, res);
  return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : undefined };
}

test('OData builder', async (t) => {
  await t.test('every clause is parenthesised and absent ones are dropped', () => {
    assert.strictEqual(andOData(null, 'a or b', "x eq 'y'"), "(a or b) and (x eq 'y')");
    assert.strictEqual(andOData(null, undefined), null);
  });

  await t.test('a multi-value filter cannot bind across the ACL', () => {
    const { filter, empty } = indexFilter(MAP, { filters: { projectState: ['Active', 'Closed, withdrawn'] } }, ANON);
    assert.strictEqual(empty, false);
    assert.strictEqual(filter,
      `(${filterFor(ANON, 'id').filter}) and ((status eq 'Active' or status eq 'Closed, withdrawn'))`);
  });

  await t.test('a filter with no index column narrows in Cosmos only', () => {
    const { filter } = indexFilter(MAP, { filters: { regionalDistrict: ['Fraser Valley'] } }, ANON);
    assert.strictEqual(filter, `(${filterFor(ANON, 'id').filter})`);
  });

  await t.test('an unrestricted caller sends only its own filters, and none at all when it names none', () => {
    const open = { tier: TIER.PRIVILEGED, roles: ['sysadmin', SEALED_TOKEN], compartment: true };
    assert.deepStrictEqual(indexFilter(MAP, { filters: {} }, open), { filter: null, empty: false });
    assert.strictEqual(indexFilter(MAP, { filters: { region: ['Peace'] } }, open).filter, "(region eq 'Peace')");
  });

  await t.test('a caller that can match nothing returns early, with no index or Cosmos request', async (t) => {
    const { searches, queries } = fakeStores(t);
    const nothing = { tier: TIER.SCOPED, projectScope: [], roles: [] };
    assert.deepStrictEqual(indexFilter(MAP, { filters: {} }, nothing), { filter: null, empty: true });

    const parsed = { q: 'mine', filters: {} };
    assert.deepStrictEqual(await SPEC.repository.list(nothing, { parsed, pageNum: 0, pageSize: 10 }), []);
    assert.strictEqual(await SPEC.repository.count(nothing, { parsed }), 0);
    assert.strictEqual(searches.length + queries.length, 0);
    t.mock.restoreAll();
  });
});

test('keyword list over the index', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('rows come back in index rank, read from Cosmos with the dials applied', async (t) => {
    const { searches, queries } = fakeStores(t);
    const res = await call('q=mine&projectState=Active&regionalDistrict=Peace&count=true');

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.map(r => r.id), ['p3', 'p1', 'p2']);
    assert.strictEqual(res.headers['x-total-count'], '3');

    assert.strictEqual(searches.length, 1, 'list and count share one index read');
    assert.strictEqual(searches[0].keywords, 'mine');
    assert.strictEqual(searches[0].top, ID_PAGE);
    assert.match(searches[0].filter, /\(status eq 'Active'\)$/);

    assert.strictEqual(queries.length, 1, 'list and count share one Cosmos read');
    const sql = queries[0];
    assert.deepStrictEqual(sql.parameters.filter(p => p.name.startsWith('@xid')).map(p => p.value), ['p3', 'p1', 'p2']);
    assert.ok(!sql.parameters.some(p => p.name === '@nq'), 'Cosmos must not re-match the keyword the index matched');
    for (const field of ['name', 'description', 'proponentName', 'projectState', 'tags']) {
      assert.ok(sql.query.includes(`c.vis[${JSON.stringify(field)}]`), `no dial check on searched field ${field}`);
    }
    assert.ok(sql.parameters.some(p => p.value === 'Peace'), 'the unmapped filter still narrows in Cosmos');
  });

  await t.test('an anonymous caller never receives a level-2 field', async (t) => {
    fakeStores(t);
    const res = await call('q=mine');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.length, 3);
    for (const row of res.body) assert.ok(!('addedBy' in row), `addedBy reached an anonymous caller on ${row.id}`);
  });

  await t.test('page 2 is the next slice of the ranked rows', async (t) => {
    fakeStores(t);
    const res = await call('q=mine&pageSize=2&page=2');
    assert.deepStrictEqual(res.body.map(r => r.id), ['p2']);
  });

  await t.test('a named sort orders in Cosmos rather than by rank', async (t) => {
    const { queries } = fakeStores(t);
    const res = await call('q=mine&sort=-name');
    assert.match(queries[0].query, /ORDER BY c\.name DESC$/);
    assert.deepStrictEqual(res.body.map(r => r.id), ['p1', 'p2', 'p3']);
  });

  await t.test('no index hit reads nothing from Cosmos', async (t) => {
    const { queries } = fakeStores(t, { ranked: [] });
    const res = await call('q=nothing&count=true');
    assert.deepStrictEqual(res.body, []);
    assert.strictEqual(res.headers['x-total-count'], '0');
    assert.strictEqual(queries.length, 0);
  });

  await t.test('a list with no q stays on Cosmos', async (t) => {
    const { searches, queries } = fakeStores(t);
    const res = await call('projectState=Active&count=true');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(searches.length, 0);
    assert.ok(queries.length >= 1);
    assert.strictEqual(res.headers['x-total-count'], '3');
  });
});
