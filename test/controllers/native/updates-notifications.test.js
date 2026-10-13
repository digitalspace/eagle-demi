'use strict';

// Native update and notification reads, driven through the real handlers and repositories over a
// fake Cosmos that applies the role arm, equality, IN, `<=`, pinned, parent gate and ORDER BY
// clauses of each query, so what a caller may see is observed in the response. The indexes are faked at
// `searchActivities`/`searchNotifications`, so the OData filter they are asked with is observed too.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const querystring = require('node:querystring');

// First: the logger's uncaughtException handler would swallow a load failure here into a green run.
const updatesController = require('../../../src/controllers/native/updates');
const notificationsController = require('../../../src/controllers/native/notifications');
const cosmos = require('../../../src/db/cosmos-nosql');
const aiSearch = require('../../../src/search/ai-search');
const audit = require('../../../src/utils/audit');
const updates = require('../../../src/repositories/updates');
const { filterFor } = require('../../../src/helpers/access-odata');
const { resolveAccess } = require('../../../src/helpers/access-sql');
const { makeRes } = require('../../../src/http/router');
const { recordEvents } = require('../../helpers/record-events');

const STAFF = { realm_access: { roles: ['staff'] } };
const ANON = resolveAccess({ query: {}, headers: {}, header: () => undefined });

const PROJECT_EAGLE_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const HIDDEN_EAGLE_ID = 'cccccccccccccccccccccccc';
// An API key scoped to both projects by their Track ids, which the updates container does not hold.
const SCOPED = { projectScope: ['p1', 'p2'] };

const CONTAINERS = {
  // Live: u1 and u4. u2 is a draft and u3 is scheduled for later; only staff and narrower see them.
  // u5 is live and public itself, but its parent project p2 is staff-only, so it is hidden below staff.
  updates: [
    { id: 'u1', projectId: PROJECT_EAGLE_ID, type: 'News', headline: 'Bridge opens', read: ['public'], status: 'published', publishDate: '2026-01-02T00:00:00.000Z', dateAdded: '2026-01-02T00:00:00.000Z' },
    { id: 'u2', projectId: PROJECT_EAGLE_ID, type: 'News', headline: 'Draft', read: ['public'], status: 'draft', publishDate: '2026-01-03T00:00:00.000Z', dateAdded: '2026-01-03T00:00:00.000Z' },
    { id: 'u3', type: 'News', headline: 'Scheduled', read: ['public'], status: 'published', publishDate: '2999-01-01T00:00:00.000Z', dateAdded: '2026-01-01T00:00:00.000Z' },
    { id: 'u4', type: 'Notice', headline: 'Pinned notice', pinned: true, read: ['public'], status: 'published', publishDate: '2025-12-01T00:00:00.000Z', dateAdded: '2025-12-01T00:00:00.000Z' },
    { id: 'u5', projectId: HIDDEN_EAGLE_ID, type: 'News', headline: 'Quarry approved', read: ['public'], status: 'published', publishDate: '2026-01-04T00:00:00.000Z', dateAdded: '2026-01-04T00:00:00.000Z' }
  ],
  notifications: [
    { id: 'n1', name: 'Pipeline notice', type: 'Industrial', region: 'Peace', read: ['public'], notificationReceivedDate: '2026-02-01T00:00:00.000Z' },
    { id: 'n2', name: 'Mine notice', type: 'Mines', region: 'Skeena', read: ['public'], notificationReceivedDate: '2026-03-01T00:00:00.000Z' },
    { id: 'n-staff', name: 'Unreleased notice', type: 'Mines', read: ['staff'], notificationReceivedDate: '2026-04-01T00:00:00.000Z' }
  ],
  projects: [
    { id: 'p1', eagleId: PROJECT_EAGLE_ID, name: 'Site C', read: ['public'] },
    { id: 'p2', eagleId: HIDDEN_EAGLE_ID, name: 'Unreleased quarry', read: ['staff'] }
  ]
};

function param(spec, name) {
  const found = spec.parameters.find(p => p.name === name);
  return found && found.value;
}

/** Rows of `container` the query admits. A query with no role arm (a system read) admits every role. */
function admitted(container, spec) {
  const roles = spec.parameters.filter(p => p.name.startsWith('@role')).map(p => p.value);
  const tests = [];
  for (const [, field, name] of spec.query.matchAll(/c\.(\w+) = (@\w+)/g)) {
    tests.push(row => row[field] === param(spec, name));
  }
  for (const [, field, name] of spec.query.matchAll(/c\.(\w+) <= (@\w+)/g)) {
    tests.push(row => row[field] <= param(spec, name));
  }
  for (const [, field, names] of spec.query.matchAll(/c\.(\w+) IN \(([@\w, ]+)\)/g)) {
    const values = names.split(', ').map(name => param(spec, name));
    tests.push(row => values.includes(row[field]));
  }
  if (spec.query.includes('c.pinned = true')) tests.push(row => row.pinned === true);
  if (spec.query.includes('c.pinned = false')) tests.push(row => row.pinned !== true);
  if (spec.query.includes('NOT ARRAY_CONTAINS(@hiddenParents, c.projectId)')) {
    tests.push(row => !row.projectId || !param(spec, '@hiddenParents').includes(row.projectId));
  }

  const rows = CONTAINERS[container]
    .filter(row => roles.length === 0 || row.read.some(r => roles.includes(r)))
    .filter(row => tests.every(match => match(row)));
  const order = spec.query.match(/ORDER BY c\.(\w+) (ASC|DESC)/);
  if (!order) return rows;
  const [, field, dir] = order;
  return rows.sort((a, b) => String(a[field]).localeCompare(String(b[field])) * (dir === 'DESC' ? -1 : 1));
}

function fakeStores(t, { ranked = [] } = {}) {
  updates.forgetParents();
  const searches = [];
  t.mock.method(cosmos, 'query', async (container, spec, opts = {}) => {
    const rows = admitted(container, spec);
    if (spec.query.includes('COUNT(1)')) return { items: [rows.length] };
    return { items: structuredClone(rows.slice(0, opts.maxItemCount || rows.length)) };
  });
  t.mock.method(cosmos, 'queryFirst', async (container, spec) => structuredClone(admitted(container, spec)[0] || null));
  t.mock.method(cosmos, 'readItem', async (container, id) =>
    structuredClone(CONTAINERS[container].find(row => row.id === id) || null));
  const index = async (opts) => {
    searches.push(opts);
    return { count: ranked.length, items: ranked.map(id => ({ id })) };
  };
  t.mock.method(aiSearch, 'searchActivities', index);
  t.mock.method(aiSearch, 'searchNotifications', index);
  return { searches };
}

async function call(handler, qs, { user, id } = {}) {
  const req = { query: querystring.parse(qs), params: { id }, headers: {}, header: () => undefined, user };
  const res = makeRes('test');
  await handler(req, res);
  return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : undefined };
}

const ids = body => body.map(row => row.id);

test('native updates list', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const list = updatesController.getUpdates;

  await t.test('anonymous sees only live rows; staff sees drafts and scheduled rows too', async (t) => {
    fakeStores(t);
    assert.deepStrictEqual(ids((await call(list, '')).body).sort(), ['u1', 'u4']);
    assert.deepStrictEqual(ids((await call(list, '', { user: STAFF })).body).sort(), ['u1', 'u2', 'u3', 'u4', 'u5']);
  });

  await t.test('count=true counts the live rows only', async (t) => {
    fakeStores(t);
    const res = await call(list, 'count=true');
    assert.strictEqual(res.headers['x-total-count'], '2');
  });

  await t.test('page and pageSize page the sorted list', async (t) => {
    fakeStores(t);
    const res = await call(list, 'sort=dateAdded&pageSize=2&page=2', { user: STAFF });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(ids(res.body), ['u1', 'u2']);
  });

  await t.test('a sort key off the allow-list is refused', async (t) => {
    fakeStores(t);
    assert.strictEqual((await call(list, 'sort=headline')).status, 400);
  });

  await t.test('project= filters projectId and joins the project name', async (t) => {
    fakeStores(t);
    const res = await call(list, `project=${PROJECT_EAGLE_ID}`);
    assert.deepStrictEqual(ids(res.body), ['u1']);
    assert.strictEqual(res.body[0].projectName, 'Site C');
    assert.strictEqual(res.body[0].projectEagleId, PROJECT_EAGLE_ID);
  });

  await t.test('type takes several values', async (t) => {
    fakeStores(t);
    const res = await call(list, 'type=News&type=Notice');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(ids(res.body).sort(), ['u1', 'u4']);
  });

  await t.test('unknown, Eagle-shaped and repeated control parameters are refused', async (t) => {
    fakeStores(t);
    assert.match((await call(list, 'dataset=RecentActivity')).body.error, /unknown parameter: dataset/);
    assert.match((await call(list, 'projectId=x')).body.error, /unknown parameter: projectId/);
    assert.match((await call(list, 'page=1&page=2')).body.error, /more than once: page/);
  });

  await t.test('q asks the activities index under the anonymous ACL and publish gate', async (t) => {
    const { searches } = fakeStores(t, { ranked: ['u4', 'u2', 'u1'] });
    const res = await call(list, 'q=bridge');
    assert.strictEqual(res.status, 200);
    // The index ranked a draft; the Cosmos read-back drops it and keeps the index's order.
    assert.deepStrictEqual(ids(res.body), ['u4', 'u1']);
    assert.strictEqual(searches[0].keywords, 'bridge');
    assert.ok(searches[0].filter.includes(filterFor(ANON, 'projectId').filter), searches[0].filter);
    assert.match(searches[0].filter, /status eq 'published' and publishDate le /);
  });

  await t.test('q logs one search event for the updates kind', async (t) => {
    fakeStores(t, { ranked: ['u1'] });
    const events = recordEvents(t);
    await call(list, 'q=bridge');
    const [search] = await events(audit.EVENTS_STREAM);
    assert.strictEqual(search.EventName, 'search');
    assert.strictEqual(search.Detail.kind, 'updates');
  });
});

test('native updates under a parent the caller cannot read', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const list = updatesController.getUpdates;
  const get = updatesController.getUpdate;

  await t.test('anonymous: the list leaves the row out', async (t) => {
    fakeStores(t);
    assert.deepStrictEqual(ids((await call(list, '')).body).sort(), ['u1', 'u4']);
  });

  await t.test('anonymous: count=true does not count it', async (t) => {
    fakeStores(t);
    assert.strictEqual((await call(list, 'count=true')).headers['x-total-count'], '2');
  });

  await t.test('anonymous: the q read-back drops it though the index ranked it', async (t) => {
    fakeStores(t, { ranked: ['u5', 'u1'] });
    assert.deepStrictEqual(ids((await call(list, 'q=quarry')).body), ['u1']);
  });

  await t.test('anonymous: by id it is a 404', async (t) => {
    fakeStores(t);
    assert.strictEqual((await call(get, '', { id: 'u5' })).status, 404);
  });

  // The Track ids must become Eagle ids to match projectId at all; the parent gate then drops u5.
  await t.test('scoped: the list holds its readable project\'s row only', async (t) => {
    fakeStores(t);
    assert.deepStrictEqual(ids((await call(list, '', { user: SCOPED })).body), ['u1']);
  });

  await t.test('scoped: count=true counts that row only', async (t) => {
    fakeStores(t);
    assert.strictEqual((await call(list, 'count=true', { user: SCOPED })).headers['x-total-count'], '1');
  });

  await t.test('scoped: the q read-back drops it though the index ranked it', async (t) => {
    fakeStores(t, { ranked: ['u5', 'u1'] });
    assert.deepStrictEqual(ids((await call(list, 'q=quarry', { user: SCOPED })).body), ['u1']);
  });

  await t.test('scoped: by id it is a 404, while its readable project\'s row reads', async (t) => {
    fakeStores(t);
    assert.strictEqual((await call(get, '', { id: 'u5', user: SCOPED })).status, 404);
    assert.strictEqual((await call(get, '', { id: 'u1', user: SCOPED })).status, 200);
  });

  await t.test('staff reads the parent, so the row too', async (t) => {
    fakeStores(t);
    assert.strictEqual((await call(get, '', { id: 'u5', user: STAFF })).status, 200);
  });
});

test('native update by id', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const get = updatesController.getUpdate;

  await t.test('a live update is read by its id', async (t) => {
    fakeStores(t);
    const res = await call(get, '', { id: 'u1' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.headline, 'Bridge opens');
  });

  await t.test('a draft is a 404 for anonymous and readable by staff', async (t) => {
    fakeStores(t);
    assert.strictEqual((await call(get, '', { id: 'u2' })).status, 404);
    assert.strictEqual((await call(get, '', { id: 'u2', user: STAFF })).status, 200);
  });

  await t.test('an unknown id is a 404', async (t) => {
    fakeStores(t);
    const res = await call(get, '', { id: 'missing' });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.error, 'Update not found');
  });
});

test('native updates feed', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const feed = updatesController.getFeed;

  await t.test('pinned rows lead, then live rows; anonymous gets no draft', async (t) => {
    fakeStores(t);
    const res = await call(feed, '');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(ids(res.body), ['u4', 'u1']);
    assert.strictEqual(res.body[1].projectName, 'Site C');
  });

  await t.test('limit caps the rows', async (t) => {
    fakeStores(t);
    assert.deepStrictEqual(ids((await call(feed, 'limit=1')).body), ['u4']);
  });

  await t.test('type narrows the top-up, never the pinned rows', async (t) => {
    fakeStores(t);
    assert.deepStrictEqual(ids((await call(feed, 'type=Notice')).body), ['u4']);
  });

  await t.test(`limit past ${updatesController.FEED_MAX_ROWS} or given twice is refused`, async (t) => {
    fakeStores(t);
    assert.strictEqual((await call(feed, `limit=${updatesController.FEED_MAX_ROWS}`)).status, 200);
    assert.strictEqual((await call(feed, `limit=${updatesController.FEED_MAX_ROWS + 1}`)).status, 400);
    assert.strictEqual((await call(feed, 'limit=4&limit=5')).status, 400);
  });

  await t.test('an unknown parameter is refused', async (t) => {
    fakeStores(t);
    assert.match((await call(feed, 'pageSize=4')).body.error, /unknown parameter: pageSize/);
  });
});

test('native notifications', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const list = notificationsController.getNotifications;
  const get = notificationsController.getNotification;

  await t.test('anonymous lists public rows only; staff sees its own too', async (t) => {
    fakeStores(t);
    assert.deepStrictEqual(ids((await call(list, '')).body).sort(), ['n1', 'n2']);
    assert.strictEqual((await call(list, '', { user: STAFF })).body.length, 3);
  });

  await t.test('the default order is newest received first; sort=name orders by name', async (t) => {
    fakeStores(t);
    assert.deepStrictEqual(ids((await call(list, '')).body), ['n2', 'n1']);
    assert.deepStrictEqual(ids((await call(list, 'sort=name&count=true')).body), ['n2', 'n1']);
    assert.deepStrictEqual(ids((await call(list, 'sort=-name')).body), ['n1', 'n2']);
  });

  await t.test('type filters, and count=true counts the filtered rows', async (t) => {
    fakeStores(t);
    const res = await call(list, 'type=Mines&count=true');
    assert.deepStrictEqual(ids(res.body), ['n2']);
    assert.strictEqual(res.headers['x-total-count'], '1');
  });

  await t.test('project= is refused: a notification has no projectId', async (t) => {
    fakeStores(t);
    assert.match((await call(list, 'project=p1')).body.error, /unknown parameter: project/);
  });

  await t.test('q asks the notifications index under the role ACL alone', async (t) => {
    const { searches } = fakeStores(t, { ranked: ['n-staff', 'n1'] });
    const res = await call(list, 'q=notice');
    assert.deepStrictEqual(ids(res.body), ['n1']);
    assert.strictEqual(searches[0].filter, `(${filterFor(ANON, null).filter})`);
  });

  await t.test('by id: a public row reads, a staff row is a 404 for anonymous', async (t) => {
    fakeStores(t);
    assert.strictEqual((await call(get, '', { id: 'n1' })).body.name, 'Pipeline notice');
    assert.strictEqual((await call(get, '', { id: 'n-staff' })).status, 404);
    assert.strictEqual((await call(get, '', { id: 'n-staff', user: STAFF })).status, 200);
  });
});
