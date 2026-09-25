'use strict';

/**
 * Who may write the Eagle mirror, PUT /eagle/*, run end to end through the dispatcher.
 *
 * The mirror handlers write any project through systemAccess(), so the route chain is the only
 * thing between a caller and every mirrored row. `demi-service-write` is not enough on its own:
 * the extractor holds it and a sysadmin can mint more. Only eagle-api, as the APIM principal
 * `apim:eagle-api`, gets through. The route checks the same chain on all eight paths
 * (test/helpers/access-coverage.test.js), so one path stands in for all of them here.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

const config = require('../../src/config');
const organizationController = require('../../src/controllers/nosql/organization');
const { logger } = require('../../src/utils/logger');
const { withServer } = require('../helpers/with-server');
const { setEnv, presentedKey, gatewayCaller, stubRegistry } = require('../helpers/registry-callers');

const ROUTE = '/api/eagle/organizations/5c1f7a3e9b1d2c0012345678';
const BREAK_GLASS = 'break-glass-for-this-suite';

/** Stand-in for the mirror handler: the test sees whether the chain let the request through. */
function stubMirror(t) {
  const reached = { count: 0 };
  t.mock.method(organizationController, 'upsertFromEagle', (req, res) => {
    reached.count++;
    res.json({ reached: true });
  });
  return reached;
}

async function push(headers) {
  let result;
  await withServer(async (call) => {
    const res = await call(ROUTE, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ doc: { _id: '5c1f7a3e9b1d2c0012345678', name: 'Org' } })
    });
    result = { status: res.status, body: await res.json() };
  });
  return result;
}

test('the Eagle mirror admits eagle-api and nobody else', async (t) => {
  t.beforeEach((t) => setEnv(t, 'DEMI_EAGLE_MIRROR_PRINCIPALS', undefined));
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a staff user is refused', async (t) => {
    const reached = stubMirror(t);
    const keycloakEnabled = config.keycloakEnabled;
    config.keycloakEnabled = false;
    t.after(() => { config.keycloakEnabled = keycloakEnabled; });
    const token = jwt.sign(
      { preferred_username: 'idir-staff', realm_access: { roles: ['staff'] } }, 'suite-only'
    );

    const res = await push({ authorization: `Bearer ${token}` });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(reached.count, 0);
  });

  await t.test('a token claiming keyId apim:eagle-api and demi-service-write is refused', async (t) => {
    // A token's claims become req.user wholesale, so a claim must not be able to name a principal.
    const reached = stubMirror(t);
    const keycloakEnabled = config.keycloakEnabled;
    config.keycloakEnabled = false;
    t.after(() => { config.keycloakEnabled = keycloakEnabled; });
    const token = jwt.sign({
      preferred_username: 'key:eagle-api',
      keyId: 'apim:eagle-api',
      realm_access: { roles: ['demi-service-write'] }
    }, 'suite-only');

    const res = await push({ authorization: `Bearer ${token}` });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(reached.count, 0);
  });

  await t.test('the break-glass ADMIN_API_KEY is refused', async (t) => {
    const reached = stubMirror(t);
    setEnv(t, 'ADMIN_API_KEY', BREAK_GLASS);

    const res = await push({ 'x-api-key': BREAK_GLASS });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(reached.count, 0);
  });

  await t.test('the extractor key is refused, though it holds demi-service-write', async (t) => {
    const reached = stubMirror(t);
    const extractor = presentedKey('extractor', ['demi-service-write']);
    stubRegistry(t, [extractor.row]);

    const res = await push(extractor.headers);

    assert.strictEqual(res.status, 403);
    assert.strictEqual(reached.count, 0);
  });

  await t.test('a demi-service-write key a sysadmin mints is refused', async (t) => {
    const reached = stubMirror(t);
    setEnv(t, 'ADMIN_API_KEY', BREAK_GLASS);
    stubRegistry(t);
    let minted;
    await withServer(async (call) => {
      const res = await call('/api/admin/api-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': BREAK_GLASS },
        body: JSON.stringify({ name: 'second-writer', roles: ['demi-service-write'], allowWrite: true })
      });
      assert.strictEqual(res.status, 201);
      minted = (await res.json()).key;
    });

    const res = await push({ 'x-api-key': minted });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(reached.count, 0);
  });

  await t.test('a project-scoped demi-service-write key is refused', async (t) => {
    const reached = stubMirror(t);
    const scoped = presentedKey('scoped-writer', ['demi-service-write'], ['207']);
    stubRegistry(t, [scoped.row]);

    const res = await push(scoped.headers);

    assert.strictEqual(res.status, 403);
    assert.strictEqual(reached.count, 0);
  });

  await t.test('eagle-api itself is refused when its row carries a project scope', async (t) => {
    const reached = stubMirror(t);
    const eagleApi = gatewayCaller(t, 'eagle-api', ['demi-service-write'], ['207']);
    stubRegistry(t, [eagleApi.row]);

    const res = await push(eagleApi.headers);

    assert.strictEqual(res.status, 403);
    assert.strictEqual(reached.count, 0);
  });

  await t.test('eagle-api is refused when its row holds staff instead of demi-service-write', async (t) => {
    const reached = stubMirror(t);
    const eagleApi = gatewayCaller(t, 'eagle-api', ['staff']);
    stubRegistry(t, [eagleApi.row]);

    const res = await push(eagleApi.headers);

    assert.strictEqual(res.status, 403);
    assert.strictEqual(reached.count, 0);
  });

  await t.test('another APIM subscription with demi-service-write is refused', async (t) => {
    const reached = stubMirror(t);
    const other = gatewayCaller(t, 'other-app', ['demi-service-write']);
    stubRegistry(t, [other.row]);

    const res = await push(other.headers);

    assert.strictEqual(res.status, 403);
    assert.strictEqual(reached.count, 0);
  });

  await t.test('apim:eagle-api with demi-service-write reaches the handler by default', async (t) => {
    const reached = stubMirror(t);
    const eagleApi = gatewayCaller(t, 'eagle-api', ['demi-service-write']);
    stubRegistry(t, [eagleApi.row]);

    const res = await push(eagleApi.headers);

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(reached.count, 1);
  });

  await t.test('an empty DEMI_EAGLE_MIRROR_PRINCIPALS refuses eagle-api too', async (t) => {
    const reached = stubMirror(t);
    setEnv(t, 'DEMI_EAGLE_MIRROR_PRINCIPALS', '');
    const eagleApi = gatewayCaller(t, 'eagle-api', ['demi-service-write']);
    stubRegistry(t, [eagleApi.row]);

    const res = await push(eagleApi.headers);

    assert.strictEqual(res.status, 403);
    assert.strictEqual(reached.count, 0);
  });

  await t.test('DEMI_EAGLE_MIRROR_PRINCIPALS replaces the default principal', async (t) => {
    const reached = stubMirror(t);
    setEnv(t, 'DEMI_EAGLE_MIRROR_PRINCIPALS', 'apim:other-app');
    const other = gatewayCaller(t, 'other-app', ['demi-service-write']);
    stubRegistry(t, [other.row]);

    const res = await push(other.headers);

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(reached.count, 1);
  });

  await t.test('a presented registry key named in the list reaches the handler', async (t) => {
    const reached = stubMirror(t);
    const writer = presentedKey('eagle-push', ['demi-service-write']);
    setEnv(t, 'DEMI_EAGLE_MIRROR_PRINCIPALS', writer.row.id);
    stubRegistry(t, [writer.row]);

    const res = await push(writer.headers);

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(reached.count, 1);
  });

  await t.test('a refusal answers the usual error body and logs principal and route', async (t) => {
    stubMirror(t);
    const warnings = [];
    t.mock.method(logger, 'warn', (line) => { warnings.push(String(line)); });
    const extractor = presentedKey('extractor', ['demi-service-write']);
    stubRegistry(t, [extractor.row]);

    const res = await push(extractor.headers);

    assert.match(res.body.error, /^Forbidden\./);
    const refusal = warnings.find(line => line.includes('Eagle mirror refused'));
    assert.ok(refusal, `no refusal warning among: ${warnings.join(' | ')}`);
    assert.ok(refusal.includes(extractor.row.id), refusal);
    assert.ok(refusal.includes(`PUT ${ROUTE}`), refusal);
    assert.ok(!refusal.includes(extractor.headers['x-api-key']), 'the key itself must never be logged');
  });
});
