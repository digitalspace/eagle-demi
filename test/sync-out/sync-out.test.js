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
const config = require('../../src/config');

const API = 'https://eagle.example/api';
// Derived from KEYCLOAK_URL and KEYCLOAK_REALM, not a setting of its own.
const ISSUER = config.keycloakIssuer;
const MILESTONE = '5cf00c03a266b7e1877504aa';
const PUSHED_AT = Date.parse('2026-10-08T17:00:00.000Z');
const VERSION = 3;
/** host.json's maxDequeueCount, which api/index.js passes in. */
const MAX_ATTEMPTS = 3;

const ENV = {
  SYNC_OUT_QUEUE: 'sync-out',
  SYNC_OUT_EAGLE_ENABLED: 'true',
  EAGLE_PROTECTED_API_BASE: API,
  EAGLE_KC_CLIENT_ID: 'demi-sync-out',
  EAGLE_KC_CLIENT_SECRET: 'not-a-real-value',
  EAGLE_ENGAGE_MILESTONE: MILESTONE
};

function engageRow(overrides = {}) {
  return {
    id: 'engage-42',
    projectId: 'p-207',
    sourceSystem: 'engage',
    engagementId: 42,
    eagleProjectId: '5cf00c03a266b7e1877504db',
    engagePushedAt: PUSHED_AT,
    syncVersion: VERSION,
    eagleId: null,
    dateStarted: '2026-10-10T07:00:00.000Z',
    dateCompleted: '2026-11-10T07:00:00.000Z',
    sources: {
      engage: {
        name: 'Have your say',
        description: 'Comment on the draft plan.',
        status: 2,
        start: '2026-10-10 07:00:00',
        end: '2026-11-10 07:00:00',
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

/**
 * One stored row whose writes are guarded on `_etag`, as Cosmos replace is. `others` are rows under other
 * ids, read only. `afterWrite(store)` runs after each write, to stand in for a concurrent writer.
 */
function wireStore(t, row, { others = {}, afterWrite } = {}) {
  const store = { row: row ? { ...row, _etag: 'e1' } : null, writes: 0 };
  t.mock.method(commentPeriods, 'readForWrite', async (id) => {
    if (store.row && String(id) === store.row.id) return structuredClone(store.row);
    return others[id] ? structuredClone(others[id]) : null;
  });
  t.mock.method(commentPeriods, 'upsert', async (item, current) => {
    if (current._etag !== store.row._etag) throw Object.assign(new Error('precondition'), { code: 412 });
    store.writes += 1;
    store.row = { ...structuredClone(item), _etag: `e${store.writes + 1}` };
    if (afterWrite) afterWrite(store);
    return store.row;
  });
  return store;
}

/** Records every send, per queue. `fail` names queues whose send throws. */
function wireQueue(t, { fail = [] } = {}) {
  const sent = [];
  t.mock.method(queues, 'queueClientFor', ({ name }) => ({
    sendMessage: async (body, options) => {
      if (fail.includes(name)) throw new Error(`queue ${name} down`);
      sent.push({ queue: name, body: JSON.parse(body), options });
    }
  }));
  return sent;
}

const run = (msg, delivery = {}) => syncOut.run(msg, { maxAttempts: MAX_ATTEMPTS, ...delivery });

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

    const result = await run(message());

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
    assert.strictEqual(entry.sentVersion, VERSION);
    assert.strictEqual(entry.projectId, '5cf00c03a266b7e1877504db', 'the Eagle project it was sent under');
    assert.strictEqual(entry.claim, undefined, 'the create claim is cleared');
  });

  await t.test('a create claimed by another live delivery does not POST and retries', async (tt) => {
    const store = wireStore(tt, engageRow({
      syncOut: { eagle: { status: 'creating', claim: 'other', claimedAt: new Date().toISOString() } }
    }));
    const sent = wireQueue(tt);
    const calls = wireEagle(tt, {});

    const result = await run(message());

    assert.deepStrictEqual(eagleCalls(calls), []);
    assert.deepStrictEqual(result, { retryQueued: 2 });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(store.row.syncOut.eagle.claim, 'other');
  });

  await t.test('PUTs when the eagleId is known', async (tt) => {
    const store = wireStore(tt, engageRow({ eagleId: 'cp-9' }));
    wireQueue(tt);
    const calls = wireEagle(tt, { 'PUT /commentperiod/cp-9': { body: { matchedCount: 1 } } });

    await run(message());

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

    await run(message());

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

      await run(message());

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

    assert.deepStrictEqual(await run(message()), { retryQueued: 2 });
    assert.deepStrictEqual(await run(message({ attempt: 2 })), { retryQueued: 3 });

    assert.deepStrictEqual(sent.map(s => s.body), [message({ attempt: 2 }), message({ attempt: 3 })]);
    assert.deepStrictEqual(sent.map(s => s.queue), ['sync-out', 'sync-out']);
    assert.deepStrictEqual(sent.map(s => s.options.visibilityTimeout), [30, 60]);
    assert.strictEqual(store.row.syncOut, undefined, 'nothing recorded before the last attempt');
  });

  await t.test('the last attempt records the failure, parks the message in poison and logs the alert line once', async (tt) => {
    const store = wireStore(tt, engageRow({ eagleId: 'cp-9' }));
    const sent = wireQueue(tt);
    wireEagle(tt, { 'PUT /commentperiod/cp-9': { status: 503, body: { message: 'down' } } });
    const alerts = () => logger.error.mock.calls.filter(c => String(c.arguments[0]).startsWith('[sync-out] job failed'));

    const result = await run(JSON.stringify(message({ attempt: 3 })), { attempt: 1 });

    assert.match(result.failed, /HTTP 503/, 'the last attempt returns; the host has nothing to retry');
    assert.deepStrictEqual(sent.map(s => [s.queue, s.body]), [['sync-out-poison', message({ attempt: 3 })]]);
    assert.strictEqual(alerts().length, 1);
    assert.strictEqual(store.row.syncOut.eagle.status, 'failed');
    assert.strictEqual(store.row.syncOut.eagle.failedVersion, VERSION);
    assert.match(store.row.syncOut.eagle.error, /PUT \/commentperiod\/cp-9: HTTP 503/);
    assert.strictEqual(store.row.syncOut.eagle.sentVersion, undefined, 'a failure is not a sent version');

    // The host hands the same message over again, as after a worker that died before completing it.
    assert.deepStrictEqual(await run(JSON.stringify(message({ attempt: 3 })), { attempt: 2 }), { skipped: 'failed' });
    assert.strictEqual(alerts().length, 1, 'a redelivery does not page again');
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(logger.warn.mock.calls.filter(c => /redelivery dropped/.test(c.arguments[0])).length, 1);
  });

  await t.test('a poison queue that cannot take the message still writes the alert line', async (tt) => {
    wireStore(tt, engageRow({ eagleId: 'cp-9' }));
    wireQueue(tt, { fail: ['sync-out-poison'] });
    wireEagle(tt, { 'PUT /commentperiod/cp-9': { status: 503 } });

    await run(message({ attempt: 3 }));

    const lines = logger.error.mock.calls.map(c => String(c.arguments[0]));
    assert.ok(lines.some(l => l.startsWith('[sync-out] could not move the message to sync-out-poison')));
    assert.strictEqual(lines.filter(l => l.startsWith('[sync-out] job failed')).length, 1);
  });

  await t.test('a retry that cannot be queued rethrows, so the host delivers the message again', async (tt) => {
    wireStore(tt, engageRow({ eagleId: 'cp-9' }));
    wireQueue(tt, { fail: ['sync-out'] });
    wireEagle(tt, { 'PUT /commentperiod/cp-9': { status: 503 } });

    await assert.rejects(run(message()), /HTTP 503/);
    assert.strictEqual(logger.error.mock.calls.filter(c => /job failed/.test(c.arguments[0])).length, 0);
  });

  await t.test('a consumer turned off after the message was queued drops it, no call made', async (tt) => {
    wireStore(tt, engageRow({ eagleId: 'cp-9' }));
    wireQueue(tt);
    const calls = wireEagle(tt, {});
    process.env.SYNC_OUT_EAGLE_ENABLED = 'false';

    assert.deepStrictEqual(await run(message()), { skipped: 'disabled' });
    assert.strictEqual(calls.length, 0);
  });

  await t.test('a row deleted from DEMI drops the message, no call made', async (tt) => {
    wireStore(tt, null);
    wireQueue(tt);
    const calls = wireEagle(tt, {});

    assert.deepStrictEqual(await run(message()), { skipped: 'missing' });
    assert.strictEqual(calls.length, 0);
  });

  await t.test('a missing EAGLE_* setting fails the attempt by name and retries', async (tt) => {
    const store = wireStore(tt, engageRow({ eagleId: 'cp-9' }));
    const sent = wireQueue(tt);
    const calls = wireEagle(tt, {});
    delete process.env.EAGLE_ENGAGE_MILESTONE;

    assert.deepStrictEqual(await run(message()), { retryQueued: 2 });
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(sent.length, 1);
    assert.match(logger.warn.mock.calls.at(-1).arguments[0], /EAGLE_ENGAGE_MILESTONE not set/);
    assert.strictEqual(store.row.syncOut, undefined);
  });

  await t.test('a token response without access_token fails the attempt', async (tt) => {
    wireStore(tt, engageRow({ eagleId: 'cp-9' }));
    wireQueue(tt);
    tt.mock.method(globalThis, 'fetch', async () => Response.json({ expires_in: 300 }));

    assert.deepStrictEqual(await run(message()), { retryQueued: 2 });
    assert.match(logger.warn.mock.calls.at(-1).arguments[0], /no access_token/);
  });

  await t.test('a write that lands while sending queues a resend, and records only what was sent', async (tt) => {
    let raced = false;
    const store = wireStore(tt, engageRow({ eagleId: 'cp-9' }));
    const sent = wireQueue(tt);
    wireEagle(tt, { 'PUT /commentperiod/cp-9': { body: { matchedCount: 1 } } });
    const put = globalThis.fetch;
    tt.mock.method(globalThis, 'fetch', async (url, opts) => {
      const res = await put(url, opts);
      if (!raced && opts && opts.method === 'PUT') {
        raced = true;
        store.row = { ...store.row, syncVersion: VERSION + 1, _etag: 'ingest' };
      }
      return res;
    });

    await run(message());

    assert.strictEqual(store.row.syncOut.eagle.sentVersion, VERSION, 'never a version it did not send');
    assert.deepStrictEqual(sent.map(s => s.body), [{ ...message(), resend: true }]);

    // Another delivery already recorded version 4, so the resend must not be skipped as current.
    store.row = { ...store.row, syncOut: { eagle: { sentVersion: VERSION + 1, status: 'sent' } } };
    const second = wireEagle(tt, { 'PUT /commentperiod/cp-9': { body: { matchedCount: 1 } } });
    await run(sent[0].body);
    assert.deepStrictEqual(eagleCalls(second), ['PUT /commentperiod/cp-9']);
    assert.strictEqual(store.row.syncOut.eagle.sentVersion, VERSION + 1, 'never moved back');
  });

  await t.test('a project move deletes the Eagle period under the old project and creates one under the new', async (tt) => {
    const store = wireStore(tt, engageRow({
      eagleId: 'cp-old', eagleProjectId: 'eagle-new',
      syncOut: { eagle: { sentVersion: VERSION - 1, status: 'sent', projectId: 'eagle-old' } }
    }));
    wireQueue(tt);
    const calls = wireEagle(tt, {
      'DELETE /commentperiod/cp-old': { body: {} },
      'GET /commentperiod?project=eagle-new&fields=metURL': { body: [] },
      'POST /commentperiod': { body: { _id: 'cp-new' } }
    });

    await run(message());

    assert.deepStrictEqual(eagleCalls(calls), [
      'DELETE /commentperiod/cp-old', 'GET /commentperiod?project=eagle-new&fields=metURL', 'POST /commentperiod'
    ]);
    assert.strictEqual(calls.find(c => c.path === '/commentperiod').body.project, 'eagle-new');
    assert.strictEqual(store.row.eagleId, 'cp-new');
    assert.strictEqual(store.row.syncOut.eagle.projectId, 'eagle-new');
  });

  await t.test('a claim taken over while looking up Eagle stops the POST', async (tt) => {
    const store = wireStore(tt, engageRow());
    const sent = wireQueue(tt);
    wireEagle(tt, { [`GET ${LIST_PATH}`]: { body: [] } });
    const get = globalThis.fetch;
    tt.mock.method(globalThis, 'fetch', async (url, opts) => {
      const res = await get(url, opts);
      // Past the lease, another delivery claimed the create while this one waited on eagle-api.
      if (String(url).includes('fields=metURL')) {
        store.row = { ...store.row, syncOut: { eagle: { status: 'creating', claim: 'other', claimedAt: new Date().toISOString() } } };
      }
      return res;
    });

    assert.deepStrictEqual(await run(message()), { retryQueued: 2 });
    assert.match(logger.warn.mock.calls.at(-1).arguments[0], /taken by another delivery/);
    assert.strictEqual(store.row.syncOut.eagle.claim, 'other');
    assert.strictEqual(sent.length, 1);
  });

  await t.test('an empty metURL never POSTs: the row is skipped and the error logged', async (tt) => {
    const store = wireStore(tt, engageRow({
      sources: { engage: { ...engageRow().sources.engage, metURL: '' } }
    }));
    wireQueue(tt);
    const calls = wireEagle(tt, {});

    assert.deepStrictEqual(await run(message()), { status: 'skipped' });
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(store.row.syncOut.eagle.status, 'skipped');
    assert.match(logger.error.mock.calls.at(-1).arguments[0], /has no metURL/);
  });

  await t.test('a metURL match DEMI already mirrors as an Eagle-owned row is a conflict, not adopted', async (tt) => {
    const store = wireStore(tt, engageRow(), {
      others: { 'cp-legacy': { id: 'cp-legacy', projectId: 'p-207', sourceSystem: 'eagle' } }
    });
    wireQueue(tt);
    const calls = wireEagle(tt, {
      [`GET ${LIST_PATH}`]: { body: [{ _id: 'cp-legacy', metURL: 'https://engage.example/have-your-say' }] }
    });

    assert.deepStrictEqual(await run(message()), { status: 'conflict' });
    assert.deepStrictEqual(eagleCalls(calls), [`GET ${LIST_PATH}`], 'no PUT, no POST');
    assert.strictEqual(store.row.eagleId, null);
    assert.strictEqual(store.row.syncOut.eagle.status, 'conflict');
    assert.strictEqual(store.row.syncOut.eagle.candidateEagleId, 'cp-legacy');
    assert.strictEqual(store.row.syncOut.eagle.claim, undefined, 'the claim is released');
    assert.match(logger.error.mock.calls.at(-1).arguments[0], /already an Eagle-owned DEMI row/);
  });

  await t.test('a row already sent at this version is skipped', async (tt) => {
    wireStore(tt, engageRow({
      eagleId: 'cp-9', syncOut: { eagle: { sentVersion: VERSION, status: 'sent' } }
    }));
    wireQueue(tt);
    const calls = wireEagle(tt, {});

    assert.deepStrictEqual(await run(message()), { skipped: 'current' });
    assert.strictEqual(calls.length, 0);
  });

  await t.test('a row sent at an older version is sent again', async (tt) => {
    const store = wireStore(tt, engageRow({
      eagleId: 'cp-9', syncOut: { eagle: { sentVersion: VERSION - 1, status: 'sent' } }
    }));
    wireQueue(tt);
    const calls = wireEagle(tt, { 'PUT /commentperiod/cp-9': { body: { matchedCount: 1 } } });

    await run(message());

    assert.ok(calls.some(c => c.method === 'PUT'), 'the newer version is written to Eagle');
    assert.strictEqual(store.row.syncOut.eagle.sentVersion, VERSION);
  });

  await t.test('a slug-only edit, same engagePushedAt but a new syncVersion, is sent', async (tt) => {
    wireStore(tt, engageRow({
      eagleId: 'cp-9', syncOut: { eagle: { sentVersion: VERSION - 1, status: 'sent' } }
    }));
    wireQueue(tt);
    const calls = wireEagle(tt, { 'PUT /commentperiod/cp-9': { body: { matchedCount: 1 } } });

    await run(message());

    assert.strictEqual(calls.find(c => c.method === 'PUT').body.metURL, 'https://engage.example/have-your-say');
  });

  await t.test('enqueue sends one message per enabled consumer that wants the row', async (tt) => {
    const sent = wireQueue(tt);

    assert.deepStrictEqual(await syncOut.enqueue(engageRow()), ['eagle']);
    assert.deepStrictEqual(sent.map(s => s.body), [{ ...message(), projectId: 'p-207' }]);

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

    await run(message());

    assert.deepStrictEqual(calls.map(c => c.path === 'token' ? 'token' : `${c.method} ${c.auth}`),
      ['token', 'PUT Bearer token-1', 'token', 'PUT Bearer token-2']);
  });

  await t.test('a second 401 is a failure, not another re-mint', async (tt) => {
    wireStore(tt, engageRow({ eagleId: 'cp-9' }));
    const sent = wireQueue(tt);
    const calls = wireEagle(tt, { 'PUT /commentperiod/cp-9': { status: 401 } });

    assert.deepStrictEqual(await run(message()), { retryQueued: 2 });
    assert.strictEqual(calls.filter(c => c.path === 'token').length, 2);
    assert.strictEqual(sent.length, 1);
  });

  await t.test('a deleted row DELETEs the Eagle period', async (tt) => {
    const store = wireStore(tt, engageRow({ eagleId: 'cp-9', isDeleted: true }));
    wireQueue(tt);
    const calls = wireEagle(tt, { 'DELETE /commentperiod/cp-9': { body: {} } });

    await run(message());

    assert.deepStrictEqual(eagleCalls(calls), ['DELETE /commentperiod/cp-9']);
    assert.strictEqual(store.row.syncOut.eagle.status, 'sent');
  });
});
