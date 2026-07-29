'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const apiRoutes = require('../../src/routes/api');

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
    const protectedPaths = ['/db/stats', '/db/seed', '/sync', '/admin/sync', '/admin/seed-track'];
    const routes = routeTable();

    for (const path of protectedPaths) {
      const match = routes.find(r => r.path === path);
      assert.ok(match, `Route ${path} must exist on API router`);
      // authMiddleware + controller handler = at least 2 layers
      assert.ok(match.middlewareCount >= 2, `Route ${path} must be protected by authMiddleware`);
    }
  });

  await t.test('generic query/import endpoints stay deleted', () => {
    // POST /db/query and /db/import were an arbitrary-query and bulk-write surface over any
    // collection. Nothing called them, and under the NoSQL API they would have to become a
    // SQL passthrough — exactly the fail-open shape this codebase already shipped once.
    // /db/seed-boundaries went with the dead boundary seeder.
    const removed = ['/db/query', '/db/import', '/db/seed-boundaries'];
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
