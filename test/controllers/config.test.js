'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const configRepository = require('../../src/repositories/config');
const configController = require('../../src/controllers/config');

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };
}

const REQ = { query: {}, params: {}, body: {} };

test('config controller', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('serves app settings when the container is empty', async () => {
    t.mock.method(configRepository, 'get', async () => null);
    const res = mockRes();

    await configController.getConfig(REQ, res);

    assert.equal(res.body.configEndpoint, true);
    assert.ok(res.body.ENVIRONMENT, 'ENVIRONMENT still answered from app settings');
    assert.ok(res.body.API_PATH, 'API_PATH still answered from app settings');
    assert.ok('BUILD_ID' in res.body);
  });

  await t.test('serves app settings when Cosmos is unreachable', async () => {
    t.mock.method(configRepository, 'get', async () => { throw new Error('private endpoint down'); });
    const res = mockRes();

    await configController.getConfig(REQ, res);

    // A database outage must not take the frontend down — this endpoint was a non-DB route
    // before and has to degrade to what it used to return.
    assert.equal(res.body.configEndpoint, true);
    assert.ok(res.body.KEYCLOAK_URL);
  });

  await t.test('stored values override app settings', async () => {
    t.mock.method(configRepository, 'get', async () => ({
      id: 'config',
      ENVIRONMENT: 'test',
      BANNER_COLOUR: 'orange'
    }));
    const res = mockRes();

    await configController.getConfig(REQ, res);

    assert.equal(res.body.ENVIRONMENT, 'test');
    assert.equal(res.body.BANNER_COLOUR, 'orange');
  });

  await t.test('a stored false boolean is honoured, not treated as absent', async () => {
    t.mock.method(configRepository, 'get', async () => ({
      id: 'config',
      KEYCLOAK_ENABLED: false,
      USE_MOCK_DATA: true
    }));
    const res = mockRes();

    await configController.getConfig(REQ, res);

    assert.equal(res.body.KEYCLOAK_ENABLED, false);
    assert.equal(res.body.USE_MOCK_DATA, true);
  });

  await t.test("the string 'True' does not switch a boolean on", async () => {
    // The string(bool) trap: Bicep emits 'True', a comparison against 'true' reads false, and the
    // feature is silently off. Only a real boolean is accepted from the document.
    t.mock.method(configRepository, 'get', async () => ({ id: 'config', KEYCLOAK_ENABLED: 'False' }));
    const res = mockRes();

    await configController.getConfig(REQ, res);

    assert.equal(typeof res.body.KEYCLOAK_ENABLED, 'boolean');
    assert.notEqual(res.body.KEYCLOAK_ENABLED, 'False');
  });

  await t.test('API_LOCATION defaults to same-origin, set or not', async () => {
    // Azure drops empty-valued app settings from the env, so absent and '' must both mean
    // same-origin /api — an absolute dev default here would pull clients off the edge.
    t.mock.method(configRepository, 'get', async () => null);
    for (const setup of [() => { delete process.env.API_LOCATION; }, () => { process.env.API_LOCATION = ''; }]) {
      setup();
      const res = mockRes();
      await configController.getConfig(REQ, res);
      assert.equal(res.body.API_LOCATION, '');
    }
    delete process.env.API_LOCATION;
  });

  await t.test('the document cannot introduce or override non-overridable keys', async () => {
    t.mock.method(configRepository, 'get', async () => ({
      id: 'config',
      API_LOCATION: 'https://attacker.example.com',
      API_PATH: '/evil',
      BUILD_ID: 'forged',
      COSMOS_KEY: 'hunter2'
    }));
    const res = mockRes();

    await configController.getConfig(REQ, res);

    assert.notEqual(res.body.API_LOCATION, 'https://attacker.example.com');
    assert.notEqual(res.body.API_PATH, '/evil');
    assert.notEqual(res.body.BUILD_ID, 'forged');
    assert.ok(!('COSMOS_KEY' in res.body));
  });
});
