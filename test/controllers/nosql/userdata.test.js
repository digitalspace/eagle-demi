'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const userdata = require('../../../src/repositories/userdata');
const controller = require('../../../src/controllers/nosql/userdata');

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    setHeader() {}
  };
}

/** Mixed case on purpose: the partition key is lowercased so one user cannot end up with two. */
const STAFF = { sub: 'kc-sub-1', preferred_username: 'Staff.Person' };
const ME = 'staff.person';

function ring(points = 4) {
  return Array.from({ length: points }, (_, i) => [-123 + i / 1000, 49 + i / 1000]);
}

/** A search query string as the frontend builds it: no leading `?`. */
const PARAMS = 'record=documents&keywords=wildlife&scope=inside';

function req(extra = {}) {
  return { params: {}, query: {}, body: {}, user: STAFF, ...extra };
}

test('user data controller', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a saved area is stored under the lowercased owner with a lasso: id', async () => {
    let owner, record;
    t.mock.method(userdata, 'getItem', async () => null);
    t.mock.method(userdata, 'countByType', async () => 0);
    t.mock.method(userdata, 'put', async (userId, item) => { owner = userId; record = item; return item; });

    const res = mockRes();
    await controller.saveLasso(req({ body: { name: 'Skeena  Estuary!', ring: ring() } }), res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(owner, ME);
    assert.strictEqual(record.id, 'lasso:skeena-estuary');
    assert.strictEqual(record.type, 'lasso');
    assert.strictEqual(record.slug, 'skeena-estuary');
    assert.strictEqual(record.name, 'Skeena  Estuary!');
    assert.strictEqual(record.createdAt, record.updatedAt, 'a new area is created and updated at once');
    assert.deepStrictEqual(Object.keys(res.body).sort(), ['name', 'ring', 'slug', 'updatedAt']);
  });

  await t.test('the owner comes from the token, never from the request', async () => {
    // The one assertion that has to hold: every repository call is scoped to the caller's own
    // partition, whatever the request says.
    const seen = [];
    t.mock.method(userdata, 'listAll', async (userId) => { seen.push(userId); return []; });
    t.mock.method(userdata, 'getItem', async (userId) => { seen.push(userId); return null; });
    t.mock.method(userdata, 'countByType', async (userId) => { seen.push(userId); return 0; });
    t.mock.method(userdata, 'put', async (userId, item) => { seen.push(userId); return item; });
    t.mock.method(userdata, 'remove', async (userId) => { seen.push(userId); return true; });

    const impersonation = { userId: 'someone.else', user: 'someone.else', me: 'someone.else' };

    await controller.getMyData(req({ query: impersonation }), mockRes());
    await controller.saveLasso(
      req({ body: { name: 'Mine', ring: ring() }, query: impersonation }), mockRes());
    await controller.putPrefs(
      req({ body: { landing: 'map', perPage: 6 }, query: impersonation }), mockRes());
    await controller.deleteLasso(
      req({ params: { slug: 'mine', userId: 'someone.else' }, query: impersonation }), mockRes());
    await controller.saveQuery(
      req({ body: { name: 'Mine', params: PARAMS }, query: impersonation }), mockRes());
    await controller.deleteQuery(
      req({ params: { slug: 'mine', userId: 'someone.else' }, query: impersonation }), mockRes());

    assert.ok(seen.length >= 8);
    assert.deepStrictEqual([...new Set(seen)], [ME], 'a repository call reached another partition');
  });

  await t.test('a client-supplied userId in the body is a 400, not a stored field', async () => {
    let stored = false;
    t.mock.method(userdata, 'put', async () => { stored = true; return {}; });

    const res = mockRes();
    await controller.saveLasso(
      req({ body: { name: 'Mine', ring: ring(), userId: 'someone.else' } }), res);

    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /unknown field/);
    assert.strictEqual(stored, false);
  });

  await t.test('a bad name, ring or body size is a 400 that never reaches storage', async () => {
    let stored = false;
    t.mock.method(userdata, 'getItem', async () => null);
    t.mock.method(userdata, 'countByType', async () => 0);
    t.mock.method(userdata, 'put', async () => { stored = true; return {}; });

    const bodies = [
      { name: '', ring: ring() },
      { name: '   ', ring: ring() },
      { name: 'x'.repeat(81), ring: ring() },
      { name: 42, ring: ring() },
      { name: '!!!', ring: ring() },
      { name: 'Ok', ring: ring(2) },
      { name: 'Ok', ring: ring(501) },
      { name: 'Ok', ring: 'not a ring' },
      { name: 'Ok', ring: [[-123, 49], [-123, 49], [-123]] },
      { name: 'Ok', ring: [[-123, 49], [-123, 49], [200, 49]] },
      { name: 'Ok', ring: [[-123, 49], [-123, 49], [-123, 91]] },
      { name: 'Ok', ring: [[-123, 49], [-123, 49], ['-123', '49']] },
      { name: 'Ok', ring: [[-123, 49], [-123, 49], [NaN, 49]] },
      { name: 'Ok', ring: ring(), junk: 'z'.repeat(70000) }
    ];

    for (const body of bodies) {
      const res = mockRes();
      await controller.saveLasso(req({ body }), res);
      assert.strictEqual(res.statusCode, 400, JSON.stringify(body).slice(0, 60));
      assert.ok(res.body.error && res.body.error.length > 0);
    }
    assert.strictEqual(stored, false, 'nothing reaches storage once validation fails');
  });

  await t.test('the 51st area is refused, but re-saving an existing one is not', async () => {
    let stored = false;
    t.mock.method(userdata, 'countByType', async () => 50);
    t.mock.method(userdata, 'put', async (userId, item) => { stored = true; return item; });

    t.mock.method(userdata, 'getItem', async () => null);
    const fresh = mockRes();
    await controller.saveLasso(req({ body: { name: 'One more', ring: ring() } }), fresh);
    assert.strictEqual(fresh.statusCode, 400);
    assert.match(fresh.body.error, /50/);
    assert.strictEqual(stored, false);

    t.mock.method(userdata, 'getItem', async () => ({
      id: 'lasso:one-more', createdAt: '2026-08-01T00:00:00.000Z'
    }));
    const again = mockRes();
    await controller.saveLasso(req({ body: { name: 'One more', ring: ring() } }), again);
    assert.strictEqual(again.statusCode, 200, 'the cap counts new ids only');
    assert.strictEqual(stored, true);
  });

  await t.test('an overwrite keeps the original createdAt', async () => {
    let record;
    t.mock.method(userdata, 'getItem', async () => ({
      id: 'lasso:mine', createdAt: '2026-08-01T00:00:00.000Z'
    }));
    t.mock.method(userdata, 'countByType', async () => 0);
    t.mock.method(userdata, 'put', async (userId, item) => { record = item; return item; });

    await controller.saveLasso(req({ body: { name: 'Mine', ring: ring() } }), mockRes());

    assert.strictEqual(record.createdAt, '2026-08-01T00:00:00.000Z');
    assert.notStrictEqual(record.updatedAt, record.createdAt);
  });

  await t.test('an empty partition reads as the default preferences and nothing saved', async () => {
    t.mock.method(userdata, 'listAll', async () => []);

    const res = mockRes();
    await controller.getMyData(req(), res);

    assert.deepStrictEqual(res.body,
      { prefs: { landing: 'map', perPage: 6 }, lassos: [], queries: [] });
  });

  await t.test('stored rows come back grouped by type, Cosmos fields left behind', async () => {
    t.mock.method(userdata, 'listAll', async () => [
      { id: 'prefs', userId: ME, type: 'prefs', landing: 'links', perPage: 24, _etag: 'x' },
      { id: 'lasso:mine', userId: ME, type: 'lasso', slug: 'mine', name: 'Mine',
        ring: ring(), createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z' }
    ]);

    const res = mockRes();
    await controller.getMyData(req(), res);

    assert.deepStrictEqual(res.body.prefs, { landing: 'links', perPage: 24 });
    assert.strictEqual(res.body.lassos.length, 1);
    assert.strictEqual(res.body.lassos[0].slug, 'mine');
    assert.strictEqual(res.body.lassos[0].name, 'Mine');
    assert.deepStrictEqual(Object.keys(res.body.lassos[0]).sort(), ['name', 'ring', 'slug', 'updatedAt']);
  });

  await t.test('a saved query is stored under the lowercased owner with a query: id', async () => {
    let owner, record;
    t.mock.method(userdata, 'getItem', async () => null);
    t.mock.method(userdata, 'countByType', async () => 0);
    t.mock.method(userdata, 'put', async (userId, item) => { owner = userId; record = item; return item; });

    const res = mockRes();
    await controller.saveQuery(
      req({ body: { name: 'Wildlife  Docs!', params: PARAMS } }), res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(owner, ME);
    assert.strictEqual(record.id, 'query:wildlife-docs');
    assert.strictEqual(record.type, 'query');
    assert.strictEqual(record.slug, 'wildlife-docs');
    assert.strictEqual(record.name, 'Wildlife  Docs!');
    assert.strictEqual(record.params, PARAMS);
    assert.deepStrictEqual(Object.keys(res.body).sort(), ['name', 'params', 'savedAt', 'slug']);
    assert.strictEqual(res.body.params, PARAMS);
  });

  await t.test('a saved query reads back beside the lassos', async () => {
    t.mock.method(userdata, 'listAll', async () => [
      { id: 'lasso:mine', userId: ME, type: 'lasso', slug: 'mine', name: 'Mine',
        ring: ring(), createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z' },
      { id: 'query:wildlife-docs', userId: ME, type: 'query', slug: 'wildlife-docs',
        name: 'Wildlife Docs', params: PARAMS, savedAt: '2026-08-03T00:00:00.000Z', _etag: 'x' }
    ]);

    const res = mockRes();
    await controller.getMyData(req(), res);

    assert.strictEqual(res.body.lassos.length, 1);
    assert.strictEqual(res.body.lassos[0].slug, 'mine');
    assert.strictEqual(res.body.lassos[0].name, 'Mine');
    assert.deepStrictEqual(res.body.queries, [{
      slug: 'wildlife-docs',
      name: 'Wildlife Docs',
      params: PARAMS,
      savedAt: '2026-08-03T00:00:00.000Z'
    }]);
  });

  await t.test('another user’s saved query is never returned', async () => {
    // listAll is partition-scoped, so the assertion that matters is the argument it is called
    // with: a query row belonging to someone else is only reachable by reading their partition.
    let asked;
    t.mock.method(userdata, 'listAll', async (userId) => {
      asked = userId;
      return userId === 'someone.else'
        ? [{ id: 'query:theirs', userId: 'someone.else', type: 'query', slug: 'theirs',
          name: 'Theirs', params: 'record=documents', savedAt: '2026-08-03T00:00:00.000Z' }]
        : [];
    });

    const res = mockRes();
    await controller.getMyData(req({ query: { userId: 'someone.else' }, params: { userId: 'someone.else' } }), res);

    assert.strictEqual(asked, ME);
    assert.deepStrictEqual(res.body.queries, []);
  });

  await t.test('a bad name, bad params or an oversized body is a 400 that never reaches storage', async () => {
    let stored = false;
    t.mock.method(userdata, 'getItem', async () => null);
    t.mock.method(userdata, 'countByType', async () => 0);
    t.mock.method(userdata, 'put', async () => { stored = true; return {}; });

    const bodies = [
      { name: '', params: PARAMS },
      { name: '   ', params: PARAMS },
      { name: 'x'.repeat(81), params: PARAMS },
      { name: 42, params: PARAMS },
      { name: '!!!', params: PARAMS },
      { name: 'Ok' },
      { name: 'Ok', params: 42 },
      { name: 'Ok', params: null },
      { name: 'Ok', params: 'a'.repeat(2001) },
      { name: 'Ok', params: 'keywords=caribou herd' },
      { name: 'Ok', params: 'keywords=<script>' },
      { name: 'Ok', params: 'keywords=a#b' },
      { name: 'Ok', params: "keywords=o'brien" },
      { name: 'Ok', params: 'keywords=a/b' },
      { name: 'Ok', params: 'keywords=caribou\n' },
      { name: 'Ok', params: PARAMS, ring: ring() },
      { name: 'Ok', params: PARAMS, userId: 'someone.else' },
      { name: 'Ok', params: 'a'.repeat(1999), junk: 'z'.repeat(70000) }
    ];

    for (const body of bodies) {
      const res = mockRes();
      await controller.saveQuery(req({ body }), res);
      assert.strictEqual(res.statusCode, 400, JSON.stringify(body).slice(0, 60));
      assert.ok(res.body.error && res.body.error.length > 0);
    }
    assert.strictEqual(stored, false, 'nothing reaches storage once validation fails');
  });

  await t.test('params at the 2000-character limit are accepted', async () => {
    t.mock.method(userdata, 'getItem', async () => null);
    t.mock.method(userdata, 'countByType', async () => 0);
    t.mock.method(userdata, 'put', async (userId, item) => item);

    const res = mockRes();
    await controller.saveQuery(
      req({ body: { name: 'Long', params: 'a'.repeat(2000) } }), res);

    assert.strictEqual(res.statusCode, 200);
  });

  await t.test('the 51st query is refused, but re-saving an existing one is not', async () => {
    let stored = false;
    t.mock.method(userdata, 'countByType', async (userId, type) => (type === 'query' ? 50 : 0));
    t.mock.method(userdata, 'put', async (userId, item) => { stored = true; return item; });

    t.mock.method(userdata, 'getItem', async () => null);
    const fresh = mockRes();
    await controller.saveQuery(req({ body: { name: 'One more', params: PARAMS } }), fresh);
    assert.strictEqual(fresh.statusCode, 400);
    assert.match(fresh.body.error, /50/);
    assert.strictEqual(stored, false);

    t.mock.method(userdata, 'getItem', async () => ({ id: 'query:one-more' }));
    const again = mockRes();
    await controller.saveQuery(req({ body: { name: 'One more', params: PARAMS } }), again);
    assert.strictEqual(again.statusCode, 200, 'the cap counts new ids only');
    assert.strictEqual(stored, true);
  });

  await t.test('the query cap counts queries, not lassos', async () => {
    // One container holds both types, so a cap that counted rows would refuse a first query to a
    // user who had merely drawn 50 areas.
    let countedType;
    t.mock.method(userdata, 'getItem', async () => null);
    t.mock.method(userdata, 'countByType', async (userId, type) => { countedType = type; return 0; });
    t.mock.method(userdata, 'put', async (userId, item) => item);

    await controller.saveQuery(req({ body: { name: 'First', params: PARAMS } }), mockRes());

    assert.strictEqual(countedType, 'query');
  });

  await t.test('a delete of a query the user does not have is 404', async () => {
    t.mock.method(userdata, 'remove', async () => false);

    const res = mockRes();
    await controller.deleteQuery(req({ params: { slug: 'nosuch' } }), res);

    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(res.body, { error: 'Saved query not found' });
  });

  await t.test('a query delete that lands answers a message and targets the query: id', async () => {
    let removedOwner, removed;
    t.mock.method(userdata, 'remove', async (userId, id) => { removedOwner = userId; removed = id; return true; });

    const res = mockRes();
    await controller.deleteQuery(req({ params: { slug: 'Wildlife-Docs' } }), res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(removedOwner, ME);
    assert.strictEqual(removed, 'query:wildlife-docs');
    assert.deepStrictEqual(res.body, { message: 'Saved query deleted' });
  });

  await t.test('a malformed query slug is a 404 that never reaches a delete', async () => {
    let called = false;
    t.mock.method(userdata, 'remove', async () => { called = true; return true; });

    const res = mockRes();
    await controller.deleteQuery(req({ params: { slug: 'a/b' } }), res);

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(called, false);
  });

  await t.test('preferences are stored as one row keyed prefs', async () => {
    let owner, record;
    t.mock.method(userdata, 'put', async (userId, item) => { owner = userId; record = item; return item; });

    const res = mockRes();
    await controller.putPrefs(req({ body: { landing: 'search', perPage: 12 } }), res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(owner, ME);
    assert.strictEqual(record.id, 'prefs');
    assert.strictEqual(record.type, 'prefs');
    assert.deepStrictEqual(res.body, { landing: 'search', perPage: 12 });
  });

  await t.test('an unknown screen, an unoffered page size or a stray key is a 400', async () => {
    let stored = false;
    t.mock.method(userdata, 'put', async () => { stored = true; return {}; });

    const bodies = [
      { landing: 'nope', perPage: 6 },
      { landing: 'index', perPage: 6 },
      { landing: 'MAP', perPage: 6 },
      { landing: 6, perPage: 6 },
      { perPage: 6 },
      { landing: 'map' },
      { landing: 'map', perPage: 7 },
      { landing: 'map', perPage: '6' },
      { landing: 'map', perPage: 6, theme: 'dark' }
    ];

    for (const body of bodies) {
      const res = mockRes();
      await controller.putPrefs(req({ body }), res);
      assert.strictEqual(res.statusCode, 400, JSON.stringify(body));
    }
    assert.strictEqual(stored, false);
  });

  await t.test('a delete of an area the user does not have is 404', async () => {
    t.mock.method(userdata, 'remove', async () => false);

    const res = mockRes();
    await controller.deleteLasso(req({ params: { slug: 'nosuch' } }), res);

    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(res.body, { error: 'Saved area not found' });
  });

  await t.test('a delete that lands answers a message and targets the lasso: id', async () => {
    let removed;
    t.mock.method(userdata, 'remove', async (userId, id) => { removed = id; return true; });

    const res = mockRes();
    await controller.deleteLasso(req({ params: { slug: 'Mine' } }), res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(removed, 'lasso:mine');
  });

  await t.test('a malformed slug is a 404 that never reaches a delete', async () => {
    let called = false;
    t.mock.method(userdata, 'remove', async () => { called = true; return true; });

    const res = mockRes();
    await controller.deleteLasso(req({ params: { slug: 'a/b' } }), res);

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(called, false);
  });

  await t.test('an unconfigured container is a 500 that echoes no driver detail', async () => {
    t.mock.method(userdata, 'getItem', async () => null);
    t.mock.method(userdata, 'countByType', async () => 0);
    t.mock.method(userdata, 'put', async () => { throw new Error('userdata container not configured'); });

    const res = mockRes();
    await controller.saveLasso(req({ body: { name: 'Mine', ring: ring() } }), res);

    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(res.body, { success: false, error: 'Internal server error.' });
  });
});
