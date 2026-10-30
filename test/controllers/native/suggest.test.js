'use strict';

// GET /suggest through the real kind specs and repositories, over a fake Cosmos that applies the
// role arm and the id lists, and fake indexes that record what they were asked.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const querystring = require('node:querystring');

// First: the logger's uncaughtException handler would swallow a load failure here into a green run.
const { getSuggestions } = require('../../../src/controllers/native/suggest');
const cosmos = require('../../../src/db/cosmos-nosql');
const aiSearch = require('../../../src/search/ai-search');
const audit = require('../../../src/utils/audit');
const updates = require('../../../src/repositories/updates');
const { makeRes, dispatch } = require('../../../src/http/router');
const { recordEvents } = require('../../helpers/record-events');
const { swaggerParams } = require('../../helpers/swagger-params');
const { logger } = require('../../../src/utils/logger');
const { HttpRequest } = require('@azure/functions');
const jwt = require('jsonwebtoken');
const config = require('../../../src/config');

const STAFF = { realm_access: { roles: ['staff'] } };
const EAGLE_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const VARY = 'Origin, Authorization, X-Api-Key';

const FIELDS = {
  projects: ['id', 'eagleId', 'name'],
  documents: ['id', 'displayName', 'projectId', 'projectEagleId', 'projectName'],
  updates: ['id', 'headline', 'projectId', 'projectEagleId', 'projectName', 'notificationName'],
  notifications: ['id', 'name', 'associatedProjectId'],
  'comment-periods': ['id', 'informationLabel', 'projectId', 'projectEagleId', 'projectName']
};

const sources = { eagle: { id: 'e1' } };
const CONTAINERS = {
  projects: [
    { id: 'p1', eagleId: EAGLE_ID, name: 'Site C', description: 'Dam', proponent: 'BC Hydro', region: 'Peace', read: ['public'], vis: {}, sources },
    { id: 'p2', eagleId: 'cccccccccccccccccccccccc', name: 'Site D', description: 'Mine', region: 'Skeena', read: ['public'], vis: {}, sources },
    // Public row, staff-only name: the redactor withholds the label below staff.
    { id: 'p-hidden-name', name: 'Site secret', description: 'Quarry', read: ['public'], vis: { name: 2 }, sources },
    // Older mirror rows carry an empty name rather than none.
    { id: 'p-blank', name: '', description: 'Gravel', read: ['public'], vis: {}, sources },
    { id: 'p-staff', name: 'Site staff', description: 'Pit', read: ['staff'], vis: {}, sources }
  ],
  documents: [
    { id: 'd1', projectId: 'p1', displayName: 'Site C report', documentFileName: 'a.pdf', read: ['public'], vis: {}, sources },
    { id: 'd2', projectId: 'p1', displayName: 'Site C letter', documentFileName: 'b.pdf', read: ['public'], vis: {}, sources },
    { id: 'd3', projectId: 'p1', displayName: 'Site C memo', documentFileName: 'c.pdf', read: ['public'], vis: {}, sources },
    { id: 'd4', projectId: 'p2', displayName: 'Site D report', documentFileName: 'd.pdf', read: ['public'], vis: {}, sources },
    { id: 'd-hidden', projectId: 'p1', displayName: 'Site C secret', documentFileName: 'e.pdf', read: ['public'], vis: { displayName: 2 }, sources },
    { id: 'd-blank', projectId: 'p1', displayName: '', documentFileName: 'f.pdf', read: ['public'], vis: {}, sources }
  ],
  updates: [
    { id: 'u1', projectId: EAGLE_ID, type: 'News', headline: 'Site C opens', notificationName: null, read: ['public'], vis: {}, status: 'published', publishDate: '2026-01-02T00:00:00.000Z', dateAdded: '2026-01-02T00:00:00.000Z', sources }
  ],
  notifications: [
    { id: 'n1', name: 'Site notice', associatedProjectId: 'p1', type: 'Mines', region: 'Peace', read: ['public'], vis: {}, sources }
  ],
  commentPeriods: [
    { id: 'cp1', projectId: 'p1', informationLabel: 'Site C early engagement', read: ['public'], vis: {}, sources },
    // Matched on the project name: no label of its own.
    { id: 'cp-blank', projectId: 'p2', informationLabel: '', read: ['public'], vis: {}, sources },
    { id: 'cp-hidden-label', projectId: 'p1', informationLabel: 'Site C secret round', read: ['public'], vis: { informationLabel: 2 }, sources },
    // No label, and the parent is staff only.
    { id: 'cp-orphan', projectId: 'p-staff', informationLabel: '', read: ['public'], vis: {}, sources }
  ]
};

const RANKED = {
  projects: ['p1', 'p2', 'p-hidden-name'],
  documents: ['d1'],
  updates: ['u1'],
  notifications: ['n1']
};

const values = (spec, prefix) => spec.parameters.filter(p => p.name.startsWith(prefix)).map(p => p.value);

/**
 * The role arm and the `@xid`/`@pid`/`@eid` id lists; every other clause is the real store's. The
 * project name lookup (`queryPage`) answers every project the role arm admits.
 */
function fakeStores(t, { fail, ranked = RANKED } = {}) {
  updates.forgetParents();
  const searches = [];
  const reads = [];
  const admitted = (container, spec) => {
    const roles = values(spec, '@role');
    return CONTAINERS[container].filter(row => roles.length === 0 || row.read.some(r => roles.includes(r)));
  };
  t.mock.method(cosmos, 'query', async (container, spec, options) => {
    const ids = [...values(spec, '@xid'), ...values(spec, '@pid')];
    reads.push({ container, ids, spec, maxItemCount: options && options.maxItemCount });
    const eagleIds = values(spec, '@eid');
    const rows = admitted(container, spec)
      .filter(row => ids.length === 0 || ids.includes(row.id))
      .filter(row => eagleIds.length === 0 || eagleIds.includes(row.eagleId));
    if (spec.query.includes('COUNT(1)')) return { items: [rows.length] };
    return { items: structuredClone(rows) };
  });
  t.mock.method(cosmos, 'queryPage', async (container, spec) => admitted(container, spec).map(row => row.id));
  const index = kind => async (opts) => {
    searches.push(opts);
    if (fail) throw fail;
    const ids = (ranked[kind] || RANKED[kind]).slice(opts.skip || 0, (opts.skip || 0) + opts.top);
    return { count: ids.length, items: ids.map(id => ({ id })), ids };
  };
  t.mock.method(aiSearch, 'searchProjects', index('projects'));
  t.mock.method(aiSearch, 'searchDocumentIds', index('documents'));
  t.mock.method(aiSearch, 'searchActivities', index('updates'));
  t.mock.method(aiSearch, 'searchNotifications', index('notifications'));
  return { searches, reads };
}

async function call(qs, user) {
  const req = { query: querystring.parse(qs), params: {}, headers: {}, header: () => undefined, user };
  const res = makeRes('test');
  res.set('vary', 'Origin');
  await getSuggestions(req, res);
  return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : undefined };
}

test('GET /suggest', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  for (const kind of Object.keys(FIELDS)) {
    await t.test(`${kind}: only the suggestion fields`, async (t) => {
      fakeStores(t);
      for (const user of [undefined, STAFF]) {
        const res = await call(`kind=${kind}&q=site`, user);
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.items.length > 0);
        for (const item of res.body.items) {
          assert.deepStrictEqual(Object.keys(item).filter(key => !FIELDS[kind].includes(key)), [], JSON.stringify(item));
        }
      }
    });
  }

  await t.test('documents and updates carry the parent project name', async (t) => {
    fakeStores(t);
    const parent = { projectEagleId: EAGLE_ID, projectName: 'Site C' };
    assert.deepStrictEqual((await call('kind=documents&q=site')).body.items,
      [{ id: 'd1', displayName: 'Site C report', projectId: 'p1', ...parent }]);
    assert.deepStrictEqual((await call('kind=updates&q=site')).body.items,
      [{ id: 'u1', headline: 'Site C opens', projectId: EAGLE_ID, notificationName: null, ...parent }]);
  });

  await t.test('answers at most limit rows', async (t) => {
    fakeStores(t);
    const res = await call('kind=projects&q=site&limit=1', STAFF);
    assert.deepStrictEqual(res.body.items, [{ id: 'p1', eagleId: EAGLE_ID, name: 'Site C' }]);
  });

  await t.test('asks the index for limit * 3 ids, 8 * 3 by default', async (t) => {
    const { searches } = fakeStores(t);
    await call('kind=updates&q=site&limit=2');
    await call('kind=notifications&q=site');
    await call('kind=projects&q=site&limit=1');
    assert.deepStrictEqual(searches.map(s => s.top), [6, 24, 3]);
  });

  await t.test('a withheld label does not take a slot: limit=1 answers the next visible row', async (t) => {
    fakeStores(t, { ranked: { projects: ['p-hidden-name', 'p2', 'p1'] } });
    assert.deepStrictEqual((await call('kind=projects&q=site&limit=1')).body.items,
      [{ id: 'p2', eagleId: 'cccccccccccccccccccccccc', name: 'Site D' }]);
  });

  await t.test('documents read a paged limit * 3 rows and answer limit of them', async (t) => {
    const { searches } = fakeStores(t, { ranked: { documents: ['d1', 'd2', 'd3'] } });
    const res = await call('kind=documents&q=site&limit=2');
    assert.deepStrictEqual(searches.map(s => [s.top, s.skip]), [[6, 0]]);
    assert.deepStrictEqual(res.body.items.map(item => item.id), ['d1', 'd2']);
  });

  await t.test('reads parent projects for the rows answered, not the whole id page', async (t) => {
    // Suggest runs per keystroke, so a parent read for rows past limit is spent for nothing.
    const { reads } = fakeStores(t, { ranked: { documents: ['d1', 'd4'] } });
    const res = await call('kind=documents&q=site&limit=1');
    assert.deepStrictEqual(res.body.items.map(item => item.id), ['d1']);
    assert.deepStrictEqual(reads.filter(read => read.container === 'projects').map(read => read.ids), [['p1']]);
  });

  await t.test('drops a row whose label the redactor withheld or that has an empty label', async (t) => {
    fakeStores(t, { ranked: { projects: ['p1', 'p-blank', 'p2', 'p-hidden-name'] } });
    const ids = async user => (await call('kind=projects&q=site', user)).body.items.map(item => item.id);
    assert.deepStrictEqual(await ids(), ['p1', 'p2']);
    assert.deepStrictEqual(await ids(STAFF), ['p1', 'p2', 'p-hidden-name']);
  });

  await t.test('documents: a withheld or empty label drops the row; the parent project is no fallback', async (t) => {
    fakeStores(t, { ranked: { documents: ['d-hidden', 'd-blank', 'd1'] } });
    const ids = async user => (await call('kind=documents&q=site', user)).body.items.map(item => item.id);
    assert.deepStrictEqual(await ids(), ['d1']);
    assert.deepStrictEqual(await ids(STAFF), ['d-hidden', 'd1']);
  });

  await t.test('comment periods: q reaches the repository as keywords, and limit * 3 rows are read', async (t) => {
    const { reads } = fakeStores(t);
    assert.strictEqual((await call('kind=comment-periods&q=%22site%22&limit=2')).status, 200);
    const [read] = reads.filter(r => r.container === 'commentPeriods');
    assert.deepStrictEqual(values(read.spec, '@keywords'), ['site']);
    assert.strictEqual(read.maxItemCount, 6);
  });

  await t.test('comment periods: a blank label falls back to the parent project name', async (t) => {
    fakeStores(t);
    const items = (await call('kind=comment-periods&q=site')).body.items;
    assert.deepStrictEqual(items.find(item => item.id === 'cp-blank'),
      { id: 'cp-blank', informationLabel: '', projectId: 'p2', projectEagleId: 'cccccccccccccccccccccccc', projectName: 'Site D' });
  });

  await t.test('comment periods: a withheld label falls back to the project name; staff see the label', async (t) => {
    fakeStores(t);
    const hidden = async user => (await call('kind=comment-periods&q=site', user)).body.items
      .find(item => item.id === 'cp-hidden-label');
    assert.strictEqual((await hidden()).informationLabel, undefined);
    assert.strictEqual((await hidden()).projectName, 'Site C');
    assert.strictEqual((await hidden(STAFF)).informationLabel, 'Site C secret round');
  });

  await t.test('comment periods: drops a row with no label and no parent the caller can read', async (t) => {
    fakeStores(t);
    const ids = async user => (await call('kind=comment-periods&q=site', user)).body.items.map(item => item.id);
    assert.deepStrictEqual(await ids(), ['cp1', 'cp-blank', 'cp-hidden-label']);
    assert.deepStrictEqual(await ids(STAFF), ['cp1', 'cp-blank', 'cp-hidden-label', 'cp-orphan']);
  });

  await t.test('comment periods: reads parent projects for the rows answered, not the whole page', async (t) => {
    const { reads } = fakeStores(t);
    const res = await call('kind=comment-periods&q=site&limit=1');
    assert.deepStrictEqual(res.body.items.map(item => item.id), ['cp1']);
    assert.deepStrictEqual(reads.filter(read => read.container === 'projects').map(read => read.ids), [['p1']]);
  });

  await t.test('refuses a bad query with 400 before any search', async (t) => {
    const { searches, reads } = fakeStores(t);
    const cases = {
      'kind=users&q=site': 'kind must be one of projects, documents, updates, notifications, comment-periods',
      'q=site': 'kind must be one of projects, documents, updates, notifications, comment-periods',
      'kind=comment-periods&q=%22%20%22': 'q needs more than quotes',
      'kind=projects&q=site&pageSize=2': 'unknown parameter: pageSize',
      'kind=projects&q=+a+': 'q takes 2 to 100 characters',
      'kind=projects': 'q takes 2 to 100 characters',
      [`kind=projects&q=${'a'.repeat(101)}`]: 'q takes 2 to 100 characters',
      'kind=projects&q=site&limit=9': 'limit must be a whole number from 1 to 8',
      'kind=projects&q=site&limit=08': 'limit must be a whole number from 1 to 8',
      'kind=projects&q=site&limit=0': 'limit must be a whole number from 1 to 8',
      'kind=projects&q=site&limit=8.0': 'limit must be a whole number from 1 to 8',
      'kind=projects&q=site&limit=0x8': 'limit must be a whole number from 1 to 8',
      'kind=projects&q=site&limit=%2B3': 'limit must be a whole number from 1 to 8',
      'kind=projects&q=site&limit=1e0': 'limit must be a whole number from 1 to 8',
      'kind=projects&q=site&limit=': 'limit must be a whole number from 1 to 8',
      // Two code points as sent, one after NFC.
      'kind=projects&q=e%CC%81': 'q takes 2 to 100 characters',
      'kind=projects&kind=documents&q=site': 'parameter given more than once: kind',
      'kind=projects&q=site&q=dam': 'parameter given more than once: q',
      'kind=projects&q=site&limit=2&limit=3': 'parameter given more than once: limit'
    };
    for (const [qs, error] of Object.entries(cases)) {
      const res = await call(qs);
      assert.strictEqual(res.status, 400, qs);
      assert.deepStrictEqual(res.body, { error }, qs);
      assert.strictEqual(res.headers['cache-control'], 'private, no-store', qs);
      assert.strictEqual(res.headers.vary, VARY, qs);
    }
    assert.strictEqual(searches.length, 0);
    assert.deepStrictEqual(reads, []);
  });

  await t.test('counts q in code points after trim', async (t) => {
    const { searches } = fakeStores(t);
    assert.strictEqual((await call(`kind=projects&q=${encodeURIComponent('🌲'.repeat(100))}`)).status, 200);
    assert.strictEqual((await call(`kind=projects&q=${encodeURIComponent(' 🌲 ')}`)).status, 400);
    assert.strictEqual(searches.length, 1);
  });

  await t.test('searches the NFC form of q', async (t) => {
    const { searches } = fakeStores(t);
    assert.strictEqual((await call('kind=projects&q=cafe%CC%81')).status, 200);
    assert.strictEqual(searches[0].keywords, 'caf\u00e9');
  });

  await t.test('anonymous success is public for 60 s; credentialed success is private', async (t) => {
    fakeStores(t);
    const anon = await call('kind=projects&q=site');
    assert.strictEqual(anon.headers['cache-control'], 'public, max-age=60');
    assert.strictEqual(anon.headers.vary, VARY);
    const staff = await call('kind=projects&q=site', STAFF);
    assert.strictEqual(staff.headers['cache-control'], 'private, no-store');
    assert.strictEqual(staff.headers.vary, VARY);
  });

  await t.test('comment periods: anonymous success is public for 60 s; credentialed success is private', async (t) => {
    fakeStores(t);
    assert.strictEqual((await call('kind=comment-periods&q=site')).headers['cache-control'], 'public, max-age=60');
    assert.strictEqual((await call('kind=comment-periods&q=site', STAFF)).headers['cache-control'], 'private, no-store');
  });

  await t.test('logs no search analytics event', async (t) => {
    fakeStores(t);
    const events = recordEvents(t);
    assert.strictEqual((await call('kind=projects&q=site')).status, 200);
    assert.deepStrictEqual(await events(audit.EVENTS_STREAM), []);
  });

  await t.test('a search-service failure answers as the list route does, never with its message', async (t) => {
    t.mock.method(logger, 'warn', () => {});
    const failure = status => Object.assign(new Error(`Azure said: $filter=read/any(r: r eq 'staff') (${status})`),
      { status, searchService: true });

    fakeStores(t, { fail: failure(503) });
    const down = await call('kind=projects&q=site');
    assert.strictEqual(down.status, 502);
    assert.deepStrictEqual(down.body, { error: 'The search service is unavailable.' });
    assert.strictEqual(down.headers['cache-control'], 'private, no-store');
    assert.strictEqual(down.headers.vary, VARY);

    t.mock.restoreAll();
    t.mock.method(logger, 'warn', () => {});
    fakeStores(t, { fail: failure(400) });
    const refused = await call('kind=projects&q=site');
    assert.strictEqual(refused.status, 400);
    assert.deepStrictEqual(refused.body, { error: 'The search service could not run this query.' });
    assert.strictEqual(refused.headers['cache-control'], 'private, no-store');
  });

  await t.test('any other failure is a bare 500', async (t) => {
    t.mock.method(logger, 'error', () => {});
    fakeStores(t, { fail: new Error('cosmos endpoint https://example.invalid') });
    const res = await call('kind=notifications&q=site');
    assert.strictEqual(res.status, 500);
    assert.deepStrictEqual(res.body, { success: false, error: 'Internal server error.' });
  });
});

test('GET /api/suggest through the dispatcher', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const send = (headers, qs = 'kind=projects&q=site') => dispatch(new HttpRequest({
    method: 'GET', url: `http://127.0.0.1/api/suggest?${qs}`, headers
  }), { error: () => {} });

  await t.test('no credential reaches the handler as anonymous', async (t) => {
    fakeStores(t);
    const res = await send({});
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(res.body).items.map(item => item.id), ['p1', 'p2']);
  });

  await t.test('comment periods reach the handler as anonymous', async (t) => {
    fakeStores(t);
    const res = await send({}, 'kind=comment-periods&q=site');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['cache-control'], 'public, max-age=60');
    assert.deepStrictEqual(JSON.parse(res.body).items.map(item => item.id), ['cp1', 'cp-blank', 'cp-hidden-label']);
  });

  await t.test('a rejected Bearer answers 401, not the public view', async (t) => {
    const { searches } = fakeStores(t);
    t.mock.method(logger, 'warn', () => {});
    t.mock.property(config, 'keycloakEnabled', true);
    t.mock.method(jwt, 'decode', () => ({ header: { kid: 'key-id' } }));
    t.mock.method(jwt, 'verify', (token, getKey, options, callback) => callback(new Error('jwt expired')));

    const res = await send({ authorization: 'Bearer expired-token' });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.headers['cache-control'], undefined);
    assert.strictEqual(res.headers.vary, 'Origin');
    assert.strictEqual(searches.length, 0);
  });
});

test('swagger documents the three parameters /suggest takes', () => {
  assert.deepStrictEqual([...swaggerParams('/api/suggest').keys()], ['kind', 'q', 'limit']);
});
