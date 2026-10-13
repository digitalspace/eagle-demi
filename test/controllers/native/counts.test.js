'use strict';

// `GET /counts`: each kind counted through its own list spec, so a count refuses what the list
// refuses and reads under the same visibility predicate.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const querystring = require('node:querystring');

const cosmos = require('../../../src/db/cosmos-nosql');
const aiSearch = require('../../../src/search/ai-search');
const { makeRes } = require('../../../src/http/router');
const { cosmosKind } = require('../../../src/helpers/native-query');
const { counts, KINDS } = require('../../../src/controllers/native/counts');

const STAFF = { realm_access: { roles: ['staff'] } };

// Comment `author` is level 2: staff may filter on it, an anonymous caller may not.
const COMMENTS_PROBE = {
  entity: 'comments',
  repository: cosmosKind({ container: 'comments', entity: 'comments', partitionField: 'projectId', defaultOrder: 'c.id ASC' }),
  filters: ['author']
};

/** COUNT answers 7; every query spec is recorded. */
function fakeCosmos(t) {
  const specs = [];
  t.mock.method(cosmos, 'query', async (container, spec) => {
    specs.push({ container, ...spec });
    return { items: [7] };
  });
  return specs;
}

function withProbeKind(t) {
  KINDS.commentsProbe = () => COMMENTS_PROBE;
  t.after(() => { delete KINDS.commentsProbe; });
}

async function call(qs, user) {
  const req = { query: querystring.parse(qs), params: {}, headers: {}, header: () => undefined, user };
  const res = makeRes('test');
  await counts(req, res);
  return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : undefined };
}

test('GET /counts', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('an anonymous count filtered on a hidden field is refused before any read', async (t) => {
    const specs = fakeCosmos(t);
    withProbeKind(t);

    const res = await call('kind=commentsProbe&author=Jane');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /cannot filter on a field this caller cannot see: author/);
    assert.strictEqual(specs.length, 0);
  });

  await t.test('staff count the same filter, with the value bound and no-store set', async (t) => {
    const specs = fakeCosmos(t);
    withProbeKind(t);

    const res = await call('kind=commentsProbe&author=Jane', STAFF);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { commentsProbe: 7 });
    assert.strictEqual(res.headers['cache-control'], 'private, no-store');
    assert.ok(specs[0].parameters.some(p => p.value === 'Jane'));
  });

  await t.test('a projects count reads the projects container under the caller predicate', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call('kind=projects&projectState=Active');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { projects: 7 });
    assert.strictEqual(specs[0].container, 'projects');
    assert.match(specs[0].query, /COUNT\(1\)/);
  });

  await t.test('a keyword count asks the index, as the keyword list does', async (t) => {
    fakeCosmos(t);
    let asked;
    t.mock.method(aiSearch, 'searchProjects', async (opts) => { asked = opts; return { count: 0, items: [] }; });
    const res = await call('kind=projects&q=mine');
    assert.deepStrictEqual(res.body, { projects: 0 });
    assert.strictEqual(asked.keywords, 'mine');
  });

  await t.test('an unknown kind, a repeated kind and a paging parameter are each refused', async (t) => {
    const specs = fakeCosmos(t);
    assert.strictEqual((await call('kind=nope')).status, 400);
    assert.strictEqual((await call('kind=projects&kind=projects')).status, 400);
    assert.strictEqual((await call('kind=projects&page=2')).status, 400);
    assert.strictEqual(specs.length, 0);
  });
});
