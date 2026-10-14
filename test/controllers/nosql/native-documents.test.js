'use strict';

// Native `GET /documents` (`getDocuments`) and the token-paged `GET /documents/scan`
// (`scanDocuments`). One project's plain list reads Cosmos; every other list pages in the documents
// index and re-reads the page's ids from Cosmos. No Cosmos or index runs here: the specs sent are
// the observable surface, with the rows a fake store hands back.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const querystring = require('node:querystring');

// First: the logger's uncaughtException handler would swallow a load failure here into a green run.
const documentController = require('../../../src/controllers/nosql/document');
const { counts } = require('../../../src/controllers/native/counts');
const cosmos = require('../../../src/db/cosmos-nosql');
const aiSearch = require('../../../src/search/ai-search');
const projects = require('../../../src/repositories/projects');
const { makeRes } = require('../../../src/http/router');

const STAFF = { realm_access: { roles: ['staff'] } };

// Null-safe: a missing or null documentSource must keep the row, which `!=` alone would not.
const EXCLUSION = '(NOT IS_STRING(c.documentSource) OR c.documentSource != @updateSource)';

const SCAN_CLEARED = "(NOT IS_STRING(c.scanStatus) OR c.scanStatus = 'clean')";

const DOCS = [
  {
    id: 'd1', projectId: '207', read: ['public'], displayName: 'Application Part A',
    s3Key: '207/part-a.pdf', sealedAt: '2026-09-01T00:00:00.000Z', _etag: '"0x8DF0"'
  },
  { id: 'd2', projectId: '207', read: ['public'], displayName: 'Application Part B' }
];

/**
 * Fake stores. The index answers `ids` with `count`; Cosmos answers COUNT with `total`, an `@xid`
 * read with those rows, and any other list with every row plus `continuationToken`. Every index
 * request and Cosmos spec is recorded.
 */
function fakeStores(t, { ids = ['d2', 'd1'], count = ids.length, total = DOCS.length, continuationToken } = {}) {
  const searches = [];
  const queries = [];
  t.mock.method(aiSearch, 'searchDocumentIds', async (opts) => {
    searches.push(opts);
    return { ids, count };
  });
  t.mock.method(cosmos, 'query', async (container, spec) => {
    queries.push({ container, ...spec });
    if (spec.query.includes('COUNT(1)')) return { items: [total] };
    const asked = spec.parameters.filter(p => p.name.startsWith('@xid')).map(p => p.value);
    const rows = asked.length ? DOCS.filter(row => asked.includes(row.id)) : DOCS;
    return { items: structuredClone(rows), continuationToken };
  });
  t.mock.method(projects, 'listRowsByIds', async () => []);
  return { searches, queries };
}

const param = (spec, name) => spec.parameters.find(p => p.name === name)?.value;
const documentReads = queries => queries.filter(spec => spec.container === 'documents');

async function call(handler, qs, user) {
  const req = { query: querystring.parse(qs), params: {}, headers: {}, header: () => undefined, user };
  const res = makeRes('test');
  await handler(req, res);
  return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : undefined };
}

const list = (qs, user) => call(documentController.getDocuments, qs, user);

test('native documents list', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('anonymous list withholds sealedAt', async (t) => {
    fakeStores(t);
    const res = await list('project=207');

    assert.strictEqual(res.status, 200);
    const row = res.body.find(doc => doc.id === 'd1');
    assert.strictEqual(row.displayName, 'Application Part A', 'the row survives');
    assert.strictEqual(row.sealedAt, undefined, 'sealedAt is level 2');
    assert.strictEqual(row.s3Key, undefined, 'the object key is never public');
    assert.strictEqual(row.read, undefined, 'the ACL is withheld');
    assert.strictEqual(row._etag, undefined, 'the concurrency token is withheld');
  });

  await t.test('continuationToken 400', async (t) => {
    const { searches, queries } = fakeStores(t);
    const res = await list('project=207&continuationToken=abc', STAFF);

    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /unknown parameter: continuationToken/);
    assert.strictEqual(searches.length + queries.length, 0, 'a refusal reads nothing');
  });

  await t.test('update images excluded on both paths', async (t) => {
    const { searches, queries } = fakeStores(t);

    await list('project=207');
    const [cosmosList] = documentReads(queries);
    assert.ok(cosmosList.query.includes(EXCLUSION), cosmosList.query);
    assert.strictEqual(param(cosmosList, '@updateSource'), 'UPDATE');
    assert.strictEqual(searches.length, 0, 'the Cosmos path sends no index request');

    queries.length = 0;
    await list('');
    assert.match(searches[0].filter, /documentSource ne 'UPDATE'/);
    const [reread] = documentReads(queries);
    assert.ok(reread.query.includes(EXCLUSION), 'the index page re-read leaves them out as well');
  });

  await t.test('rows carry projectName and projectEagleId', async (t) => {
    fakeStores(t);
    t.mock.method(projects, 'listRowsByIds', async () => [
      { id: '207', name: 'Site C', eagleId: '5c8f0b2a1d2e3f4a5b6c7d8e', read: ['public'] }
    ]);
    const res = await list('project=207');

    assert.strictEqual(res.body[0].projectName, 'Site C');
    assert.strictEqual(res.body[0].projectEagleId, '5c8f0b2a1d2e3f4a5b6c7d8e');
  });

  await t.test('project= with no q, sort or typed filter reads Cosmos', async (t) => {
    const { searches, queries } = fakeStores(t);
    const res = await list('project=207&typeId=t1');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(searches.length, 0);
    const [cosmosList] = documentReads(queries);
    assert.match(cosmosList.query, /c\.projectId/);
    assert.ok(cosmosList.parameters.some(p => p.value === '207'), 'the project id is bound');
    assert.deepStrictEqual(res.body.map(doc => doc.id), ['d1', 'd2']);
  });

  await t.test('no project= reads the index', async (t) => {
    const { searches } = fakeStores(t);
    const res = await list('typeId=t1');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(searches.length, 1);
    assert.match(searches[0].filter, /typeId/);
    assert.deepStrictEqual(res.body.map(doc => doc.id), ['d2', 'd1'], 'rows take the index order');
  });

  await t.test('project= with isFeatured reads the index', async (t) => {
    const { searches } = fakeStores(t);
    const res = await list('project=207&isFeatured=true');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(searches.length, 1);
    assert.match(searches[0].filter, /isFeatured eq true/);
  });

  await t.test('sort=sortOrder pages in the index: staff order, then newest, then name', async (t) => {
    const { searches, queries } = fakeStores(t);
    const res = await list('project=207&sort=sortOrder', STAFF);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(searches[0].orderby, 'sortOrder asc, datePosted desc, displayNameSort asc, id');
    assert.ok(!documentReads(queries).some(spec => /ORDER BY c\.sortOrder/.test(spec.query)),
      'Cosmos never sorts on it');
  });

  await t.test('sort=-sortOrder reverses only the staff order', async (t) => {
    const { searches } = fakeStores(t);
    await list('project=207&sort=-sortOrder', STAFF);

    assert.strictEqual(searches[0].orderby, 'sortOrder desc, datePosted desc, displayNameSort asc, id');
  });

  await t.test('documentSource on one project reads Cosmos with the value bound', async (t) => {
    const { searches, queries } = fakeStores(t);
    const res = await list('project=207&documentSource=PROJECT', STAFF);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(searches.length, 0);
    const [cosmosList] = documentReads(queries);
    assert.match(cosmosList.query, /c\.documentSource/);
    assert.ok(cosmosList.parameters.some(p => p.value === 'PROJECT'), 'the source is bound');
  });

  await t.test('documentSource repeats, and the index path filters on it with q', async (t) => {
    const { searches } = fakeStores(t);
    const res = await list('q=report&documentSource=PROJECT&documentSource=COMMENT', STAFF);

    assert.strictEqual(res.status, 200);
    assert.ok(searches[0].filter.includes("search.in(documentSource, 'PROJECT,COMMENT', ',')"),
      searches[0].filter);
  });

  await t.test('authenticated list with no pageSize defaults to 500, not 400', async (t) => {
    const { searches } = fakeStores(t);
    const res = await list('', STAFF);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(searches[0].top, aiSearch.MAX_PAGE_ROWS);
  });

  await t.test('anonymous list with no pageSize keeps the anonymous cap', async (t) => {
    const { searches } = fakeStores(t);
    await list('');

    assert.strictEqual(searches[0].top, 100);
  });

  await t.test('an authenticated pageSize the index cannot take is still 400', async (t) => {
    const { searches } = fakeStores(t);
    const res = await list('pageSize=600', STAFF);

    assert.strictEqual(res.status, 400);
    assert.strictEqual(searches.length, 0);
  });
});

// An image uploaded through the eagle-admin Update form: shown on its Update, fetched by id.
const UPDATE_IMAGE = { id: 'd3', projectId: '207', read: ['public'], documentSource: 'UPDATE', s3Key: '207/photo.jpg' };

/**
 * A Cosmos fake that honours the two clauses these tests are about: the `@nid` ids an `ids=` read
 * binds, and the Update-image exclusion. Every spec sent is recorded.
 */
function fakeIdsStore(t) {
  const queries = [];
  t.mock.method(cosmos, 'query', async (container, spec) => {
    queries.push({ container, ...spec });
    const asked = spec.parameters.filter(p => p.name.startsWith('@nid')).map(p => p.value);
    const rows = [...DOCS, UPDATE_IMAGE]
      .filter(row => asked.length === 0 || asked.includes(row.id))
      .filter(row => !spec.query.includes(EXCLUSION) || row.documentSource !== 'UPDATE');
    return { items: structuredClone(rows) };
  });
  t.mock.method(projects, 'listRowsByIds', async () => []);
  return { queries };
}

test('native documents ids= read', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('ids= returns an Update-form image, as GET /documents/:id does', async (t) => {
    fakeIdsStore(t);
    const res = await list('ids=d3,d1', STAFF);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.map(doc => doc.id).sort(), ['d1', 'd3']);
  });

  await t.test('a project list without ids= still leaves the Update image out', async (t) => {
    fakeIdsStore(t);
    const res = await list('project=207', STAFF);

    assert.ok(!res.body.some(doc => doc.id === 'd3'), JSON.stringify(res.body.map(doc => doc.id)));
  });

  await t.test("ids= keeps the caller's read and scan gates and anonymous redaction", async (t) => {
    const { queries } = fakeIdsStore(t);
    const res = await list('ids=d3');

    const [read] = documentReads(queries);
    assert.match(read.query, /c\.read/, 'the visibility predicate is in the query');
    assert.strictEqual(param(read, '@role0'), 'public');
    assert.ok(read.query.includes(SCAN_CLEARED), 'an unreleased upload stays out');
    assert.strictEqual(res.body[0].s3Key, undefined, 'the object key is never public');
  });
});

test('documents count', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test("/counts?kind=documents&q= equals the list's x-total-count", async (t) => {
    fakeStores(t, { count: 417 });
    const listed = await list('q=report&count=true', STAFF);
    const counted = await call(counts, 'kind=documents&q=report', STAFF);

    assert.strictEqual(listed.headers['x-total-count'], '417');
    assert.strictEqual(counted.status, 200);
    assert.deepStrictEqual(counted.body, { documents: Number(listed.headers['x-total-count']) });
  });

  await t.test("/counts?kind=documents&project= equals the list's x-total-count", async (t) => {
    const { queries } = fakeStores(t, { total: 9 });
    const listed = await list('project=207&count=true');
    const counted = await call(counts, 'kind=documents&project=207');

    assert.strictEqual(listed.headers['x-total-count'], '9');
    assert.deepStrictEqual(counted.body, { documents: 9 });
    const countSpecs = documentReads(queries).filter(spec => spec.query.includes('COUNT(1)'));
    assert.ok(countSpecs.every(spec => spec.query.includes(EXCLUSION)), 'both counts leave update images out');
  });

  await t.test('/counts?kind=documents&legislation=x is 400, not 500', async (t) => {
    const { searches } = fakeStores(t);
    const res = await call(counts, 'kind=documents&legislation=x');

    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /legislation/);
    assert.strictEqual(searches.length, 0);
  });
});

test('document scan', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('scanDocuments keeps x-continuation-token and extracted=false', async (t) => {
    const { searches, queries } = fakeStores(t, { continuationToken: 'next-page' });
    const res = await call(documentController.scanDocuments, 'extracted=false&pageSize=1000', STAFF);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['x-continuation-token'], 'next-page');
    const [scan] = documentReads(queries);
    assert.strictEqual(param(scan, '@extracted'), false);
    assert.ok(scan.query.includes(EXCLUSION), 'the work list leaves update images out');
    assert.strictEqual(searches.length, 0, 'the scan never reads the index');
  });
});
