'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const chunkQuery = require('../../src/search/chunk-query');
const aiSearch = require('../../src/search/ai-search');
const documentsRepo = require('../../src/repositories/documents');
const projectsRepo = require('../../src/repositories/projects');
const { logger } = require('../../src/utils/logger');
const { TIER } = require('../../src/helpers/access-sql');

const anonymous = { tier: TIER.PUBLIC, roles: ['public'], projectScope: null, teams: [] };

test('parent gate drops a hidden parent, nets the count and warns', async (t) => {
  t.mock.method(documentsRepo, 'listByIds', async () => [{ id: 'd1', projectId: 'p1' }]);
  t.mock.method(projectsRepo, 'listByIds', async () => [{ id: 'p1', name: 'Site C' }]);
  const warn = t.mock.method(logger, 'warn', () => {});
  const items = [
    { chunkId: 'd1::p1::c0', documentId: 'd1', projectId: 'p1' },
    { chunkId: 'd2::p1::c0', documentId: 'd2', projectId: 'p1' },
    { chunkId: 'd1::p2::c0', documentId: 'd1', projectId: 'p1' }
  ];

  const out = await chunkQuery.gateChunksByParent(anonymous, items, 40);

  assert.deepStrictEqual(out.visible.map(c => c.chunkId), ['d1::p1::c0', 'd1::p2::c0']);
  assert.strictEqual(out.count, 39);
  assert.strictEqual(out.projById.get('p1').name, 'Site C');
  assert.strictEqual(warn.mock.callCount(), 1);
  assert.deepStrictEqual(warn.mock.calls[0].arguments[1], { withheld: 1, returned: 2 });
});

test('parent gate floors the net count at the rows it returns', async (t) => {
  t.mock.method(documentsRepo, 'listByIds', async () => [{ id: 'd1' }]);
  t.mock.method(projectsRepo, 'listByIds', async () => []);
  t.mock.method(logger, 'warn', () => {});
  const items = [{ documentId: 'd1', projectId: 'p1' }, { documentId: 'd2', projectId: 'p1' }];

  const out = await chunkQuery.gateChunksByParent(anonymous, items, 1);

  assert.strictEqual(out.count, 1);
});

test('column liveness reports unstamped scope', async (t) => {
  chunkQuery.resetStaleChunkScopeCache();
  t.mock.method(aiSearch, 'chunkParentFieldStatus', async () => (
    { available: ['typeId', 'milestoneId'], missing: [], unstamped: 12 }
  ));
  t.mock.method(aiSearch, 'staleChunkCount', async () => 3);

  const out = await chunkQuery.liveFacetColumns(['typeId'], { filter: "projectId eq 'p1'" }, ['p1']);

  assert.deepStrictEqual(out.unavailable, ['typeId']);
  assert.strictEqual(out.unstampedScope, true);
  assert.strictEqual(out.unknownScope, false);
  assert.strictEqual(out.missingColumn, false);
});

test('column liveness sends a stamped carried column and withholds an absent one', async (t) => {
  chunkQuery.resetStaleChunkScopeCache();
  t.mock.method(aiSearch, 'chunkParentFieldStatus', async () => (
    { available: ['typeId'], missing: ['milestoneId'], unstamped: 0 }
  ));
  const stale = t.mock.method(aiSearch, 'staleChunkCount', async () => 0);

  const out = await chunkQuery.liveFacetColumns(['typeId', 'milestoneId'], { filter: null }, []);

  assert.deepStrictEqual(out.unavailable, ['milestoneId']);
  assert.strictEqual(out.missingColumn, true);
  assert.strictEqual(out.unknownScope, false);
  assert.strictEqual(stale.mock.callCount(), 0, 'an index-wide 0 needs no scoped count');
});

test('column liveness reports an unanswered scope count as unknown', async (t) => {
  chunkQuery.resetStaleChunkScopeCache();
  t.mock.method(aiSearch, 'chunkParentFieldStatus', async () => (
    { available: ['typeId'], missing: [], unstamped: null }
  ));
  t.mock.method(aiSearch, 'staleChunkCount', async () => null);

  const out = await chunkQuery.liveFacetColumns(['typeId'], { filter: null }, ['p2']);

  assert.deepStrictEqual(out.unavailable, ['typeId']);
  assert.strictEqual(out.unstampedScope, false);
  assert.strictEqual(out.unknownScope, true);
});
