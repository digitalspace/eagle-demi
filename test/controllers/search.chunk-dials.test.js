'use strict';

// Document, DocumentChunk and summary replies label rows from their parent rows, so a parent's
// own field dials must hold there, and a dialled parent `id` must not drop the label.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const searchController = require('../../src/controllers/search');
const aiSearch = require('../../src/search/ai-search');
const projectsRepo = require('../../src/repositories/projects');
const chunksRepo = require('../../src/repositories/chunks');
const summarizer = require('../../src/ai/summarize');
const { storedDocuments, DIALLED_DOCUMENT } = require('../helpers/stored-documents');

const STAFF = { realm_access: { roles: ['staff'] } };
const CHUNK_HIT = { chunkId: 'd1::p1::c0', documentId: 'd1', projectId: 'p1', pageNumber: 1, snippet: '<mark>water</mark>' };

async function reply(handler, query, user) {
  const req = { query, header: () => null, user };
  let body;
  const res = { json: (data) => { body = data; return res; }, status: () => res, setHeader: () => res };
  await searchController[handler](req, res);
  return body;
}

async function chunkSearch(user) {
  return (await reply('search', { dataset: 'DocumentChunk', keywords: 'water', pageSize: '10' }, user))[0].searchResults[0];
}

test('DocumentChunk parent labels honour the parent row dials', async (t) => {
  t.mock.method(aiSearch, 'searchChunks', async () => ({ count: 1, items: [CHUNK_HIT] }));
  t.mock.method(projectsRepo, 'listByIds', async () => [{ id: 'p1', name: 'Site C', read: ['public'] }]);
  storedDocuments(t, [DIALLED_DOCUMENT]);

  const anon = await chunkSearch(undefined);
  assert.strictEqual(anon.documentName, 'water-plan.pdf');
  assert.strictEqual(anon.milestone, null);
  assert.strictEqual(anon.milestoneId, 'm1');
  assert.ok(!JSON.stringify(anon).includes('Water Plan'));
  assert.ok(!('vis' in anon));

  const staff = await chunkSearch(STAFF);
  assert.strictEqual(staff.documentName, 'Water Plan');
  assert.strictEqual(staff.milestone, 'Application');
});

// A public project that dials its own `id`: each label join must still find it by the stored id.
const EAGLE_ID = '5c1f7a3e9b1d2c0012340009';
const ID_DIALLED_PROJECT = Object.freeze({ id: 'p1', eagleId: EAGLE_ID, name: 'Site C', read: ['public'], vis: { id: 2 } });
const PLAIN_DOCUMENT = Object.freeze({ id: 'd1', projectId: 'p1', read: ['public'], displayName: 'Water Plan' });

const ID_DIAL_CASES = [
  {
    name: 'Document',
    stub: (t) => t.mock.method(aiSearch, 'searchDocuments', async () => ({ count: 1, items: [{ ...PLAIN_DOCUMENT }] })),
    label: async (user) => {
      const [row] = (await reply('search', { dataset: 'Document', keywords: 'water' }, user))[0].searchResults;
      return { projectName: row.projectName, project: row.project };
    },
    expected: { projectName: 'Site C', project: { _id: EAGLE_ID, name: 'Site C' } }
  },
  {
    name: 'DocumentChunk',
    stub: (t) => {
      t.mock.method(aiSearch, 'searchChunks', async () => ({ count: 1, items: [CHUNK_HIT] }));
      storedDocuments(t, [PLAIN_DOCUMENT]);
    },
    label: async (user) => {
      const row = await chunkSearch(user);
      return { projectName: row.projectName, project: row.project };
    },
    expected: { projectName: 'Site C', project: { _id: EAGLE_ID, name: 'Site C' } }
  },
  {
    name: 'summary',
    stub: (t) => {
      t.mock.method(aiSearch, 'searchChunks', async () => ({ items: [CHUNK_HIT] }));
      t.mock.method(chunksRepo, 'getById', async (access, chunkId, documentId) => ({ id: chunkId, documentId, projectId: 'p1', content: 'water' }));
      storedDocuments(t, [PLAIN_DOCUMENT]);
      t.mock.method(summarizer, 'summarize', async () =>
        ({ summary: 'an answer', citations: [0], usage: null, estimatedCostCad: 0 }));
    },
    label: async (user) => ({ projectName: (await reply('summarize', { keywords: 'water' }, user)).citations[0].projectName }),
    expected: { projectName: 'Site C' }
  }
];

for (const c of ID_DIAL_CASES) {
  test(`${c.name} labels a project that dials its own id`, async (t) => {
    c.stub(t);
    t.mock.method(projectsRepo, 'listByIds', async () => [structuredClone(ID_DIALLED_PROJECT)]);

    assert.deepStrictEqual(await c.label(undefined), c.expected);
    assert.deepStrictEqual(await c.label(STAFF), c.expected);
  });
}
