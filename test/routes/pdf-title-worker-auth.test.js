'use strict';

/**
 * Who may call the PDF title worker routes. They read rows unfiltered and sign reads and writes of
 * stored originals, so only a named registry principal with demi-service-write and no project
 * scope gets through; the list is empty unless DEMI_PDF_TITLE_WORKER_PRINCIPALS names one.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

const config = require('../../src/config');
const controller = require('../../src/controllers/nosql/pdf-title');
const { withServer } = require('../helpers/with-server');
const { setEnv, presentedKey, stubRegistry } = require('../helpers/registry-callers');

const ROUTES = [
  ['GET', '/api/documents/pdf-title/pending', 'listPending'],
  ['POST', '/api/documents/pdf-title/sweep', 'sweep'],
  ['POST', '/api/documents/d1/pdf-title/lease', 'lease'],
  ['POST', '/api/documents/d1/pdf-title/commit', 'commit'],
  ['PUT', '/api/documents/d1/pdf-title', 'report']
];

function stubAll(t) {
  const reached = [];
  for (const [, , name] of ROUTES) {
    t.mock.method(controller, name, (req, res) => { reached.push(name); res.json({}); });
  }
  return reached;
}

async function callAll(headers) {
  const statuses = [];
  await withServer(async (call) => {
    for (const [method, path] of ROUTES) {
      const res = await call(path, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: method === 'GET' ? undefined : '{}'
      });
      statuses.push(res.status);
    }
  });
  return statuses;
}

test('the PDF title routes admit only the named worker principal', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('an anonymous caller gets 401', async (t) => {
    const reached = stubAll(t);
    assert.deepStrictEqual(await callAll({}), [401, 401, 401, 401, 401]);
    assert.deepStrictEqual(reached, []);
  });

  await t.test('a staff login is refused', async (t) => {
    const reached = stubAll(t);
    const keycloakEnabled = config.keycloakEnabled;
    config.keycloakEnabled = false;
    t.after(() => { config.keycloakEnabled = keycloakEnabled; });
    const token = jwt.sign({ preferred_username: 'idir-staff', realm_access: { roles: ['staff'] } }, 'suite-only');

    assert.deepStrictEqual(await callAll({ authorization: `Bearer ${token}` }), [403, 403, 403, 403, 403]);
    assert.deepStrictEqual(reached, []);
  });

  await t.test('a project-scoped key named in the list is refused', async (t) => {
    const reached = stubAll(t);
    const scoped = presentedKey('pdf-title-worker', ['demi-service-write'], ['207']);
    setEnv(t, 'DEMI_PDF_TITLE_WORKER_PRINCIPALS', scoped.row.id);
    stubRegistry(t, [scoped.row]);

    assert.deepStrictEqual(await callAll(scoped.headers), [403, 403, 403, 403, 403]);
    assert.deepStrictEqual(reached, []);
  });

  await t.test('a demi-service-write key not in the list is refused', async (t) => {
    const reached = stubAll(t);
    const extractor = presentedKey('extractor', ['demi-service-write']);
    setEnv(t, 'DEMI_PDF_TITLE_WORKER_PRINCIPALS', 'some-other-id');
    stubRegistry(t, [extractor.row]);

    assert.deepStrictEqual(await callAll(extractor.headers), [403, 403, 403, 403, 403]);
    assert.deepStrictEqual(reached, []);
  });

  await t.test('with the setting unset nobody gets through', async (t) => {
    const reached = stubAll(t);
    const worker = presentedKey('pdf-title-worker', ['demi-service-write']);
    setEnv(t, 'DEMI_PDF_TITLE_WORKER_PRINCIPALS', undefined);
    stubRegistry(t, [worker.row]);

    assert.deepStrictEqual(await callAll(worker.headers), [403, 403, 403, 403, 403]);
    assert.deepStrictEqual(reached, []);
  });

  await t.test('the named unscoped writer reaches every handler', async (t) => {
    const reached = stubAll(t);
    const worker = presentedKey('pdf-title-worker', ['demi-service-write']);
    setEnv(t, 'DEMI_PDF_TITLE_WORKER_PRINCIPALS', worker.row.id);
    stubRegistry(t, [worker.row]);

    assert.deepStrictEqual(await callAll(worker.headers), [200, 200, 200, 200, 200]);
    assert.deepStrictEqual(reached, ['listPending', 'sweep', 'lease', 'commit', 'report']);
  });
});
