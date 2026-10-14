'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const config = require('../../src/config');
const apiRoutes = require('../../src/http/routes');
const dbController = require('../../src/controllers/db');
const { withServer } = require('../helpers/with-server');

const routePaths = () => apiRoutes.map(route => route.path);

const PROTECTED = [
  ['/api/db/stats', 'getDbStats'],
  ['/api/admin/index-progress', 'getIndexProgressHandler']
];

async function callProtected(t, headers) {
  const reached = [];
  for (const [, name] of PROTECTED) {
    t.mock.method(dbController, name, (req, res) => { reached.push(name); res.json({}); });
  }
  const statuses = [];
  await withServer(async (call) => {
    for (const [path] of PROTECTED) statuses.push((await call(path, { headers })).status);
  });
  return { statuses, reached };
}

function bearer(t, roles) {
  const keycloakEnabled = config.keycloakEnabled;
  config.keycloakEnabled = false;
  t.after(() => { config.keycloakEnabled = keycloakEnabled; });
  const token = jwt.sign({ preferred_username: 'suite-user', realm_access: { roles } }, 'suite-only');
  return { authorization: `Bearer ${token}` };
}

test('DB Management Routes Security Tests', async (t) => {
  await t.test('admin DB routes answer 401 to an anonymous caller', async (t) => {
    const { statuses, reached } = await callProtected(t, {});
    assert.deepStrictEqual(statuses, [401, 401]);
    assert.deepStrictEqual(reached, []);
  });

  await t.test('admin DB routes answer 403 to a login without a session role', async (t) => {
    const { statuses, reached } = await callProtected(t, bearer(t, ['public']));
    assert.deepStrictEqual(statuses, [403, 403]);
    assert.deepStrictEqual(reached, []);
  });

  await t.test('admin DB routes reach the controller for a staff login', async (t) => {
    const { statuses, reached } = await callProtected(t, bearer(t, ['staff']));
    assert.deepStrictEqual(statuses, [200, 200]);
    assert.deepStrictEqual(reached, ['getDbStats', 'getIndexProgressHandler']);
  });

  await t.test('generic query/import endpoints stay deleted', () => {
    // POST /db/query and /db/import were an arbitrary-query and bulk-write surface over any
    // collection. Nothing called them, and under the NoSQL API they would have to become a
    // SQL passthrough — exactly the fail-open shape this codebase already shipped once.
    // /db/seed-boundaries went with the dead boundary seeder.
    //
    // /db/seed, /sync, /admin/sync and /admin/seed-track went with the Mongo-era scripts they
    // drove. seed-nosql.js replaces them and runs inside the network — a 60k-document seed
    // outlives the request, so reintroducing the route would only produce timeouts.
    // /admin/logs and /wildfires went with the Cosmos log transport and the unused read path.
    // The three record-ingest routes went with that feature whole: the link to a project was never
    // redesigned, so the ingest was removed rather than narrowed. Listed here so a reintroduction
    // is a deliberate act rather than an accident.
    const removed = [
      '/db/query', '/db/import', '/db/seed-boundaries',
      '/db/seed', '/sync', '/admin/sync', '/admin/seed-track',
      '/admin/logs', '/wildfires',
      '/records', '/records/:id', '/admin/sync/nrpti'
    ];
    const paths = routePaths();

    for (const path of removed) {
      assert.ok(!paths.includes(path), `Route ${path} must NOT be reintroduced`);
    }
  });

  await t.test('region routes stay deleted', () => {
    // The regions collection is empty and nothing consumed it; administrative geography is
    // served by /boundaries.
    const paths = routePaths();
    assert.ok(!paths.some(p => p.startsWith('/regions')), 'No /regions route should exist');
  });
});
