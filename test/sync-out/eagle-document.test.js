'use strict';

// What matters is which eagle-api calls a document send makes, in what order, and that a second
// delivery racing the first makes none.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const { logger } = require('../../src/utils/logger');
const syncOut = require('../../src/sync-out');
const eagle = require('../../src/sync-out/eagle');
const consumer = require('../../src/sync-out/eagle-document');
const config = require('../../src/config');
const { DOCUMENT, kindOf } = require('../../src/sync-out/kinds');

const API = 'https://eagle.example/api';
const ISSUER = config.keycloakIssuer;
const EAGLE_ID = '5cf00c03a266b7e1877504dd';
const ROW_ID = '7d1e2f40-0000-4000-8000-0000000000d1';
const PUBLIC_ACL = ['public', 'staff', 'sysadmin'];
const STAFF_ACL = ['staff', 'sysadmin'];

const ENV = {
  SYNC_OUT_EAGLE_ENABLED: 'true',
  SYNC_OUT_EAGLE_DOCUMENT_ENABLED: 'true',
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

/** A row sent before, whose last send left Eagle's copy at `published`. */
const sentRow = (published, overrides = {}) =>
  demiRow({ syncOut: { eagle: { status: 'sent', sentVersion: 1, published } }, ...overrides });

const SYNC_REPO = kindOf(DOCUMENT).repo;

/**
 * One row in Cosmos, whose replace honours IfMatch as Cosmos does: no etag, no check. `update` is the
 * engine's own etag-guarded write through the real repository.
 */
function wireStore(t, row) {
  const store = { row: { ...row, _etag: 'e1' }, writes: 0, etags: [] };
  t.mock.method(cosmos, 'readItem', async (container, id, pk) =>
    (container === 'documents' && id === store.row.id && pk === store.row.projectId ? structuredClone(store.row) : null));
  t.mock.method(cosmos, 'replace', async (_container, _id, _pk, item, etag) => {
    store.etags.push(etag);
    if (etag && etag !== store.row._etag) throw Object.assign(new Error('precondition'), { code: 412 });
    store.writes += 1;
    store.row = { ...structuredClone(item), _etag: `e${store.writes + 1}` };
    return structuredClone(store.row);
  });
  store.update = mutate => syncOut.updateRow(SYNC_REPO, store.row.id, store.row.projectId, mutate);
  return store;
}

/** Fake eagle-api and Keycloak; `routes` maps `METHOD path` to a reply, or a function returning one. */
function wireEagle(t, routes) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    if (url === `${ISSUER}/protocol/openid-connect/token`) return Response.json({ access_token: 'token', expires_in: 300 });
    const key = `${opts.method || 'GET'} ${url.slice(API.length)}`;
    calls.push({ key, body: opts.body ? JSON.parse(opts.body) : undefined });
    const route = routes[key];
    assert.ok(route, `unexpected eagle-api call ${key}`);
    const reply = typeof route === 'function' ? await route() : route;
    return Response.json(reply.body ?? {}, { status: reply.status || 200 });
  });
  return calls;
}

const GET = `GET /document/${EAGLE_ID}`;
const PUT = `PUT /document/${EAGLE_ID}`;
const PUBLISH = `PUT /document/${EAGLE_ID}/publish`;
const UNPUBLISH = `PUT /document/${EAGLE_ID}/unpublish`;
/** eagle-api's GET answers a list, `read` always projected. */
const eagleCopy = read => ({ body: [{ _id: EAGLE_ID, read }] });
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

  await t.test('a first send PUTs the DEMI fields and publishes when Eagle\'s copy is not public', async (tt) => {
    const store = wireStore(tt, demiRow());
    const calls = wireEagle(tt, { [GET]: eagleCopy(STAFF_ACL), [PUT]: {}, [PUBLISH]: {} });

    const result = await consumer.send(store.row, { update: store.update });

    assert.deepStrictEqual(keys(calls), [GET, PUT, PUBLISH]);
    assert.deepStrictEqual(calls[1].body, {
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
    assert.deepStrictEqual(store.row.syncOut.eagle, { status: 'sent', published: true }, 'claim released, level kept');
    assert.strictEqual(logged('info', `document ${ROW_ID} sent to Eagle`).length, 1);
  });

  await t.test('a document message runs through the document consumer and records the sent version', async (tt) => {
    const store = wireStore(tt, sentRow(true));
    const calls = wireEagle(tt, { [PUT]: {} });

    const result = await syncOut.run({ kind: DOCUMENT, consumer: 'eagle', id: ROW_ID, projectId: '1234', attempt: 1 });

    assert.deepStrictEqual(keys(calls), [PUT], 'not the comment period consumer, which shares the name');
    assert.deepStrictEqual(result, { status: 'sent', eagleId: EAGLE_ID });
    assert.strictEqual(store.row.syncOut.eagle.sentVersion, 2);
  });

  await t.test('a first send leaves Eagle\'s level alone when it already matches', async (tt) => {
    const store = wireStore(tt, demiRow({ read: STAFF_ACL, isPublished: false }));
    const calls = wireEagle(tt, { [GET]: eagleCopy(STAFF_ACL), [PUT]: {} });

    await consumer.send(store.row, { update: store.update });

    assert.deepStrictEqual(keys(calls), [GET, PUT], 'no unpublish, which would mark it Rejected');
    assert.strictEqual(store.row.syncOut.eagle.published, false);
  });

  await t.test('Eagle\'s raw copy at public with DEMI at staff unpublishes without asking Eagle first', async (tt) => {
    const store = wireStore(tt, demiRow({
      read: STAFF_ACL, isPublished: false, sources: { eagle: { _id: EAGLE_ID, read: PUBLIC_ACL } }
    }));
    const calls = wireEagle(tt, { [PUT]: {}, [UNPUBLISH]: {} });

    await consumer.send(store.row, { update: store.update });

    assert.deepStrictEqual(keys(calls), [PUT, UNPUBLISH]);
    assert.strictEqual(store.row.syncOut.eagle.published, false);
  });

  await t.test('Eagle\'s raw copy at DEMI\'s level wins over a stale stored level and PUTs only', async (tt) => {
    const store = wireStore(tt, sentRow(true, {
      read: STAFF_ACL, isPublished: false, sources: { eagle: { _id: EAGLE_ID, read: STAFF_ACL } }
    }));
    const calls = wireEagle(tt, { [PUT]: {} });

    await consumer.send(store.row, { update: store.update });

    assert.deepStrictEqual(keys(calls), [PUT], 'no unpublish, which would mark it Rejected');
  });

  await t.test('a first send to an Eagle id Eagle no longer holds fails before any PUT', async (tt) => {
    const store = wireStore(tt, demiRow());
    const calls = wireEagle(tt, { [GET]: { body: [] }, [PUT]: {} });

    await assert.rejects(consumer.send(store.row, { update: store.update }), /Eagle has no document/);

    assert.deepStrictEqual(keys(calls), [GET]);
    assert.strictEqual(store.row.syncOut.eagle.status, 'failed');
  });

  await t.test('a level unchanged since the last send PUTs only, with no comment period milestone set', async (tt) => {
    delete process.env.EAGLE_ENGAGE_MILESTONE;
    const store = wireStore(tt, sentRow(false, { read: STAFF_ACL, isPublished: false }));
    const calls = wireEagle(tt, { [PUT]: {} });

    await consumer.send(store.row, { update: store.update });

    assert.deepStrictEqual(keys(calls), [PUT]);
  });

  await t.test('a level that moved since the last send unpublishes', async (tt) => {
    const store = wireStore(tt, sentRow(true, { read: STAFF_ACL, isPublished: false }));
    const calls = wireEagle(tt, { [PUT]: {}, [UNPUBLISH]: {} });

    await consumer.send(store.row, { update: store.update });

    assert.deepStrictEqual(keys(calls), [PUT, UNPUBLISH]);
    assert.strictEqual(store.row.syncOut.eagle.published, false);
  });

  await t.test('fields cleared in DEMI that eagle-api cannot clear are named in one warn line', async (tt) => {
    const store = wireStore(tt, sentRow(true, {
      description: '', milestoneId: null, sortOrder: 0, projectPhaseId: null,
      sources: { eagle: { _id: EAGLE_ID, description: 'Old text', milestone: '5cf00c03a266b7e18775aa02', sortOrder: 0 } }
    }));
    wireEagle(tt, { [PUT]: {} });

    await consumer.send(store.row, { update: store.update });

    const warned = logged('warn', `document ${ROW_ID}: eagle-api cannot clear`);
    assert.strictEqual(warned.length, 1);
    assert.deepStrictEqual(warned[0].arguments[1].fields, ['description', 'milestoneId'],
      'not sortOrder or projectPhaseId, which Eagle never held either');
  });

  await t.test('a cleared field is not named when the row holds no Eagle raw copy', async (tt) => {
    const store = wireStore(tt, sentRow(true, { description: '' }));
    wireEagle(tt, { [PUT]: {} });

    await consumer.send(store.row, { update: store.update });

    assert.strictEqual(logged('info', `document ${ROW_ID} sent to Eagle`).length, 1);
    assert.strictEqual(logged('warn', 'eagle-api cannot clear').length, 0);
  });

  await t.test('a row without an eagleId, or one Eagle owns, is not wanted and sends nothing', async (tt) => {
    const calls = wireEagle(tt, {});
    const noId = wireStore(tt, demiRow({ eagleId: null }));

    assert.strictEqual(consumer.wants(noId.row), false);
    assert.strictEqual(consumer.wants(demiRow({ sourceSystem: 'eagle' })), false);
    assert.strictEqual(consumer.wants(demiRow()), true);
    assert.deepStrictEqual(await consumer.send(noId.row, { update: noId.update }), { status: 'skipped' });
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(noId.writes, 0);
  });

  await t.test('SYNC_OUT_EAGLE_DOCUMENT_ENABLED gates the consumer, not which rows it wants', () => {
    assert.strictEqual(consumer.enabled(), true);
    delete process.env.SYNC_OUT_EAGLE_DOCUMENT_ENABLED;

    assert.strictEqual(consumer.enabled(), false);
    assert.strictEqual(consumer.wants(demiRow()), true);
  });

  await t.test('a row Eagle deleted is not wanted and sends nothing', async (tt) => {
    const calls = wireEagle(tt, {});
    const store = wireStore(tt, demiRow({ syncOut: { eagle: { status: 'sent', sentVersion: 1, published: true, eagleDeleted: true } } }));

    assert.strictEqual(consumer.wants(store.row), false);
    assert.deepStrictEqual(await consumer.send(store.row, { update: store.update }), { status: 'skipped' });
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(store.writes, 0, 'no claim taken');
  });

  await t.test('two concurrent deliveries make one PUT', async (tt) => {
    const store = wireStore(tt, sentRow(false));
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
    assert.strictEqual(store.etags[0], 'e1', 'the claim write is guarded on the revision it read');
  });

  await t.test('a claim lost during the PUT stops the send before publish and leaves the new claim', async (tt) => {
    const store = wireStore(tt, sentRow(false));
    const foreign = { status: 'creating', claim: 'another-delivery', claimedAt: new Date().toISOString() };
    const calls = wireEagle(tt, {
      [PUT]: () => {
        store.row = { ...store.row, syncOut: { eagle: { ...store.row.syncOut.eagle, ...foreign } }, _etag: 'e-foreign' };
        return {};
      }
    });

    await assert.rejects(consumer.send(store.row, { update: store.update }), /taken by another delivery/);

    assert.deepStrictEqual(keys(calls), [PUT]);
    const entry = store.row.syncOut.eagle;
    assert.deepStrictEqual({ status: entry.status, claim: entry.claim, claimedAt: entry.claimedAt }, foreign);
  });

  await t.test('a failed PUT logs one error, releases the claim and publishes nothing', async (tt) => {
    const store = wireStore(tt, sentRow(false));
    const calls = wireEagle(tt, { [PUT]: { status: 500, body: { message: 'down' } } });

    await assert.rejects(consumer.send(store.row, { update: store.update }), /HTTP 500/);

    assert.deepStrictEqual(keys(calls), [PUT]);
    assert.deepStrictEqual(store.row.syncOut.eagle, { status: 'failed', sentVersion: 1, published: false });
    assert.strictEqual(logged('error', `document ${ROW_ID} not sent`).length, 1);
  });
});
