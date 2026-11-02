'use strict';

// Organizations created in DEMI, sent to Eagle through the real lists adapter over an in-memory container.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const audit = require('../../src/utils/audit');
const { logger } = require('../../src/utils/logger');
const syncOut = require('../../src/sync-out');
const eagle = require('../../src/sync-out/eagle');
const { ORGANIZATION } = require('../../src/sync-out/kinds');
const organizationController = require('../../src/controllers/nosql/organization');
const { mirrorStore } = require('../helpers/mirror-store');
const { mockRes, STAFF, PUBLIC_ACL, PRIVATE_ACL, eagleOrganization } = require('../helpers/eagle-mirror-fixtures');
const { API, useEnv, wireQueue, wireEagle, keys } = require('../helpers/sync-out-eagle');

audit._setTransport(async () => {});

const ROW_ID = '7d1e2f40-0000-4000-8000-0000000000aa';
const EAGLE_ID = '6720b3c0a1b2c3d4e5f60718';
const OBJECT_ID = /^[0-9a-f]{24}$/;

const ENV = {
  SYNC_OUT_QUEUE: 'sync-out',
  SYNC_OUT_EAGLE_ENABLED: 'true',
  SYNC_OUT_EAGLE_ORGANIZATION_ENABLED: 'true',
  SYNC_OUT_EAGLE_NATIVE_ENABLED: 'true',
  EAGLE_PROTECTED_API_BASE: API,
  EAGLE_KC_CLIENT_ID: 'demi-sync-out',
  EAGLE_KC_CLIENT_SECRET: 'not-a-real-value'
};

/** An organization as `domain/organizations.js` creates it, after one write. */
function nativeOrg(overrides = {}) {
  return {
    container: 'lists',
    id: ROW_ID,
    kind: 'Organization',
    sourceSystem: 'demi',
    eagleId: null,
    syncVersion: 1,
    name: 'Nicomen Energy Ltd',
    companyType: 'Proponent',
    city: 'Merritt',
    parentCompany: null,
    isPublished: true,
    read: [...PUBLIC_ACL],
    ...overrides
  };
}

// Org messages carry no projectId: the adapter must read the row by its kind's partition.
const message = (overrides = {}) =>
  ({ kind: ORGANIZATION, consumer: 'eagle', id: ROW_ID, projectId: null, attempt: 1, ...overrides });
const run = (msg = message(), maxAttempts = 3) => syncOut.run(msg, { maxAttempts });
const accept = body => ({ body: { ...body, _id: body._id } });
const logged = (level, text) => logger[level].mock.calls.filter(c => String(c.arguments[0]).includes(text));
const rowOf = store => store.rows('lists').find(r => r.id === ROW_ID);

test('sync-out of DEMI-created organizations', async (t) => {
  t.beforeEach((tt) => {
    useEnv(tt, ENV);
    eagle.clearToken();
    for (const level of ['info', 'warn', 'error']) tt.mock.method(logger, level, () => {});
  });

  await t.test('the echo of the create lands on the row and leaves its fields and sync state alone', async (tt) => {
    const store = mirrorStore(tt, [nativeOrg()]);
    const sent = wireQueue(tt);
    let echo = null;
    let before = null;
    let echoed = null;
    const calls = wireEagle(tt, {
      // eagle-api awaits its push to DEMI before it answers the POST.
      'POST /organization': async (body) => {
        before = rowOf(store);
        echo = mockRes();
        await organizationController.upsertFromEagle({
          params: { eagleId: body._id }, query: {}, user: STAFF,
          body: { doc: eagleOrganization({ ...body, read: PUBLIC_ACL }), pushedAt: Date.now() }
        }, echo);
        echoed = rowOf(store);
        return accept(body);
      }
    });

    const result = await run();

    const posted = calls[0].body._id;
    assert.match(posted, OBJECT_ID);
    assert.strictEqual(echo.statusCode, 200, 'the echo is accepted');
    const { sources, _etag, eaglePushedAt: _pushedAt, ...fields } = echoed;
    const { sources: _s, _etag: _e, ...was } = before;
    assert.deepStrictEqual(fields, was, 'the echo changed no DEMI field, syncOut or syncVersion');
    assert.strictEqual(sources.eagle._id, posted, 'the echo landed on this row');
    assert.strictEqual(store.rows('lists').length, 1, 'the echo made no second row');
    assert.strictEqual(result.eagleId, posted);
    assert.strictEqual(rowOf(store).syncOut.eagle.sentVersion, 1);
    assert.deepStrictEqual(sent, [], 'the echo queues nothing');

    const again = wireEagle(tt, {});
    assert.deepStrictEqual(await run(), { skipped: 'current' });
    assert.deepStrictEqual(again, [], 'no second send');
  });

  await t.test('a PUT answered 200 with no body is read as missing, warned, and POSTs the same id', async (tt) => {
    const store = mirrorStore(tt, [nativeOrg({ eagleId: EAGLE_ID })]);
    wireQueue(tt);
    const put = `PUT /organization/${EAGLE_ID}`;
    const calls = wireEagle(tt, { [put]: { body: null }, 'POST /organization': accept });

    const result = await run();

    assert.deepStrictEqual(keys(calls), [put, 'POST /organization']);
    assert.strictEqual(calls[1].body._id, EAGLE_ID);
    assert.strictEqual(calls[1].body.name, 'Nicomen Energy Ltd');
    assert.strictEqual(logged('warn', 'answered 200 with no organization').length, 1);
    assert.deepStrictEqual(result, { status: 'sent', eagleId: EAGLE_ID });
    assert.strictEqual(rowOf(store).syncOut.eagle.status, 'sent');
  });

  await t.test('a staff-only organization is unpublished after its create', async (tt) => {
    mirrorStore(tt, [nativeOrg({ isPublished: false, read: [...PRIVATE_ACL] })]);
    wireQueue(tt);
    const calls = wireEagle(tt, { 'POST /organization': accept, 'PUT *': {} });

    await run();

    const posted = calls[0].body._id;
    assert.deepStrictEqual(keys(calls), ['POST /organization', `PUT /organization/${posted}/unpublish`]);
  });

  await t.test('an id already held by an Eagle-owned mirror row is refused before any POST', async (tt) => {
    const store = mirrorStore(tt, [
      nativeOrg({ eagleId: EAGLE_ID }),
      { container: 'lists', id: EAGLE_ID, eagleId: EAGLE_ID, kind: 'Organization', sourceSystem: 'eagle', read: PUBLIC_ACL }
    ]);
    wireQueue(tt);
    const calls = wireEagle(tt, { [`PUT /organization/${EAGLE_ID}`]: { body: null } });

    await run(message(), 1);

    assert.deepStrictEqual(keys(calls), [`PUT /organization/${EAGLE_ID}`], 'no POST');
    assert.strictEqual(rowOf(store).syncOut.eagle.status, 'failed');
    assert.strictEqual(logged('error', 'is already an Eagle-owned DEMI row').length, 1);
  });
});
