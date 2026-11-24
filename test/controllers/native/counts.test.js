'use strict';

// `GET /counts`: each kind counted through its own list spec, so a count refuses what the list
// refuses and reads under the same visibility predicate.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const querystring = require('node:querystring');

const { counts, KINDS, resetCountsCache } = require('../../../src/controllers/native/counts');
const cosmos = require('../../../src/db/cosmos-nosql');
const aiSearch = require('../../../src/search/ai-search');
const { makeRes } = require('../../../src/http/router');
const { cosmosKind } = require('../../../src/helpers/native-query');
const { filterFor } = require('../../../src/helpers/access-odata');
const { resolveAccess } = require('../../../src/helpers/access-sql');

const STAFF = { realm_access: { roles: ['staff'] } };
const ANON = resolveAccess({ query: {}, headers: {}, header: () => undefined });

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

/** Each COUNT answers one more than the last, so a cached answer shows as a repeated number. */
function countingCosmos(t) {
  let reads = 0;
  t.mock.method(cosmos, 'query', async () => ({ items: [++reads] }));
  return () => reads;
}

test('GET /counts', async (t) => {
  t.beforeEach(() => resetCountsCache());
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

  await t.test('a projects count on a project type matches both stored spellings', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call('kind=projects&projectType=Tourist%20Destination%20Resorts');
    assert.strictEqual(res.status, 200);
    assert.match(specs[0].query, /c\.projectType IN \(@nf0_0, @nf0_1\)/);
    assert.deepStrictEqual(specs[0].parameters.filter(p => p.name.startsWith('@nf0_')).map(p => p.value),
      ['Tourist Destination Resorts', 'Tourist Destination Resort']);
  });

  await t.test('a keyword count asks the index, as the keyword list does', async (t) => {
    fakeCosmos(t);
    let asked;
    t.mock.method(aiSearch, 'searchProjects', async (opts) => { asked = opts; return { count: 0, items: [] }; });
    const res = await call('kind=projects&q=mine');
    assert.deepStrictEqual(res.body, { projects: 0 });
    assert.strictEqual(asked.keywords, 'mine');
  });

  await t.test('a search-service 400 on a keyword count answers a fixed message', async (t) => {
    fakeCosmos(t);
    t.mock.method(aiSearch, 'searchProjects', async () => {
      throw Object.assign(new Error("HTTP 400 Invalid expression: search.in(acl, 'public', ',')"),
        { status: 400, searchService: true });
    });
    const res = await call('kind=projects&q=mine');
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(res.body, { error: 'The search service could not run this query.' });
  });

  await t.test('updates and notifications count when named, each index asked under the anonymous ACL', async (t) => {
    t.mock.method(cosmos, 'query', async (container, spec) => ({ items: spec.query.includes('COUNT(1)') ? [7] : [] }));
    const asked = {};
    const none = name => async (opts) => { asked[name] = opts; return { count: 0, items: [] }; };
    t.mock.method(aiSearch, 'searchActivities', none('updates'));
    t.mock.method(aiSearch, 'searchNotifications', none('notifications'));

    const res = await call('kind=updates,notifications&q=x');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { updates: 0, notifications: 0 });
    assert.ok(asked.updates.filter.includes(filterFor(ANON, 'projectId').filter), asked.updates.filter);
    assert.match(asked.updates.filter, /status eq 'published' and publishDate le /);
    assert.strictEqual(asked.notifications.filter, `(${filterFor(ANON, null).filter})`);
  });

  await t.test('no kind counts exactly projects and documents, and still refuses a project filter', async (t) => {
    const specs = fakeCosmos(t);
    t.mock.method(aiSearch, 'searchProjects', async () => ({ count: 0, items: [] }));
    t.mock.method(aiSearch, 'searchDocumentIds', async () => ({ count: 0, ids: [] }));
    const res = await call('q=x');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(Object.keys(res.body).sort(), ['documents', 'projects']);

    specs.length = 0;
    const scoped = await call('project=p1');
    assert.strictEqual(scoped.status, 400);
    assert.match(scoped.body.error, /^projects: unknown parameter: project/);
    assert.strictEqual(specs.length, 0);
  });

  await t.test('an unknown kind, a repeated kind and a paging parameter are each refused', async (t) => {
    const specs = fakeCosmos(t);
    assert.strictEqual((await call('kind=nope')).status, 400);
    assert.strictEqual((await call('kind=projects&kind=projects')).status, 400);
    assert.strictEqual((await call('kind=projects&page=2')).status, 400);
    assert.strictEqual(specs.length, 0);
  });
});

test('the /counts cache', async (t) => {
  t.beforeEach(() => resetCountsCache());
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a repeat inside 45 s is answered without a read', async (t) => {
    const reads = countingCosmos(t);
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });

    const first = await call('kind=projects&projectState=Active');
    t.mock.timers.tick(44 * 1000);
    const second = await call('kind=projects&projectState=Active');

    assert.strictEqual(reads(), 1);
    assert.deepStrictEqual(second.body, first.body);
  });

  await t.test('a repeat after 45 s reads again', async (t) => {
    const reads = countingCosmos(t);
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });

    await call('kind=projects&projectState=Active');
    t.mock.timers.tick(46 * 1000);
    const second = await call('kind=projects&projectState=Active');

    assert.strictEqual(reads(), 2);
    assert.deepStrictEqual(second.body, { projects: 2 });
  });

  // Counts are access-scoped: a shared entry would publish one caller's totals to another.
  await t.test('two callers with different access never share an entry', async (t) => {
    countingCosmos(t);

    const anonymous = await call('kind=projects&projectState=Active');
    const staff = await call('kind=projects&projectState=Active', STAFF);

    assert.deepStrictEqual(anonymous.body, { projects: 1 });
    assert.deepStrictEqual(staff.body, { projects: 2 });
  });

  await t.test('a different filter value is a different entry', async (t) => {
    countingCosmos(t);

    await call('kind=projects&projectState=Active');
    const other = await call('kind=projects&projectState=Complete');

    assert.deepStrictEqual(other.body, { projects: 2 });
  });

  await t.test('a failed read is not served to the next call', async (t) => {
    fakeCosmos(t);
    const failing = t.mock.method(aiSearch, 'searchProjects', async () => {
      throw Object.assign(new Error('HTTP 400 Invalid expression'), { status: 400, searchService: true });
    });

    const refused = await call('kind=projects&q=mine');
    failing.mock.mockImplementation(async () => ({ count: 0, items: [] }));
    const answered = await call('kind=projects&q=mine');

    assert.strictEqual(refused.status, 400);
    assert.strictEqual(answered.status, 200);
    assert.strictEqual(failing.mock.callCount(), 2, 'the second call asked the index again');
  });
});
