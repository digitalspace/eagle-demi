'use strict';

// Keyword lists over the index (search/native-index.js), driven through the real native list
// handler. The index is faked at `searchProjects` and Cosmos at `query`, so the OData filter the
// index is asked with and the SQL the rows are read back with are both observed.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const querystring = require('node:querystring');
const fs = require('node:fs');
const path = require('node:path');

const { indexedKind, indexFilter, andOData, INDEX_MAPS, ID_PAGE } = require('../../src/search/native-index');
const aiSearch = require('../../src/search/ai-search');
const { nameContainsClause, NAME_CONTAINS_FIELDS } = require('../../src/search/eagle-query');
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
  ranges: { dateUpdatedStart: { field: 'dateUpdated', op: 'ge' } },
  contains: { nameContains: 'name' },
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

  await t.test('a List-ref filter and a decision-date edge land on their index columns', () => {
    const open = { tier: TIER.PRIVILEGED, roles: ['sysadmin', SEALED_TOKEN], compartment: true };
    const parsed = {
      filters: { 'eacDecision._id': ['E1'], 'CEAAInvolvement._id': ['C1'] },
      ranges: [{ field: 'decisionDate', op: 'ge', value: '2020-01-01' }],
      q: 'mine'
    };
    assert.strictEqual(indexFilter(MAP, parsed, open).filter,
      "(eacDecisionId eq 'E1') and (ceaaInvolvementId eq 'C1') and (decisionDate ge 2020-01-01T00:00:00.000Z)");
  });

  await t.test('a project sector and dateUpdated range land on their index columns', () => {
    const open = { tier: TIER.PRIVILEGED, roles: ['sysadmin', SEALED_TOKEN], compartment: true };
    const parsed = {
      filters: { sector: ['LNG', 'Mines'] },
      ranges: [{ field: 'dateUpdated', op: 'ge', value: '2026-01-01' }, { field: 'dateUpdated', op: 'le', value: '2026-01-31' }]
    };
    assert.strictEqual(indexFilter(MAP, parsed, open).filter, "(search.in(sector, 'LNG,Mines', ',')) and " +
      '(dateUpdated ge 2026-01-01T00:00:00.000Z) and (dateUpdated le 2026-01-31T23:59:59.999Z)');
  });

  await t.test('an activities dateAdded range lands on its index column', () => {
    const open = { tier: TIER.PRIVILEGED, roles: ['sysadmin', SEALED_TOKEN], compartment: true };
    const parsed = { filters: {}, ranges: [{ field: 'dateAdded', op: 'ge', value: '2026-02-01' }] };
    assert.strictEqual(indexFilter(INDEX_MAPS.activities, parsed, open).filter, '(dateAdded ge 2026-02-01T00:00:00.000Z)');
  });

  await t.test('hasDocumentUrl reaches the activities index, with null and \'\' both read as no document', () => {
    const open = { tier: TIER.PRIVILEGED, roles: ['sysadmin', SEALED_TOKEN], compartment: true };
    const filterWith = present => indexFilter(INDEX_MAPS.activities, { filters: {}, presence: { documentUrl: present } }, open).filter;
    assert.strictEqual(filterWith(true), "((documentUrl ne null and documentUrl ne ''))");
    assert.strictEqual(filterWith(false), "((documentUrl eq null or documentUrl eq ''))");
  });

  await t.test('a paged index refuses a presence test it has no column for', () => {
    const open = { tier: TIER.PRIVILEGED, roles: ['sysadmin', SEALED_TOKEN], compartment: true };
    assert.throws(() => indexFilter(INDEX_MAPS.documents, { filters: {}, presence: { documentUrl: true } }, open),
      /cannot filter on documentUrl here/);
  });

  await t.test('a paged index refuses a flag, even on a column it maps', () => {
    const open = { tier: TIER.PRIVILEGED, roles: ['sysadmin', SEALED_TOKEN], compartment: true };
    assert.throws(() => indexFilter(INDEX_MAPS.documents, { filters: {}, flags: { isFeatured: true } }, open),
      /cannot filter on isFeatured here/);
  });

  await t.test('every paged sort column is sortable in its index definition', () => {
    for (const [index, map] of Object.entries(INDEX_MAPS).filter(([, map]) => map.paged)) {
      const file = path.join(__dirname, '..', '..', 'azure', 'search', 'indexes', `${index}.json`);
      const sortable = new Set(JSON.parse(fs.readFileSync(file, 'utf8')).fields.filter(f => f.sortable).map(f => f.name));
      assert.deepStrictEqual(Object.values(map.sorts).filter(column => !sortable.has(column)), [], index);
    }
  });

  await t.test('every mapped column is filterable, and every contains column searchable, in its index definition', () => {
    for (const [index, map] of Object.entries(INDEX_MAPS)) {
      const file = path.join(__dirname, '..', '..', 'azure', 'search', 'indexes', `${index}.json`);
      const fields = JSON.parse(fs.readFileSync(file, 'utf8')).fields;
      const filterable = new Set(fields.filter(f => f.filterable).map(f => f.name));
      const searchable = new Set(fields.filter(f => f.searchable).map(f => f.name));
      assert.deepStrictEqual(Object.values(map.columns).filter(column => !filterable.has(column)), [], index);
      assert.deepStrictEqual(Object.values(map.contains || {}).flat().filter(column => !searchable.has(column)), [], index);
    }
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

  await t.test('q with dateUpdatedStart sends an OData range and keeps it in the re-read', async (t) => {
    const { searches, queries } = fakeStores(t);
    const res = await call('q=mine&dateUpdatedStart=2026-01-01');
    assert.strictEqual(res.status, 200);
    assert.match(searches[0].filter, /\(dateUpdated ge 2026-01-01T00:00:00\.000Z\)$/);
    assert.match(queries[0].query, /c\.dateUpdated >= @nr0/);
  });

  await t.test('q with nameContains matches the name in the index and re-checks it in Cosmos', async (t) => {
    const { searches, queries } = fakeStores(t);
    const res = await call('q=mine&nameContains=lng');
    assert.strictEqual(res.status, 200);
    const clause = nameContainsClause(NAME_CONTAINS_FIELDS.Project, aiSearch.buildContainsQuery('lng'));
    assert.ok(searches[0].filter.endsWith(` and (${clause})`), searches[0].filter);
    assert.match(queries[0].query, /CONTAINS\(c\.name, @nc0, true\)/);
    assert.ok(queries[0].parameters.some(p => p.name === '@nc0' && p.value === 'lng'));
  });

  await t.test('q with nameContains finds a match the keyword ranks past the id page', async (t) => {
    const all = Array.from({ length: 300 }, (_, i) => ({
      id: `p${i + 1}`, name: i + 1 === 280 ? 'LNG Canada' : `Mine ${i + 1}`, read: ['public']
    }));
    const searches = [];
    t.mock.method(aiSearch, 'searchProjects', async (opts) => {
      searches.push(opts);
      const hits = /search\.ismatch/.test(opts.filter || '') ? all.filter(r => /\blng/i.test(r.name)) : all;
      return { count: hits.length, items: hits.slice(0, opts.top).map(r => ({ id: r.id })) };
    });
    t.mock.method(cosmos, 'query', async (container, spec) => {
      const ids = new Set(spec.parameters.filter(p => p.name.startsWith('@xid')).map(p => p.value));
      const text = spec.parameters.find(p => p.name === '@nc0').value.toLowerCase();
      return { items: all.filter(r => ids.has(r.id) && r.name.toLowerCase().includes(text)) };
    });

    const res = await call('q=mine&nameContains=lng&count=true');
    assert.strictEqual(res.status, 200);
    assert.match(searches[0].filter, /search\.ismatch\('lng\*', 'name,nameTokens', 'full', 'any'\)/);
    assert.deepStrictEqual(res.body.map(r => r.id), ['p280']);
    assert.strictEqual(res.headers['x-total-count'], '1');
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

// Paged mode: the documents index pages and counts; Cosmos re-reads the page's ids.
const { documentsAcl } = require('../../src/search/document-query');
const { logger } = require('../../src/utils/logger');

const DOCS = Array.from({ length: 12 }, (_, i) => ({
  id: `d${i + 1}`, projectId: 'p1', read: ['public'], displayName: `Document ${i + 1}`
}));
const ID_FILTERS = ['projectId', 'typeId', 'milestoneId', 'projectPhaseId', 'documentAuthorTypeId'];
const UPDATE_IMAGES_OUT = { clause: 'c.documentSource != @src', params: [{ name: '@src', value: 'UPDATE' }] };

const DOC_SPEC = {
  entity: 'documents',
  repository: indexedKind({
    index: 'documents', container: 'documents', entity: 'documents', partitionField: 'projectId',
    defaultOrder: 'c.id ASC', baseCriteria: [UPDATE_IMAGES_OUT]
  }),
  sortKeys: ['datePosted', 'displayName', 'milestone'],
  // `description` has no index text match, so its contains filter cannot page in the index.
  contains: { displayNameContains: 'displayName', descriptionContains: 'description' },
  // `documentFileName` is a declared filter with no index column.
  filters: [...ID_FILTERS, 'isFeatured', 'legislation', 'documentFileName'],
  aliases: { project: 'projectId' },
  multiValueFilters: [...ID_FILTERS, 'legislation'],
  ranges: { datePostedStart: { field: 'datePosted', op: 'ge' }, datePostedEnd: { field: 'datePosted', op: 'le' } },
  qFields: ['displayName', 'description']
};
const docList = listHandler(DOC_SPEC);
const STAFF_USER = { realm_access: { roles: ['staff'] } };

/** The index answers `ids` with `count`; Cosmos answers the `@xid` rows it was asked for, reversed. */
function fakeDocStores(t, { ids = ['d3', 'd1', 'd2'], count = ids.length } = {}) {
  const searches = [];
  const queries = [];
  t.mock.method(aiSearch, 'searchDocumentIds', async (opts) => {
    searches.push(opts);
    return { ids, count };
  });
  t.mock.method(cosmos, 'query', async (container, spec) => {
    queries.push(spec);
    if (spec.query.includes('COUNT(1)')) return { items: [DOCS.length] };
    const asked = spec.parameters.filter(p => p.name.startsWith('@xid')).map(p => p.value);
    const rows = asked.length ? DOCS.filter(row => asked.includes(row.id)) : DOCS;
    return { items: structuredClone(rows).reverse() };
  });
  return { searches, queries };
}

async function callDocs(qs, { user } = {}) {
  const req = { query: querystring.parse(qs), params: {}, headers: {}, header: () => undefined, user };
  const res = makeRes('test');
  await docList(req, res);
  return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : undefined };
}

/** The `c.vis.<field>` names in the data source's `searchVis` column, the last one before its alias. */
function searchVisFields() {
  const file = path.join(__dirname, '../../azure/search/datasources/demi-documents-ds.json');
  const query = JSON.parse(fs.readFileSync(file, 'utf8')).container.query;
  const end = query.indexOf(' AS searchVis');
  const expression = query.slice(query.lastIndexOf(' AS ', end - 1), end);
  return [...new Set([...expression.matchAll(/c\.vis\.(\w+)/g)].map(m => m[1]))].sort();
}

test('documents list over the paged index', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('page 30 of 10 sends skip 290 top 10 and re-reads 10 ids', async (t) => {
    const ids = DOCS.slice(0, 10).map(row => row.id);
    const { searches, queries } = fakeDocStores(t, { ids, count: 400 });
    const res = await callDocs('q=report&page=30&pageSize=10');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(searches.length, 1);
    assert.strictEqual(searches[0].skip, 290);
    assert.strictEqual(searches[0].top, 10);
    assert.strictEqual(queries.length, 1);
    assert.deepStrictEqual(queries[0].parameters.filter(p => p.name.startsWith('@xid')).map(p => p.value), ids);
  });

  await t.test('rows come back in index order, not Cosmos order', async (t) => {
    fakeDocStores(t, { ids: ['d3', 'd1', 'd2'] });
    const res = await callDocs('q=report');
    assert.deepStrictEqual(res.body.map(row => row.id), ['d3', 'd1', 'd2']);
  });

  await t.test('count is @odata.count above 250', async (t) => {
    const { searches, queries } = fakeDocStores(t, { count: 1234 });
    const res = await callDocs('q=report&count=true');
    assert.strictEqual(res.headers['x-total-count'], '1234');
    assert.strictEqual(searches.length, 1, 'list and count share one index request');
    assert.strictEqual(queries.length, 1, 'list and count share one Cosmos re-read');
  });

  await t.test('the filter is the ACL, the update-image clause, searchVis, then the mapped filters', async (t) => {
    const { searches } = fakeDocStores(t);
    await callDocs('q=report&legislation=2002&legislation=2018');
    assert.strictEqual(searches[0].filter, `(${documentsAcl(ANON).filter}) and (documentSource ne 'UPDATE')` +
      ' and (searchVis ge 4) and ((legislation eq 2002 or legislation eq 2018))');
  });

  await t.test('searchVis clause only with q', async (t) => {
    const { searches } = fakeDocStores(t);
    await callDocs('q=report');
    await callDocs('typeId=t1');
    assert.match(searches[0].filter, /\(searchVis ge 4\)/);
    assert.doesNotMatch(searches[1].filter, /searchVis/);
  });

  await t.test('searchVis takes the caller level', async (t) => {
    const { searches } = fakeDocStores(t);
    await callDocs('q=report&pageSize=10', { user: STAFF_USER });
    assert.match(searches[0].filter, /\(searchVis ge 2\)/);
  });

  await t.test('unmapped filter on index path 400', async (t) => {
    const { searches, queries } = fakeDocStores(t);
    const res = await callDocs('q=report&documentFileName=a.pdf');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /documentFileName/);
    assert.strictEqual(searches.length + queries.length, 0);
  });

  await t.test('displayNameContains matches the name fields in the index, never with CONTAINS', async (t) => {
    const { searches, queries } = fakeDocStores(t);
    const res = await callDocs('project=p1&displayNameContains=Part%20A');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(searches.length, 1, 'a name match goes to the index even with project=');
    const clause = nameContainsClause(NAME_CONTAINS_FIELDS.Document, aiSearch.buildContainsQuery('Part A'));
    assert.ok(searches[0].filter.endsWith(` and (${clause})`), searches[0].filter);
    assert.doesNotMatch(queries[0].query, /(?<!ARRAY_)CONTAINS\(/);
    for (const field of ['displayName', 'documentFileName']) {
      assert.ok(queries[0].query.includes(`c.vis[${JSON.stringify(field)}]`), `no dial check on ${field}`);
    }
  });

  await t.test('displayNameContains of punctuation alone sends no match clause', async (t) => {
    const { searches } = fakeDocStores(t);
    const res = await callDocs('displayNameContains=()');
    assert.strictEqual(res.status, 200);
    assert.doesNotMatch(searches[0].filter, /search\.ismatch/);
  });

  await t.test('a contains filter with no index text match 400', async (t) => {
    const { searches, queries } = fakeDocStores(t);
    const res = await callDocs('descriptionContains=report');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /description/);
    assert.strictEqual(searches.length + queries.length, 0);
  });

  await t.test('pageSize 600 on index path 400', async (t) => {
    const { searches } = fakeDocStores(t);
    const res = await callDocs('q=report&pageSize=600', { user: STAFF_USER });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /at most 500/);
    assert.strictEqual(searches.length, 0);
  });

  await t.test('INDEX_MAPS.documents.searched equals the c.vis fields of the searchVis projection', () => {
    assert.deepStrictEqual([...INDEX_MAPS.documents.searched].sort(), searchVisFields());
  });

  await t.test('isFeatured=true sends isFeatured eq true', async (t) => {
    const { searches } = fakeDocStores(t);
    await callDocs('isFeatured=true');
    assert.match(searches[0].filter, /\(isFeatured eq true\)$/);
  });

  await t.test('isFeatured=yes 400', async (t) => {
    const { searches } = fakeDocStores(t);
    assert.strictEqual((await callDocs('isFeatured=yes')).status, 400);
    assert.strictEqual(searches.length, 0);
  });

  await t.test('legislation=2002 sends legislation eq 2002', async (t) => {
    const { searches } = fakeDocStores(t);
    await callDocs('legislation=2002');
    assert.match(searches[0].filter, /\(legislation eq 2002\)$/);
  });

  await t.test('legislation=2002&legislation=2018 sends (legislation eq 2002 or legislation eq 2018)', async (t) => {
    const { searches } = fakeDocStores(t);
    await callDocs('legislation=2002&legislation=2018');
    assert.ok(searches[0].filter.endsWith(' and ((legislation eq 2002 or legislation eq 2018))'), searches[0].filter);
    assert.doesNotMatch(searches[0].filter, /search\.in\(legislation/);
  });

  await t.test('legislation=1) or (true 400', async (t) => {
    const { searches, queries } = fakeDocStores(t);
    const res = await callDocs(`legislation=${encodeURIComponent('1) or (true')}&q=report&count=true`);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.headers['x-total-count'], undefined);
    assert.strictEqual(searches.length + queries.length, 0);
  });

  await t.test('one bad legislation value among good ones 400', async (t) => {
    const { searches } = fakeDocStores(t);
    assert.strictEqual((await callDocs('legislation=2002&legislation=20021')).status, 400);
    assert.strictEqual(searches.length, 0);
  });

  await t.test('datePostedStart and datePostedEnd send datePosted ge and le', async (t) => {
    const { searches } = fakeDocStores(t);
    await callDocs('datePostedStart=2026-01-01&datePostedEnd=2026-01-31');
    assert.ok(searches[0].filter.endsWith(
      ' and (datePosted ge 2026-01-01T00:00:00.000Z) and (datePosted le 2026-01-31T23:59:59.999Z)'), searches[0].filter);
  });

  await t.test('datePostedStart=x 400', async (t) => {
    const { searches, queries } = fakeDocStores(t);
    const res = await callDocs('datePostedStart=x');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /YYYY-MM-DD/);
    assert.strictEqual(searches.length + queries.length, 0);
  });

  await t.test('no q and no sort orders datePosted desc, id', async (t) => {
    const { searches } = fakeDocStores(t);
    await callDocs('typeId=t1');
    assert.strictEqual(searches[0].orderby, 'datePosted desc, id');
  });

  await t.test('q with no sort orders by relevance then id', async (t) => {
    const { searches } = fakeDocStores(t);
    await callDocs('q=report');
    assert.strictEqual(searches[0].orderby, 'search.score() desc, id');
  });

  await t.test('sort on displayName orders by its sort column, then id', async (t) => {
    const { searches } = fakeDocStores(t);
    await callDocs('q=report&sort=-displayName');
    assert.strictEqual(searches[0].orderby, 'displayNameSort desc, id');
  });

  await t.test('sort=milestone orders by its label column, then id', async (t) => {
    const { searches } = fakeDocStores(t);
    await callDocs('project=p1&sort=milestone');
    assert.strictEqual(searches[0].orderby, 'milestone asc, id');
  });

  await t.test('re-read checks only the dial for isFeatured', async (t) => {
    const { queries } = fakeDocStores(t);
    await callDocs('isFeatured=true&typeId=t1');
    const sql = queries[0];
    assert.ok(sql.query.includes('c.vis["isFeatured"]'), sql.query);
    assert.doesNotMatch(sql.query, /c\.isFeatured\s*=/);
    assert.ok(!sql.parameters.some(p => p.value === 'true' || p.value === true), 'isFeatured value bound in Cosmos');
    assert.ok(sql.parameters.some(p => p.value === 't1'), 'a string filter still narrows in Cosmos');
    assert.doesNotMatch(sql.query, /ORDER BY/);
  });

  await t.test('re-read checks the searched fields only with q', async (t) => {
    const { queries } = fakeDocStores(t);
    await callDocs('q=report');
    await callDocs('typeId=t1');
    assert.ok(queries[0].query.includes('c.vis["documentFileName"]'), queries[0].query);
    assert.ok(!queries[1].query.includes('c.vis["documentFileName"]'), queries[1].query);
  });

  await t.test('baseCriteria narrow the re-read', async (t) => {
    const { queries } = fakeDocStores(t);
    await callDocs('q=report');
    assert.ok(queries[0].query.includes(UPDATE_IMAGES_OUT.clause), queries[0].query);
  });

  await t.test('a short re-read warns and serves the shorter page', async (t) => {
    fakeDocStores(t, { ids: ['d1', 'gone'] });
    const warn = t.mock.method(logger, 'warn', () => {});
    const res = await callDocs('q=report');
    assert.deepStrictEqual(res.body.map(row => row.id), ['d1']);
    assert.strictEqual(warn.mock.callCount(), 1);
  });

  await t.test('no index hit reads nothing from Cosmos', async (t) => {
    const { queries } = fakeDocStores(t, { ids: [], count: 0 });
    const res = await callDocs('q=nothing&count=true');
    assert.deepStrictEqual(res.body, []);
    assert.strictEqual(res.headers['x-total-count'], '0');
    assert.strictEqual(queries.length, 0);
  });

  await t.test('a caller that can match nothing sends no request', async (t) => {
    const { searches, queries } = fakeDocStores(t);
    const nothing = { tier: TIER.SCOPED, projectScope: [], roles: [] };
    const parsed = { q: 'report', filters: {}, ranges: [], pageNum: 0, pageSize: 10 };
    assert.deepStrictEqual(await DOC_SPEC.repository.list(nothing, { parsed, criteria: [], pageNum: 0, pageSize: 10 }), []);
    assert.strictEqual(await DOC_SPEC.repository.count(nothing, { parsed, criteria: [] }), 0);
    assert.strictEqual(searches.length + queries.length, 0);
  });
});

test('documents store choice', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('project= with no q, sort or typed filter reads Cosmos, with baseCriteria', async (t) => {
    const { searches, queries } = fakeDocStores(t);
    const res = await callDocs('project=p1&typeId=t1&count=true');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(searches.length, 0);
    assert.ok(queries.length === 2 && queries.every(sql => sql.query.includes(UPDATE_IMAGES_OUT.clause)));
  });

  await t.test('ids= without q reads Cosmos', async (t) => {
    const { searches } = fakeDocStores(t);
    await callDocs('ids=d1,d2');
    assert.strictEqual(searches.length, 0);
  });

  await t.test('no project= reads the index', async (t) => {
    const { searches } = fakeDocStores(t);
    await callDocs('typeId=t1');
    assert.strictEqual(searches.length, 1);
  });

  const indexed = ['project=p1&isFeatured=true', 'project=p1&legislation=2002', 'project=p1&datePostedEnd=2026-01-01',
    'project=p1&sort=datePosted', 'project=p1&q=report', 'ids=d1&q=report'];
  for (const qs of indexed) {
    await t.test(`${qs} reads the index`, async (t) => {
      const { searches } = fakeDocStores(t);
      await callDocs(qs);
      assert.strictEqual(searches.length, 1);
    });
  }
});
