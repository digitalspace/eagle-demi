'use strict';

// PUT /documents/:id with `isFeatured` and the featured cap (domain/document-feature.js).

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../../../src/config');
const cosmos = require('../../../src/db/cosmos-nosql');
const documents = require('../../../src/repositories/documents');
const documentController = require('../../../src/controllers/nosql/document');

const STAFF = { sub: 'kc-sub-1', preferred_username: 'staff', realm_access: { roles: ['staff'] } };
const STORED = Object.freeze({
  id: 'd1', projectId: '207', displayName: 'Application', read: ['public', 'staff'], isPublished: true, isFeatured: false
});

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    setHeader() {}
  };
}

/** Stores `row`, answers `featured` to the cap count, and returns what was written. */
function store(t, row, featured) {
  const state = { saved: undefined, counted: [] };
  t.mock.method(documents, 'getById', async () => structuredClone(row));
  t.mock.method(documents, 'countFeatured', async (projectId, opts) => {
    state.counted.push({ projectId, ...opts });
    return featured;
  });
  t.mock.method(documents, 'upsert', async (doc) => { state.saved = doc; return doc; });
  return state;
}

async function put(body) {
  const res = mockRes();
  await documentController.updateDocument({ params: { id: 'd1' }, query: {}, user: STAFF, body }, res);
  return res;
}

test('PUT /documents/:id isFeatured', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('features a document while its project is under the cap', async () => {
    const state = store(t, STORED, 4);
    const res = await put({ isFeatured: true });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(state.saved.isFeatured, true);
    assert.deepStrictEqual(state.counted, [{ projectId: '207', exceptId: 'd1' }]);
  });

  await t.test('unfeatures a document without counting', async () => {
    const state = store(t, { ...STORED, isFeatured: true }, 5);
    const res = await put({ isFeatured: false });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(state.saved.isFeatured, false);
    assert.strictEqual(state.counted.length, 0);
  });

  await t.test('a project at the cap answers 409 naming the limit, and nothing is written', async () => {
    const state = store(t, STORED, 5);
    const res = await put({ isFeatured: true, displayName: 'Renamed' });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.limit, 5);
    assert.match(res.body.error, /at most 5 featured documents/);
    assert.strictEqual(state.saved, undefined);
  });

  await t.test('re-saving a featured document in a full project is not refused', async () => {
    const state = store(t, { ...STORED, isFeatured: true }, 5);
    const res = await put({ isFeatured: true, displayName: 'Renamed' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(state.saved.displayName, 'Renamed');
  });

  await t.test('the cap is read from config', async (t2) => {
    const { featuredDocumentsMax } = config;
    config.featuredDocumentsMax = 2;
    t2.after(() => { config.featuredDocumentsMax = featuredDocumentsMax; });
    const state = store(t, STORED, 2);
    const res = await put({ isFeatured: true });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.limit, 2);
    assert.strictEqual(state.saved, undefined);
  });

  await t.test('a non-boolean isFeatured is a 400, so a string cannot skip the cap', async () => {
    const state = store(t, STORED, 5);
    const res = await put({ isFeatured: 'true' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(state.saved, undefined);
  });
});

test('countFeatured counts one project\'s featured, undeleted rows other than the one named', async (t) => {
  let sent;
  t.mock.method(cosmos, 'queryValue', async (_container, spec, options) => { sent = { spec, options }; return 3; });

  assert.strictEqual(await documents.countFeatured('207', { exceptId: 'd1' }), 3);
  const params = Object.fromEntries(sent.spec.parameters.map(p => [p.name, p.value]));
  assert.strictEqual(params['@featured'], true);
  assert.strictEqual(params['@exceptId'], 'd1');
  assert.match(sent.spec.query, /c\.isFeatured = @featured/);
  assert.match(sent.spec.query, /c\.id != @exceptId/);
  assert.match(sent.spec.query, /NOT \(IS_BOOL\(c\.isDeleted\) AND c\.isDeleted = true\)/);
  assert.strictEqual(sent.options.partitionKey, '207');
});
