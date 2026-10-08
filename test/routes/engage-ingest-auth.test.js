'use strict';

/**
 * Who may call the ENGAGE ingest, PUT /engage/engagements/:engagementId, end to end through the
 * dispatcher. The handler writes any project through systemAccess(), so only ENGAGE, as the APIM
 * principal `apim:engage`, gets through; eagle-api's own principal is refused here as ENGAGE's is
 * refused on the Eagle mirror.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

const config = require('../../src/config');
const engageController = require('../../src/controllers/nosql/engage-comment-period');
const organizationController = require('../../src/controllers/nosql/organization');
const commentPeriods = require('../../src/repositories/comment-periods');
const notifications = require('../../src/repositories/notifications');
const projects = require('../../src/repositories/projects');
const syncOut = require('../../src/sync-out');
const { withServer } = require('../helpers/with-server');
const { setEnv, gatewayCaller, stubRegistry } = require('../helpers/registry-callers');
const { PROJECT_EAGLE_ID, storedProject } = require('../helpers/eagle-mirror-fixtures');

const ROUTE = '/api/engage/engagements/42';
const BODY = {
  pushedAt: '2026-10-08T17:00:00.000Z',
  engagement: {
    id: 42, name: 'Have your say', projectId: PROJECT_EAGLE_ID, isPublished: true,
    metURL: 'https://engage.example/have-your-say', start: '2026-10-10T07:00:00.000Z'
  }
};

function stubHandler(t) {
  const reached = { count: 0 };
  t.mock.method(engageController, 'upsertFromEngage', (req, res) => {
    reached.count++;
    res.json({ reached: true });
  });
  return reached;
}

async function put(path, headers, body = BODY) {
  let result;
  await withServer(async (call) => {
    const res = await call(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    });
    result = { status: res.status, body: await res.json() };
  });
  return result;
}

test('the ENGAGE ingest admits ENGAGE and nobody else', async (t) => {
  t.beforeEach((t) => setEnv(t, 'DEMI_ENGAGE_PRINCIPALS', undefined));
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a Keycloak token is refused, even one claiming keyId apim:engage', async (t) => {
    const reached = stubHandler(t);
    const keycloakEnabled = config.keycloakEnabled;
    config.keycloakEnabled = false;
    t.after(() => { config.keycloakEnabled = keycloakEnabled; });
    const token = jwt.sign({
      preferred_username: 'key:engage', keyId: 'apim:engage', realm_access: { roles: ['staff', 'demi-service-write'] }
    }, 'suite-only');

    assert.strictEqual((await put(ROUTE, { authorization: `Bearer ${token}` })).status, 403);
    assert.strictEqual(reached.count, 0);
  });

  await t.test('the Eagle mirror principal is refused', async (t) => {
    const reached = stubHandler(t);
    const eagleApi = gatewayCaller(t, 'eagle-api', ['demi-service-write']);
    stubRegistry(t, [eagleApi.row]);

    assert.strictEqual((await put(ROUTE, eagleApi.headers)).status, 403);
    assert.strictEqual(reached.count, 0);
  });

  await t.test('apim:engage is refused on the Eagle mirror', async (t) => {
    t.mock.method(organizationController, 'upsertFromEagle', (req, res) => res.json({}));
    const engage = gatewayCaller(t, 'engage', ['demi-service-write']);
    stubRegistry(t, [engage.row]);

    const res = await put('/api/eagle/organizations/5c1f7a3e9b1d2c0012345678', engage.headers,
      { doc: { _id: '5c1f7a3e9b1d2c0012345678' } });
    assert.strictEqual(res.status, 403);
  });

  await t.test('apim:engage is refused when its row carries a project scope', async (t) => {
    const reached = stubHandler(t);
    const engage = gatewayCaller(t, 'engage', ['demi-service-write'], ['207']);
    stubRegistry(t, [engage.row]);

    assert.strictEqual((await put(ROUTE, engage.headers)).status, 403);
    assert.strictEqual(reached.count, 0);
  });

  await t.test('an empty DEMI_ENGAGE_PRINCIPALS refuses ENGAGE too', async (t) => {
    const reached = stubHandler(t);
    setEnv(t, 'DEMI_ENGAGE_PRINCIPALS', '');
    const engage = gatewayCaller(t, 'engage', ['demi-service-write']);
    stubRegistry(t, [engage.row]);

    assert.strictEqual((await put(ROUTE, engage.headers)).status, 403);
    assert.strictEqual(reached.count, 0);
  });

  await t.test('apim:engage with demi-service-write reaches the handler by default', async (t) => {
    const reached = stubHandler(t);
    const engage = gatewayCaller(t, 'engage', ['demi-service-write']);
    stubRegistry(t, [engage.row]);

    assert.strictEqual((await put(ROUTE, engage.headers)).status, 200);
    assert.strictEqual(reached.count, 1);
  });

  await t.test('a new engagement through the dispatcher is stored, answered 201 and queued', async (t) => {
    const engage = gatewayCaller(t, 'engage', ['demi-service-write']);
    stubRegistry(t, [engage.row]);
    t.mock.method(projects, 'getByEagleId', async () => storedProject());
    t.mock.method(projects, 'readForWriteByEagleId', async () => null);
    t.mock.method(notifications, 'readForWrite', async () => null);
    t.mock.method(commentPeriods, 'readForWriteByEngagementId', async () => null);
    t.mock.method(commentPeriods, 'readForWrite', async () => null);
    const stored = [];
    t.mock.method(commentPeriods, 'upsert', async (item) => { stored.push(item); return item; });
    const queued = [];
    t.mock.method(syncOut, 'enqueue', async (row) => { queued.push(row.id); return ['eagle']; });

    const res = await put(ROUTE, engage.headers);

    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.queued, ['eagle']);
    assert.deepStrictEqual(stored.map(r => r.id), ['engage-42']);
    assert.deepStrictEqual(queued, ['engage-42']);
  });
});
