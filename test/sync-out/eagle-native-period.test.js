'use strict';

// What matters is how many Eagle periods a native create makes, under which id, and that eagle-api's
// echo of the create lands on the same DEMI row.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const queues = require('../../src/jobs/queue-client');
const commentPeriods = require('../../src/repositories/comment-periods');
const projects = require('../../src/repositories/projects');
const notifications = require('../../src/repositories/notifications');
const { logger } = require('../../src/utils/logger');
const syncOut = require('../../src/sync-out');
const eagle = require('../../src/sync-out/eagle');
const { COMMENT_PERIOD } = require('../../src/sync-out/kinds');
const commentPeriodController = require('../../src/controllers/nosql/comment-period');
const { mockRes, STAFF, PUBLIC_ACL } = require('../helpers/eagle-mirror-fixtures');
const config = require('../../src/config');

const API = 'https://eagle.example/api';
const ISSUER = config.keycloakIssuer;
const MILESTONE = '5cf00c03a266b7e1877504aa';
const PROJECT_ID = '1234';
const PROJECT_EAGLE_ID = '5cf00c03a266b7e1877504db';
const ROW_ID = '7d1e2f40-0000-4000-8000-000000000001';
const MAX_ATTEMPTS = 3;
const OBJECT_ID = /^[0-9a-f]{24}$/;

const ENV = {
  SYNC_OUT_QUEUE: 'sync-out',
  SYNC_OUT_EAGLE_ENABLED: 'true',
  EAGLE_PROTECTED_API_BASE: API,
  EAGLE_KC_CLIENT_ID: 'demi-sync-out',
  EAGLE_KC_CLIENT_SECRET: 'not-a-real-value',
  EAGLE_ENGAGE_MILESTONE: MILESTONE
};

/** A period as `domain/comment-periods.js` creates it, after one write. */
function nativeRow(overrides = {}) {
  return {
    id: ROW_ID,
    projectId: PROJECT_ID,
    sourceSystem: 'demi',
    eagleId: null,
    syncVersion: 1,
    isMet: false,
    metURL: '',
    metURLAdmin: '',
    metBannerImageUrl: '',
    dateStarted: '2026-11-01T07:00:00.000Z',
    dateCompleted: '2026-12-01T08:00:00.000Z',
    instructions: 'Comment on the draft plan.',
    informationLabel: 'Public comment period',
    commentTip: '',
    milestone: null,
    openHouses: [],
    relatedDocuments: [],
    commentIdCount: 0,
    isDeleted: false,
    isPublished: true,
    read: PUBLIC_ACL,
    sources: { demi: { read: PUBLIC_ACL } },
    ...overrides
  };
}

/** Every comment period row by id, writes guarded on `_etag` as Cosmos replace and create are. */
function wireStore(t, rows) {
  const store = new Map(rows.map(row => [row.id, { ...row, _etag: 'e1' }]));
  let writes = 0;
  t.mock.method(commentPeriods, 'readForWrite', async (id) =>
    (store.has(String(id)) ? structuredClone(store.get(String(id))) : null));
  t.mock.method(commentPeriods, 'readForWriteByEagleId', async (eagleId) => {
    const row = [...store.values()].find(r => r.eagleId === eagleId);
    return row ? structuredClone(row) : null;
  });
  t.mock.method(commentPeriods, 'readForWriteEngageByMetUrl', async () => null);
  t.mock.method(commentPeriods, 'upsert', async (item, current) => {
    const stored = store.get(item.id);
    if (!current && stored) throw Object.assign(new Error('exists'), { code: 409 });
    if (current && (!stored || current._etag !== stored._etag)) {
      throw Object.assign(new Error('precondition'), { code: 412 });
    }
    writes += 1;
    const saved = { ...structuredClone(item), _etag: `e${writes + 1}` };
    store.set(item.id, saved);
    return saved;
  });
  return store;
}

function wireParent(t, eagleId = PROJECT_EAGLE_ID) {
  const parent = { id: PROJECT_ID, eagleId, read: PUBLIC_ACL };
  t.mock.method(projects, 'readForWrite', async (id) => (String(id) === PROJECT_ID ? { ...parent } : null));
  t.mock.method(projects, 'getByEagleId', async (_access, id) => (id === eagleId ? { ...parent } : null));
  t.mock.method(notifications, 'readForWrite', async () => null);
}

function wireQueue(t) {
  const sent = [];
  t.mock.method(queues, 'queueClientFor', ({ name }) => ({
    sendMessage: async (body) => { sent.push({ queue: name, body: JSON.parse(body) }); }
  }));
  return sent;
}

/**
 * Fake eagle-api and Keycloak. `routes` maps `METHOD path` to a reply, a list served in order, or a function
 * of the request body; a reply `{ lost: true }` rejects as a dropped connection.
 */
function wireEagle(t, routes) {
  const calls = [];
  const served = {};
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (url === `${ISSUER}/protocol/openid-connect/token`) return Response.json({ access_token: 'token', expires_in: 300 });
    const key = `${method} ${url.slice(API.length)}`;
    const route = routes[key];
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    // Recorded before the check: the engine turns the thrown assertion into a retry, not a test failure.
    calls.push({ key, body });
    assert.ok(route, `unexpected eagle-api call ${key}`);
    const index = served[key] = (served[key] || 0) + 1;
    const listed = Array.isArray(route) ? route[Math.min(index, route.length) - 1] : route;
    const reply = typeof listed === 'function' ? await listed(body) : listed;
    if (reply.lost) throw new TypeError('fetch failed');
    return Response.json(reply.body ?? {}, { status: reply.status || 200 });
  });
  return calls;
}

const message = (overrides = {}) =>
  ({ kind: COMMENT_PERIOD, consumer: 'eagle', id: ROW_ID, projectId: PROJECT_ID, attempt: 1, ...overrides });
const run = (msg = message(), delivery = {}) => syncOut.run(msg, { maxAttempts: MAX_ATTEMPTS, ...delivery });
const keys = calls => calls.map(c => c.key);
/** eagle-api once it honours `_id`: the period is stored under the id it was sent. */
const accept = body => ({ body: { _id: body._id } });
const logged = (level, text) => logger[level].mock.calls.filter(c => String(c.arguments[0]).includes(text));

test('sync-out of DEMI-native comment periods', async (t) => {
  t.beforeEach((tt) => {
    const previous = Object.fromEntries(Object.keys(ENV).map(k => [k, process.env[k]]));
    Object.assign(process.env, ENV);
    tt.after(() => {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    });
    eagle.clearToken();
    for (const level of ['info', 'warn', 'error']) tt.mock.method(logger, level, () => {});
  });

  await t.test('the echo arriving during the POST lands on the native row by the minted id', async (tt) => {
    const store = wireStore(tt, [nativeRow()]);
    wireParent(tt);
    const sent = wireQueue(tt);
    let echo = null;
    const calls = wireEagle(tt, {
      // eagle-api awaits its push to DEMI before it answers the POST.
      'POST /commentperiod': async (body) => {
        const doc = { ...body, read: ['staff', 'sysadmin', 'public'], dateUpdated: '2026-11-01T07:00:05.000Z' };
        echo = mockRes();
        await commentPeriodController.upsertFromEagle({
          params: { eagleId: body._id }, query: {}, body: { doc, pushedAt: Date.now() }, user: STAFF
        }, echo);
        return accept(body);
      }
    });

    const result = await run();

    const posted = calls[0].body._id;
    assert.match(posted, OBJECT_ID);
    assert.strictEqual(echo.statusCode, 200, 'the echo is accepted');
    assert.deepStrictEqual([...store.keys()], [ROW_ID], 'one row: the echo did not create a second');
    const row = store.get(ROW_ID);
    assert.strictEqual(row.eagleId, posted);
    assert.strictEqual(row.sourceSystem, 'demi');
    assert.strictEqual(row.sources.eagle._id, posted, 'the echo landed on this row');
    assert.strictEqual(row.syncOut.eagle.status, 'sent');
    assert.strictEqual(row.syncOut.eagle.sentVersion, 1);
    assert.strictEqual(result.eagleId, posted);
    assert.deepStrictEqual(sent, [], 'the echo queues nothing');

    const again = wireEagle(tt, {});
    assert.deepStrictEqual(await run(), { skipped: 'current' });
    assert.deepStrictEqual(again, [], 'no second send');
  });

  await t.test('the POST carries the row\'s own fields under its parent\'s Eagle project', async (tt) => {
    wireStore(tt, [nativeRow({ milestone: '5cf00c03a266b7e18775aaaa' })]);
    wireParent(tt);
    wireQueue(tt);
    const calls = wireEagle(tt, { 'POST /commentperiod': accept });

    await run();

    const { body } = calls[0];
    assert.strictEqual(body.project, PROJECT_EAGLE_ID);
    assert.strictEqual(body.informationLabel, 'Public comment period');
    assert.strictEqual(body.instructions, 'Comment on the draft plan.');
    assert.strictEqual(body.isPublished, true);
    assert.strictEqual(body.milestone, '5cf00c03a266b7e18775aaaa', 'the row\'s milestone wins over the setting');
  });

  await t.test('a POST whose answer was lost is retried with the same id, gets 409 and PUTs', async (tt) => {
    const store = wireStore(tt, [nativeRow()]);
    wireParent(tt);
    wireQueue(tt);
    const calls = wireEagle(tt, {
      'POST /commentperiod': [{ lost: true }, { status: 409, body: { message: 'exists' } }]
    });

    assert.deepStrictEqual(await run(), { retryQueued: 2 });
    const minted = store.get(ROW_ID).eagleId;
    assert.match(minted, OBJECT_ID, 'the minted id stays on the row after the failure');

    const put = `PUT /commentperiod/${minted}`;
    const retry = wireEagle(tt, {
      'POST /commentperiod': { status: 409, body: { message: 'exists' } },
      [put]: { body: { matchedCount: 1 } }
    });
    const result = await run(message({ attempt: 2 }), { attempt: 2 });

    assert.strictEqual(calls[0].body._id, minted);
    assert.deepStrictEqual(keys(retry), ['POST /commentperiod', put]);
    assert.strictEqual(retry[0].body._id, minted, 'the retry POSTs the same id');
    assert.strictEqual(result.status, 'sent');
    assert.strictEqual(store.get(ROW_ID).eagleId, minted);
    assert.strictEqual(store.get(ROW_ID).syncOut.eagle.status, 'sent');
    assert.strictEqual(logged('info', `Eagle already holds ${minted}`).length, 1, 'the 409 info line');
  });

  await t.test('two concurrent deliveries make one POST', async (tt) => {
    const store = wireStore(tt, [nativeRow()]);
    wireParent(tt);
    wireQueue(tt);
    const calls = wireEagle(tt, { 'POST /commentperiod': accept });

    const results = await Promise.all([run(), run()]);

    assert.deepStrictEqual(keys(calls), ['POST /commentperiod']);
    assert.deepStrictEqual(results.map(r => r.status || 'retry').sort(), ['retry', 'sent']);
    assert.strictEqual(store.get(ROW_ID).eagleId, calls[0].body._id);
    assert.strictEqual(store.get(ROW_ID).syncOut.eagle.status, 'sent');
  });

  await t.test('a live creating claim that holds an eagleId blocks a second delivery', async (tt) => {
    const minted = eagle.mintEagleId();
    const store = wireStore(tt, [nativeRow({
      eagleId: minted, syncOut: { eagle: { status: 'creating', claim: 'other', claimedAt: new Date().toISOString() } }
    })]);
    wireParent(tt);
    const sent = wireQueue(tt);
    const calls = wireEagle(tt, {});

    assert.deepStrictEqual(await run(), { retryQueued: 2 });
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(store.get(ROW_ID).eagleId, minted);
    assert.strictEqual(store.get(ROW_ID).syncOut.eagle.claim, 'other');
  });

  await t.test('a lapsed creating claim is retaken with the stored eagleId, not a new one', async (tt) => {
    const minted = eagle.mintEagleId();
    const lapsed = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    wireStore(tt, [nativeRow({ eagleId: minted, syncOut: { eagle: { status: 'creating', claim: 'dead', claimedAt: lapsed } } })]);
    wireParent(tt);
    wireQueue(tt);
    const calls = wireEagle(tt, { 'POST /commentperiod': { body: { _id: minted } } });

    await run();

    assert.strictEqual(calls[0].body._id, minted);
    assert.strictEqual(logged('info', 'minted Eagle id').length, 0, 'nothing minted');
  });

  await t.test('a parent project without an eagleId ends failed, POSTs nothing and logs the error line',
    async (tt) => {
      const store = wireStore(tt, [nativeRow()]);
      wireParent(tt, null);
      wireQueue(tt);
      const calls = wireEagle(tt, {});

      await run(message({ attempt: MAX_ATTEMPTS }), { attempt: MAX_ATTEMPTS });

      assert.deepStrictEqual(calls, []);
      const row = store.get(ROW_ID);
      assert.strictEqual(row.syncOut.eagle.status, 'failed');
      assert.strictEqual(row.eagleId, null, 'no id minted for a period that cannot be sent');
      const [line] = logged('error', `project ${PROJECT_ID} of row ${ROW_ID} has no eagleId`);
      assert.ok(line, 'the error line names the parent');
      assert.strictEqual(line.arguments[1].parentId, PROJECT_ID);
    });

  await t.test('the mint is logged with the row, the id and the kind', async (tt) => {
    const store = wireStore(tt, [nativeRow()]);
    wireParent(tt);
    wireQueue(tt);
    wireEagle(tt, { 'POST /commentperiod': { lost: true } });

    await run();

    const [line] = logged('info', 'minted Eagle id');
    assert.ok(line, 'the mint info line');
    assert.deepStrictEqual(line.arguments[1],
      { rowId: ROW_ID, eagleId: store.get(ROW_ID).eagleId, kind: COMMENT_PERIOD });
  });

  await t.test('a POST answered under another id is failed and logged, never re-keyed or POSTed again',
    async (tt) => {
      const store = wireStore(tt, [nativeRow()]);
      wireParent(tt);
      wireQueue(tt);
      const calls = wireEagle(tt, { 'POST /commentperiod': { body: { _id: '5cf00c03a266b7e18775ffff' } } });

      assert.deepStrictEqual(await run(), { retryQueued: 2 });
      const row = store.get(ROW_ID);
      assert.match(row.eagleId, OBJECT_ID);
      assert.notStrictEqual(row.eagleId, '5cf00c03a266b7e18775ffff');
      assert.strictEqual(row.syncOut.eagle.status, 'failed');
      assert.strictEqual(row.syncOut.eagle.strayEagleId, '5cf00c03a266b7e18775ffff');
      assert.strictEqual(logged('error', 'not re-keyed').length, 1);

      await run(message({ attempt: MAX_ATTEMPTS }), { attempt: MAX_ATTEMPTS });
      assert.strictEqual(calls.length, 1, 'the retry does not POST a second stray');
      assert.strictEqual(store.get(ROW_ID).syncOut.eagle.status, 'failed');
    });

  await t.test('a sent native row PUTs; a PUT that finds nothing POSTs the same id', async (tt) => {
    const minted = eagle.mintEagleId();
    const store = wireStore(tt, [nativeRow({
      eagleId: minted, syncVersion: 2, syncOut: { eagle: { status: 'sent', sentVersion: 1 } }
    })]);
    wireParent(tt);
    wireQueue(tt);
    const put = `PUT /commentperiod/${minted}`;
    const calls = wireEagle(tt, {
      [put]: { body: { matchedCount: 0 } },
      'POST /commentperiod': { body: { _id: minted } }
    });

    await run();

    assert.deepStrictEqual(keys(calls), [put, 'POST /commentperiod']);
    assert.strictEqual(calls[1].body._id, minted);
    assert.strictEqual(store.get(ROW_ID).syncOut.eagle.sentVersion, 2);
  });
});
