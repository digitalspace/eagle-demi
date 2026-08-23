'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const apiRoutes = require('../../src/routes/api');
const { routeChains } = require('../helpers/router-source');

function routeTable() {
  return apiRoutes.stack
    .filter(layer => layer.route)
    .map(layer => ({
      path: layer.route.path,
      middlewareCount: layer.route.stack.length
    }));
}

test('DB Management Routes Security Tests', async (t) => {
  await t.test('admin DB routes exist and are behind authMiddleware', () => {
    // TWO assertions per route, and they are complementary rather than redundant — each catches a
    // downgrade the other misses, and only together do they cover every way the gate can go.
    //
    //   the NAME, from source: a layer count of 2 is equally satisfied by passiveAuthMiddleware,
    //   which attaches an anonymous access object instead of rejecting. Swapping it in would make
    //   /db/stats and /admin/index-progress anonymously readable under a green count.
    //
    //   the COUNT, at runtime: source text includes comments, so deleting the middleware and
    //   leaving its name in a comment beside the handler satisfies the name check while the route
    //   runs with one layer and no auth. routeChains() strips comments, which closes that on its
    //   own; the count stays because a security assertion is worth two independent readings of the
    //   same fact, and because the count is what fails if the stripper ever regresses.
    const protectedPaths = ['/db/stats', '/admin/index-progress'];
    const routes = routeTable();
    const chains = routeChains();

    for (const p of protectedPaths) {
      const match = routes.find(r => r.path === p);
      assert.ok(match, `Route ${p} must exist on API router`);
      // authMiddleware + controller handler = at least 2 layers
      assert.ok(
        match.middlewareCount >= 2,
        `Route ${p} runs ${match.middlewareCount} layer(s) — no middleware stands in front of the ` +
        'controller, whatever the source says'
      );

      const declared = chains.find(r => r.path === p);
      assert.ok(declared, `Route ${p} must be declared in src/routes/api.js`);
      assert.ok(
        /\bauthMiddleware\b/.test(declared.chain) &&
        !/\bpassiveAuthMiddleware\b/.test(declared.chain),
        `Route ${p} must be behind authMiddleware, not passiveAuthMiddleware — its chain is ` +
        `"${declared.chain.trim()}"`
      );
    }
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
    // /records, /records/:id and /admin/sync/nrpti went with the whole NRPTI feature: the link to
    // a project was never redesigned, so the ingest was removed rather than narrowed. Listed here
    // so a reintroduction is a deliberate act rather than an accident.
    const removed = [
      '/db/query', '/db/import', '/db/seed-boundaries',
      '/db/seed', '/sync', '/admin/sync', '/admin/seed-track',
      '/admin/logs', '/wildfires',
      '/records', '/records/:id', '/admin/sync/nrpti'
    ];
    const paths = routeTable().map(r => r.path);

    for (const path of removed) {
      assert.ok(!paths.includes(path), `Route ${path} must NOT be reintroduced`);
    }
  });

  await t.test('region routes stay deleted', () => {
    // The regions collection is empty and nothing consumed it; administrative geography is
    // served by /boundaries.
    const paths = routeTable().map(r => r.path);
    assert.ok(!paths.some(p => p.startsWith('/regions')), 'No /regions route should exist');
  });
});
