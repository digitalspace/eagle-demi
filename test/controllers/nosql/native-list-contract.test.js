'use strict';

// The native list contract every `/api/<kind>` read is built from (helpers/native-query.js through
// mirror-reads.js). Driven through the real handler, the real `cosmosKind` repository and a fake
// Cosmos that serves a fixed container, so paging, counting and redaction are observed in the
// response rather than in calls.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const querystring = require('node:querystring');

// First: the logger's uncaughtException handler would swallow a load failure here into a green run.
const { cosmosKind, MAX_IDS, ANON_MAX_PAGE_DEPTH } = require('../../../src/helpers/native-query');
const cosmos = require('../../../src/db/cosmos-nosql');
const { makeRes } = require('../../../src/http/router');
const { listHandler, getHandler } = require('../../../src/controllers/nosql/mirror-reads');

const STAFF = { realm_access: { roles: ['staff'] } };

// `author` is level 2 unless the comment is attributed; `eaoNotes` is level 2 always; c3 dials its
// own `comment` down to level 2.
const ROWS = Array.from({ length: 6 }, (_, i) => ({
  id: `c${i + 1}`,
  projectId: 'p1',
  read: ['public'],
  comment: `comment ${i + 1}`,
  author: `Author ${i + 1}`,
  isAnonymous: true,
  eaoNotes: 'staff only',
  ...(i === 2 ? { vis: { comment: 2 } } : {})
}));

const SPEC = {
  entity: 'comments',
  repository: cosmosKind({ container: 'comments', entity: 'comments', partitionField: 'projectId', defaultOrder: 'c.id ASC' }),
  sortKeys: ['dateAdded', 'author'],
  filters: ['eaoStatus', 'author'],
  multiValueFilters: ['eaoStatus'],
  qFields: ['comment'],
  notFound: 'Comment not found'
};

const list = listHandler(SPEC);
const get = getHandler(SPEC);

/** Fake Cosmos: COUNT answers 7, an `@id` read answers that row, a list read pages ROWS by size. */
function fakeCosmos(t) {
  const specs = [];
  t.mock.method(cosmos, 'query', async (container, spec, options = {}) => {
    specs.push(spec);
    if (spec.query.includes('COUNT(1)')) return { items: [7] };
    const id = spec.parameters.find(p => p.name === '@id');
    if (id) return { items: ROWS.filter(row => row.id === id.value) };
    return { items: ROWS.slice(0, options.maxItemCount) };
  });
  return specs;
}

async function call(handler, qs, { user, id } = {}) {
  const req = { query: querystring.parse(qs), params: { id }, headers: {}, header: () => undefined, user };
  const res = makeRes('test');
  await handler(req, res);
  return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : undefined };
}

test('native list contract', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('an unknown parameter is refused before any read', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call(list, 'continuationToken=abc');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /unknown parameter: continuationToken/);
    assert.strictEqual(specs.length, 0);
  });

  await t.test('a repeated control parameter is refused', async (t) => {
    fakeCosmos(t);
    const res = await call(list, 'page=1&page=2');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /more than once: page/);
  });

  await t.test('a repeated single-value filter is refused, a declared multi-value one is not', async (t) => {
    fakeCosmos(t);
    assert.strictEqual((await call(list, 'author=a&author=b', { user: STAFF })).status, 400);
    assert.strictEqual((await call(list, 'eaoStatus=Pending&eaoStatus=Published')).status, 200);
  });

  await t.test('page is 1-based: page=1 is the first rows, page=2 the next', async (t) => {
    fakeCosmos(t);
    const first = await call(list, 'page=1&pageSize=2');
    const second = await call(list, 'page=2&pageSize=2');
    assert.deepStrictEqual(first.body.map(r => r.id), ['c1', 'c2']);
    assert.deepStrictEqual(second.body.map(r => r.id), ['c3', 'c4']);
  });

  await t.test('page=0 is refused', async (t) => {
    fakeCosmos(t);
    assert.strictEqual((await call(list, 'page=0')).status, 400);
  });

  await t.test('count=true sets a measured x-total-count', async (t) => {
    fakeCosmos(t);
    const res = await call(list, 'count=true');
    assert.strictEqual(res.headers['x-total-count'], '7');
  });

  await t.test('no count, no total header', async (t) => {
    fakeCosmos(t);
    const res = await call(list, '');
    assert.strictEqual(res.headers['x-total-count'], undefined);
  });

  await t.test('a sort key off the allow-list is refused', async (t) => {
    fakeCosmos(t);
    const res = await call(list, 'sort=comment');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /cannot sort on/);
  });

  await t.test('only one sort key is taken', async (t) => {
    fakeCosmos(t);
    assert.strictEqual((await call(list, 'sort=dateAdded,-author', { user: STAFF })).status, 400);
  });

  await t.test(`ids above ${MAX_IDS} are refused`, async (t) => {
    fakeCosmos(t);
    const ids = Array.from({ length: MAX_IDS + 1 }, (_, i) => `id${i}`).join(',');
    const res = await call(list, `ids=${ids}`);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /at most 100/);
  });

  await t.test(`ids at ${MAX_IDS} are read`, async (t) => {
    fakeCosmos(t);
    const ids = Array.from({ length: MAX_IDS }, (_, i) => `id${i}`).join(',');
    assert.strictEqual((await call(list, `ids=${ids}`)).status, 200);
  });

  await t.test('a filter on a level-2 field is refused for an anonymous caller', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call(list, 'author=Jane&count=true');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /cannot filter on a field this caller cannot see: author/);
    assert.strictEqual(specs.length, 0);
  });

  await t.test('staff may filter on it, and the count skips records whose own dial hides it', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call(list, 'author=Jane&count=true', { user: STAFF });
    assert.strictEqual(res.status, 200);
    const count = specs.find(spec => spec.query.includes('COUNT(1)'));
    assert.ok(count.query.includes('(NOT IS_DEFINED(c.vis["author"]) OR c.vis["author"] >= 2)'), count.query);
  });

  await t.test('q carries the same per-record dial for an anonymous caller', async (t) => {
    const specs = fakeCosmos(t);
    await call(list, 'q=road&count=true');
    const count = specs.find(spec => spec.query.includes('COUNT(1)'));
    assert.ok(count.query.includes('c.vis["comment"] >= 4'), count.query);
  });

  await t.test(`an anonymous caller cannot page past ${ANON_MAX_PAGE_DEPTH} rows`, async (t) => {
    fakeCosmos(t);
    const res = await call(list, 'page=21&pageSize=100');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /within 2000 rows/);
  });

  await t.test('an authenticated caller can', async (t) => {
    fakeCosmos(t);
    assert.strictEqual((await call(list, 'page=21&pageSize=100', { user: STAFF })).status, 200);
  });

  await t.test('an authenticated list is never stored by a cache', async (t) => {
    fakeCosmos(t);
    const res = await call(list, '', { user: STAFF });
    assert.strictEqual(res.headers['cache-control'], 'private, no-store');
  });

  await t.test('an anonymous list carries no no-store', async (t) => {
    fakeCosmos(t);
    const res = await call(list, '');
    assert.strictEqual(res.headers['cache-control'], undefined);
  });

  await t.test('level-2 fields are absent from an anonymous list', async (t) => {
    fakeCosmos(t);
    const res = await call(list, '');
    assert.strictEqual(res.body[0].author, undefined);
    assert.strictEqual(res.body[0].eaoNotes, undefined);
    assert.strictEqual(res.body[0].comment, 'comment 1');
  });

  await t.test('a field a record dials to level 2 is absent when read anonymously by id', async (t) => {
    fakeCosmos(t);
    const res = await call(get, '', { id: 'c3' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.comment, undefined);
    assert.strictEqual(res.body.author, undefined);
  });

  await t.test('staff read the same record whole, uncached', async (t) => {
    fakeCosmos(t);
    const res = await call(get, '', { id: 'c3', user: STAFF });
    assert.strictEqual(res.body.comment, 'comment 3');
    assert.strictEqual(res.body.eaoNotes, 'staff only');
    assert.strictEqual(res.headers['cache-control'], 'private, no-store');
  });

  await t.test('a missing DEMI id and a missing Eagle id answer the same 404', async (t) => {
    fakeCosmos(t);
    const demi = await call(get, '', { id: 'nope' });
    const eagle = await call(get, '', { id: '5c1a2b3c4d5e6f7a8b9c0d1e' });
    assert.strictEqual(demi.status, 404);
    assert.deepStrictEqual(eagle.body, demi.body);
  });

  await t.test('a by-id read falls back to the Eagle id lookup for a 24-hex id', async (t) => {
    fakeCosmos(t);
    const byEagle = getHandler({
      ...SPEC,
      repository: { ...SPEC.repository, getByEagleId: async (_access, id) => ({ ...ROWS[0], eagleId: id }) }
    });
    const res = await call(byEagle, '', { id: '5c1a2b3c4d5e6f7a8b9c0d1e' });
    assert.strictEqual(res.body.id, 'c1');
  });
});
