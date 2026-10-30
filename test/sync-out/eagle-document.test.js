'use strict';

// What matters is which eagle-api calls a document send makes, in what order, and that a second
// delivery racing the first makes none.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { writeGuarded } = require('../../src/helpers/etag-write');
const { logger } = require('../../src/utils/logger');
const eagle = require('../../src/sync-out/eagle');
const consumer = require('../../src/sync-out/eagle-document');
const config = require('../../src/config');

const API = 'https://eagle.example/api';
const ISSUER = config.keycloakIssuer;
const EAGLE_ID = '5cf00c03a266b7e1877504dd';
const ROW_ID = '7d1e2f40-0000-4000-8000-0000000000d1';
const PUBLIC_ACL = ['public', 'staff', 'sysadmin'];
const STAFF_ACL = ['staff', 'sysadmin'];

const ENV = {
  SYNC_OUT_EAGLE_ENABLED: 'true',
  EAGLE_PROTECTED_API_BASE: API,
  EAGLE_KC_CLIENT_ID: 'demi-sync-out',
  EAGLE_KC_CLIENT_SECRET: 'not-a-real-value',
  EAGLE_ENGAGE_MILESTONE: '5cf00c03a266b7e1877504aa'
};

function demiRow(overrides = {}) {
  return {
    id: ROW_ID,
    projectId: '1234',
    sourceSystem: 'demi',
    eagleId: EAGLE_ID,
    syncVersion: 2,
    displayName: 'Draft plan',
    description: 'The draft plan for comment.',
    typeId: '5cf00c03a266b7e18775aa01',
    milestoneId: '5cf00c03a266b7e18775aa02',
    projectPhaseId: null,
    documentAuthorTypeId: '5cf00c03a266b7e18775aa04',
    datePosted: '2026-11-01T07:00:00.000Z',
    dateUploaded: '2026-10-30T07:00:00.000Z',
    legislation: 2018,
    sortOrder: 3,
    eaoStatus: 'Published',
    s3Key: 'docs/draft-plan.pdf',
    fileSize: 1024,
    contentExtracted: true,
    read: PUBLIC_ACL,
    isPublished: true,
    ...overrides
  };
}

/** One row, writes guarded on `_etag`, and the engine's `update` over it. */
function wireStore(row) {
  const store = { row: { ...row, _etag: 'e1' }, writes: 0 };
  const reread = async () => structuredClone(store.row);
  store.update = async mutate => writeGuarded({
    existing: await reread(),
    reread,
    attempt: async (current) => {
      const item = mutate(current);
      if (!item) return { status: 'unchanged', row: current };
      if (current._etag !== store.row._etag) throw Object.assign(new Error('precondition'), { code: 412 });
      store.writes += 1;
      store.row = { ...structuredClone(item), _etag: `e${store.writes + 1}` };
      return { status: 'saved', row: store.row };
    }
  });
  return store;
}

/** Fake eagle-api and Keycloak; `routes` maps `METHOD path` to a reply. */
function wireEagle(t, routes) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    if (url === `${ISSUER}/protocol/openid-connect/token`) return Response.json({ access_token: 'token', expires_in: 300 });
    const key = `${opts.method || 'GET'} ${url.slice(API.length)}`;
    calls.push({ key, body: opts.body ? JSON.parse(opts.body) : undefined });
    const reply = routes[key];
    assert.ok(reply, `unexpected eagle-api call ${key}`);
    return Response.json(reply.body ?? {}, { status: reply.status || 200 });
  });
  return calls;
}

const PUT = `PUT /document/${EAGLE_ID}`;
const PUBLISH = `PUT /document/${EAGLE_ID}/publish`;
const UNPUBLISH = `PUT /document/${EAGLE_ID}/unpublish`;
const keys = calls => calls.map(c => c.key);
const logged = (level, text) => logger[level].mock.calls.filter(c => String(c.arguments[0]).includes(text));

test('sync-out of documents to Eagle', async (t) => {
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

  await t.test('a public row PUTs the DEMI fields, then publishes', async (tt) => {
    const store = wireStore(demiRow());
    const calls = wireEagle(tt, { [PUT]: {}, [PUBLISH]: {} });

    const result = await consumer.send(store.row, { update: store.update });

    assert.deepStrictEqual(keys(calls), [PUT, PUBLISH]);
    assert.deepStrictEqual(calls[0].body, {
      displayName: 'Draft plan',
      description: 'The draft plan for comment.',
      type: '5cf00c03a266b7e18775aa01',
      milestone: '5cf00c03a266b7e18775aa02',
      documentAuthorType: '5cf00c03a266b7e18775aa04',
      datePosted: '2026-11-01T07:00:00.000Z',
      dateUploaded: '2026-10-30T07:00:00.000Z',
      legislation: 2018,
      sortOrder: 3
    }, 'no read, eaoStatus, file or extraction fields');
    assert.deepStrictEqual(result, { status: 'sent', eagleId: EAGLE_ID });
    assert.deepStrictEqual(store.row.syncOut.eagle, { status: 'sent' }, 'the claim is released');
    assert.strictEqual(logged('info', `document ${ROW_ID} sent to Eagle`).length, 1);
  });

  await t.test('a row without public in read unpublishes', async (tt) => {
    const store = wireStore(demiRow({ read: STAFF_ACL, isPublished: false }));
    const calls = wireEagle(tt, { [PUT]: {}, [UNPUBLISH]: {} });

    await consumer.send(store.row, { update: store.update });

    assert.deepStrictEqual(keys(calls), [PUT, UNPUBLISH]);
  });

  await t.test('a row without an eagleId, or one Eagle owns, is not wanted and sends nothing', async (tt) => {
    const calls = wireEagle(tt, {});
    const noId = wireStore(demiRow({ eagleId: null }));

    assert.strictEqual(consumer.wants(noId.row), false);
    assert.strictEqual(consumer.wants(demiRow({ sourceSystem: 'eagle' })), false);
    assert.strictEqual(consumer.wants(demiRow()), true);
    assert.deepStrictEqual(await consumer.send(noId.row, { update: noId.update }), { status: 'skipped' });
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(noId.writes, 0);
  });

  await t.test('two concurrent deliveries make one PUT', async (tt) => {
    const store = wireStore(demiRow());
    const calls = wireEagle(tt, { [PUT]: {}, [PUBLISH]: {} });
    const row = structuredClone(store.row);

    const results = await Promise.allSettled([
      consumer.send(row, { update: store.update }),
      consumer.send(row, { update: store.update })
    ]);

    assert.deepStrictEqual(keys(calls), [PUT, PUBLISH]);
    assert.deepStrictEqual(results.filter(r => r.status === 'fulfilled').map(r => r.value),
      [{ status: 'sent', eagleId: EAGLE_ID }]);
    assert.match(results.find(r => r.status === 'rejected').reason.message, /another delivery is sending/);
  });

  await t.test('a failed PUT logs one error, releases the claim and publishes nothing', async (tt) => {
    const store = wireStore(demiRow());
    const calls = wireEagle(tt, { [PUT]: { status: 500, body: { message: 'down' } } });

    await assert.rejects(consumer.send(store.row, { update: store.update }), /HTTP 500/);

    assert.deepStrictEqual(keys(calls), [PUT]);
    assert.deepStrictEqual(store.row.syncOut.eagle, { status: 'failed' });
    assert.strictEqual(logged('error', `document ${ROW_ID} not sent`).length, 1);
  });
});
