'use strict';

// `dataset=DocumentChunk` reads its parent labels through the same document read as native
// passages, so a parent's own field dials must hold on the Eagle-shaped reply as well.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const searchController = require('../../src/controllers/search');
const aiSearch = require('../../src/search/ai-search');
const projectsRepo = require('../../src/repositories/projects');
const { storedDocuments, DIALLED_DOCUMENT } = require('../helpers/stored-documents');

async function chunkSearch(user) {
  const req = { query: { dataset: 'DocumentChunk', keywords: 'water', pageSize: '10' }, header: () => null, user };
  let body;
  const res = { json: (data) => { body = data; return res; }, status: () => res, setHeader: () => res };
  await searchController.search(req, res);
  return body[0].searchResults[0];
}

test('DocumentChunk parent labels honour the parent row dials', async (t) => {
  t.mock.method(aiSearch, 'searchChunks', async () => ({
    count: 1,
    items: [{ chunkId: 'd1::p1::c0', documentId: 'd1', projectId: 'p1', pageNumber: 1, snippet: '<mark>water</mark>' }]
  }));
  t.mock.method(projectsRepo, 'listByIds', async () => [{ id: 'p1', name: 'Site C', read: ['public'] }]);
  storedDocuments(t, [DIALLED_DOCUMENT]);

  const anon = await chunkSearch(undefined);
  assert.strictEqual(anon.documentName, 'water-plan.pdf');
  assert.strictEqual(anon.milestone, null);
  assert.strictEqual(anon.milestoneId, 'm1');
  assert.ok(!JSON.stringify(anon).includes('Water Plan'));
  assert.ok(!('vis' in anon));

  const staff = await chunkSearch({ realm_access: { roles: ['staff'] } });
  assert.strictEqual(staff.documentName, 'Water Plan');
  assert.strictEqual(staff.milestone, 'Application');
});
