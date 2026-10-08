'use strict';

/**
 * Sync-out engine and its Eagle consumer, against a fake queue, an in-memory row with etags and a
 * fake eagle-api. What matters is what reaches Eagle (which verb, which id) and what the row says
 * afterwards, because the row is what makes the next delivery skip or retry.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const queues = require('../../src/jobs/queue-client');
const commentPeriods = require('../../src/repositories/comment-periods');
const { logger } = require('../../src/utils/logger');
const syncOut = require('../../src/sync-out');
const eagle = require('../../src/sync-out/eagle');

const API = 'https://eagle.example/api';
const ISSUER = 'https://login.example/auth/realms/eao-epic';
const MILESTONE = '5cf00c03a266b7e1877504aa';
const PUSHED_AT = '2026-10-08T17:00:00.000Z';

const ENV = {
  SYNC_OUT_EAGLE_ENABLED: 'true',
  EAGLE_API_BASE: API,
  EAGLE_KC_ISSUER: ISSUER,
  EAGLE_KC_CLIENT_ID: 'demi-sync-out',
  EAGLE_KC_CLIENT_SECRET: 'not-a-real-value',
  EAGLE_ENGAGE_MILESTONE: MILESTONE,
  SYNC_OUT_MAX_ATTEMPTS: '3'
};

function engageRow(overrides = {}) {
  return {
    id: 'engage-42',
    projectId: 'p-207',
    sourceSystem: 'engage',
    engagementId: 42,
    eagleProjectId: '5cf00c03a266b7e1877504db',
    engagePushedAt: PUSHED_AT,
    eagleId: null,
    sources: {
      engage: {
        name: 'Have your say',
        description: 'Comment on the draft plan.',
        status: 'Open',
        start: '2026-10-10T07:00:00.000Z',
        end: '2026-11-10T07:00:00.000Z',
        metURL: 'https://engage.example/have-your-say',
        metURLAdmin: 'https://engage.example/admin/42',
        bannerUrl: 'https://engage.example/banner.png',
        isPublished: true,
        isDeleted: false
      }
    },
    ...overrides
  };
}

/** One stored row whose writes are guarded on `_etag`, as Cosmos replace is. */
function wireStore(t, row) {
  const store = { row: row ? { ...row, _etag: 'e1' } : null, writes: 0 };
  t.mock.method(commentPeriods, 'readForWrite', async () => (store.row ? structuredClone(store.row) : null));
  t.mock.method(commentPeriods, 'upsert', async (item, current) => {
    if (current._etag !== store.row._etag) throw Object.assign(new Error('precondition'), { code: 412 });
    store.writes += 1;
    store.row = { ...structuredClone(item), _etag: `e${store.writes + 1}` };
    return store.row;
  });
  return store;
}

function wireQueue(t) {
  const sent = [];
  t.mock.method(queues, 'queueClientFor', () => ({
    sendMessage: async (body, options) => { sent.push({ body: JSON.parse(body), options }); }
  }));
  return sent;
}

/**
 * Fake eagle-api and Keycloak. `routes` maps `METHOD path` to a response or a list of responses
 * served in order; unrouted calls fail the test.
 */
function wireEagle(t, routes) {
  const calls = [];
  const served = {};
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (url === `${ISSUER}/protocol/openid-connect/token`) {
      calls.push({ method, path: 'token' });
      return Response.json({ access_token: `token-${calls.filter(c => c.path === 'token').length}`, expires_in: 300 });
    }
    const path = url.slice(API.length);
    const key = `${method} ${path}`;
    const route = routes[key];
    assert.ok(route, `unexpected eagle-api call ${key}`);
    const index = served[key] = (served[key] || 0) + 1;
    const reply = Array.isArray(route) ? route[Math.min(index, route.length) - 1] : route;
    calls.push({
      method, path, auth: opts.headers && opts.headers.Authorization,
      body: opts.body ? JSON.parse(opts.body) : undefined
    });
    return Response.json(reply.body ?? {}, { status: reply.status || 200 });
  });
  return calls;
}

const message = (overrides = {}) =>
  ({ consumer: 'eagle', id: 'engage-42', projectId: 'p-207', attempt: 1, ...overrides });

const eagleCalls = (calls) => calls.filter(c => c.path !== 'token').map(c => `${c.method} ${c.path}`);

const LIST_PATH = '/commentperiod?project=5cf00c03a266b7e1877504db&fields=metURL';

test('sync-out', async (t) => {
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

  await t.test('POSTs when the row has no eagleId, then stores the returned id', async (tt) => {
    const store = wireStore(tt, engageRow());
    wireQueue(tt);
    const calls = wireEagle(tt, {
      [`GET ${LIST_PATH}`]: { body: [] },
      'POST /commentperiod': { body: { _id: 'cp-new' } }
    });

    const result = await syncOut.run(message());

    assert.deepStrictEqual(eagleCalls(calls), [`GET ${LIST_PATH}`, 'POST /commentperiod']);
    const post = calls.find(c => c.method === 'POST' && c.path === '/commentperiod');
    assert.strictEqual(post.auth, 'Bearer token-1');
    assert.deepStrictEqual(post.body, {
      project: '5cf00c03a266b7e1877504db',
      dateStarted: '2026-10-10T07:00:00.000Z',
      dateCompleted: '2026-11-10T07:00:00.000Z',
      isMet: true,
      metURL: 'https://engage.example/have-your-say',
      metURLAdmin: 'https://engage.example/admin/42',
      metBannerImageUrl: 'https://engage.example/banner.png',
      informationLabel: 'Have your say',
      instructions: 'Comment on the draft plan.',
      isPublished: true,
      milestone: MILESTONE
    });
    assert.strictEqual(result.eagleId, 'cp-new');
    assert.strictEqual(store.row.eagleId, 'cp-new');
    const entry = store.row.syncOut.eagle;
    assert.strictEqual(entry.status, 'sent');
    assert.strictEqual(entry.sentVersion, PUSHED_AT);
    assert.strictEqual(entry.claim, undefined, 'the create claim is cleared');
  });

  await t.test('a create claimed by another live delivery does not POST and retries', async (tt) => {
    const store = wireStore(tt, engageRow({
      syncOut: { eagle: { status: 'creating', claim: 'other', claimedAt: new Date().toISOString() } }
    }));
    const sent = wireQueue(tt);
    const calls = wireEagle(tt, {});

    const result = await syncOut.run(message());

    assert.deepStrictEqual(eagleCalls(calls), []);
    assert.deepStrictEqual(result, { retryQueued: 2 });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(store.row.syncOut.eagle.claim, 'other');
  });

  await t.test('PUTs when the eagleId is known', async (tt) => {
    const store = wireStore(tt, engageRow({ eagleId: 'cp-9' }));
    wireQueue(tt);
    const calls = wireEagle(tt, { 'PUT /commentperiod/cp-9': { body: { matchedCount: 1 } } });

    await syncOut.run(message());

    assert.deepStrictEqual(eagleCalls(calls), ['PUT /commentperiod/cp-9']);
    assert.strictEqual(calls.at(-1).body.milestone, MILESTONE);
    assert.strictEqual(store.row.syncOut.eagle.status, 'sent');
    assert.strictEqual(store.row.eagleId, 'cp-9');
  });

  await t.test('an Eagle period with the same metURL is adopted, not POSTed again', async (tt) => {
    const store = wireStore(tt, engageRow());
    wireQueue(tt);
    const calls = wireEagle(tt, {
      [`GET ${LIST_PATH}`]: {
        body: [{ _id: 'cp-other', metURL: 'https://engage.example/other' },
          { _id: 'cp-5', metURL: 'https://engage.example/have-your-say' }]
      },
      'PUT /commentperiod/cp-5': { body: { matchedCount: 1 } }
    });

    await syncOut.run(message());

    assert.deepStrictEqual(eagleCalls(calls), [`GET ${LIST_PATH}`, 'PUT /commentperiod/cp-5']);
    assert.strictEqual(store.row.eagleId, 'cp-5');
  });

  for (const [label, reply] of [['404', { status: 404 }], ['a zero match count', { body: { matchedCount: 0 } }]]) {
    await t.test(`a PUT answered with ${label} falls through to create`, async (tt) => {
      const store = wireStore(tt, engageRow({ eagleId: 'cp-gone' }));
      wireQueue(tt);
      const calls = wireEagle(tt, {
        'PUT /commentperiod/cp-gone': reply,
        [`GET ${LIST_PATH}`]: { body: [] },
        'POST /commentperiod': { body: { _id: 'cp-7' } }
      });

      await syncOut.run(message());

      assert.deepStrictEqual(eagleCalls(calls),
        ['PUT /commentperiod/cp-gone', `GET ${LIST_PATH}`, 'POST /commentperiod']);
      assert.strictEqual(store.row.eagleId, 'cp-7');
      assert.strictEqual(store.row.syncOut.eagle.status, 'sent');
    });
  }

  await t.test('a 5xx re-queues with a delay that doubles per attempt', async (tt) => {
    const store = wireStore(tt, engageRow({ eagleId: 'cp-9' }));
    const sent = wireQueue(tt);
    wireEagle(tt, { 'PUT /commentperiod/cp-9': { status: 503, body: { message: 'down' } } });

    assert.deepStrictEqual(await syncOut.run(message()), { retryQueued: 2 });
    assert.deepStrictEqual(await syncOut.run(message({ attempt: 2 })), { retryQueued: 3 });

    assert.deepStrictEqual(sent.map(s => s.body), [message({ attempt: 2 }), message({ attempt: 3 })]);
    assert.deepStrictEqual(sent.map(s => s.options.visibilityTimeout), [30, 60]);
    assert.strictEqual(store.row.syncOut, undefined, 'nothing recorded before the last attempt');
  });

  await t.test('the last attempt records the failure and throws for the poison queue', async (tt) => {
    const store = wireStore(tt, engageRow({ eagleId: 'cp-9' }));
    const sent = wireQueue(tt);
    wireEagle(tt, { 'PUT /commentperiod/cp-9': { status: 503, body: { message: 'down' } } });

    await assert.rejects(
      syncOut.workerHandler(JSON.stringify(message({ attempt: 3 })), { triggerMetadata: { dequeueCount: 1 } }),
      /HTTP 503/);

    assert.strictEqual(sent.length, 0);
    assert.strictEqual(store.row.syncOut.eagle.status, 'failed');
    assert.match(store.row.syncOut.eagle.error, /PUT \/commentperiod\/cp-9: HTTP 503/);
    assert.strictEqual(store.row.syncOut.eagle.sentVersion, undefined, 'a failure is not a sent version');
  });

  await t.test('a row already sent at this version is skipped', async (tt) => {
    wireStore(tt, engageRow({
      eagleId: 'cp-9', syncOut: { eagle: { sentVersion: PUSHED_AT, status: 'sent' } }
    }));
    wireQueue(tt);
    const calls = wireEagle(tt, {});

    assert.deepStrictEqual(await syncOut.run(message()), { skipped: 'current' });
    assert.strictEqual(calls.length, 0);
  });

  await t.test('enqueue sends one message per enabled consumer that wants the row', async (tt) => {
    const sent = wireQueue(tt);

    assert.deepStrictEqual(await syncOut.enqueue(engageRow()), ['eagle']);
    assert.deepStrictEqual(sent.map(s => s.body), [message()]);

    assert.deepStrictEqual(await syncOut.enqueue(engageRow({ sourceSystem: 'eagle' })), []);
    process.env.SYNC_OUT_EAGLE_ENABLED = 'false';
    assert.deepStrictEqual(await syncOut.enqueue(engageRow()), []);
    assert.strictEqual(sent.length, 1, 'a disabled consumer queues nothing');
  });

  await t.test('a 401 re-mints the token once and retries the call', async (tt) => {
    wireStore(tt, engageRow({ eagleId: 'cp-9' }));
    wireQueue(tt);
    const calls = wireEagle(tt, {
      'PUT /commentperiod/cp-9': [{ status: 401 }, { body: { matchedCount: 1 } }]
    });

    await syncOut.run(message());

    assert.deepStrictEqual(calls.map(c => c.path === 'token' ? 'token' : `${c.method} ${c.auth}`),
      ['token', 'PUT Bearer token-1', 'token', 'PUT Bearer token-2']);
  });

  await t.test('a second 401 is a failure, not another re-mint', async (tt) => {
    wireStore(tt, engageRow({ eagleId: 'cp-9' }));
    const sent = wireQueue(tt);
    const calls = wireEagle(tt, { 'PUT /commentperiod/cp-9': { status: 401 } });

    assert.deepStrictEqual(await syncOut.run(message()), { retryQueued: 2 });
    assert.strictEqual(calls.filter(c => c.path === 'token').length, 2);
    assert.strictEqual(sent.length, 1);
  });

  await t.test('a deleted row DELETEs the Eagle period', async (tt) => {
    const store = wireStore(tt, engageRow({ eagleId: 'cp-9', isDeleted: true }));
    wireQueue(tt);
    const calls = wireEagle(tt, { 'DELETE /commentperiod/cp-9': { body: {} } });

    await syncOut.run(message());

    assert.deepStrictEqual(eagleCalls(calls), ['DELETE /commentperiod/cp-9']);
    assert.strictEqual(store.row.syncOut.eagle.status, 'sent');
  });
});
