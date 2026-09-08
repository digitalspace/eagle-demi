'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const controller = require('../../src/controllers/project-summary');
const documentsRepo = require('../../src/repositories/documents');
const chunksRepo = require('../../src/repositories/chunks');
const routes = require('../../src/http/routes');

function mockRes() {
  const res = {
    body: null,
    statusCode: 200,
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; }
  };
  return res;
}

/** A stored chunk row, carrying the fields a chunk row really has. */
const row = (page) => ({
  id: `docB::p${page}::c0`, documentId: 'docB', projectId: '272',
  pageNumber: page, chunkIndex: 0, content: `page ${page} text`, read: ['eao']
});

const req = (query = {}) => ({ params: { id: 'docB' }, query, user: { realm_access: { roles: ['eao'] } } });

test('GET /documents/:id/chunks', async (t) => {
  await t.test('404s when the caller cannot see the parent document', async () => {
    // A chunk's own `read[]` is an ingest-time snapshot and can outlive its parent's visibility, so
    // the parent document is the gate. This is the only route that returns full chunk text.
    t.mock.method(documentsRepo, 'getById', async () => null);
    let reads = 0;
    t.mock.method(chunksRepo, 'allForDocument', async () => { reads++; return []; });

    const res = mockRes();
    await controller.getDocumentChunks(req(), res);

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(reads, 0, 'no chunk text is read for a document the caller cannot see');
  });

  await t.test('reads the chunks under the caller access, not systemAccess', async () => {
    // `allForDocument` composes the visibility predicate from whatever access it is handed.
    // Passing systemAccess() here would return chunks of documents nobody may see.
    t.mock.method(documentsRepo, 'getById', async () => ({ id: 'docB' }));
    let passed = 'not called';
    t.mock.method(chunksRepo, 'allForDocument', async (access) => { passed = access; return [row(1)]; });

    await controller.getDocumentChunks(req(), mockRes());

    assert.ok(passed && passed !== 'not called', 'an access context reached the repository');
    assert.ok(passed.roles.includes('eao'), `expected the caller roles, got ${JSON.stringify(passed)}`);
  });

  await t.test('serves the chunk text and no document field', async () => {
    // Chunk `content` is maxVis 0, so it survives only because the projection is explicit. The
    // same explicitness is what keeps `read[]` off the wire.
    t.mock.method(documentsRepo, 'getById', async () => ({ id: 'docB' }));
    t.mock.method(chunksRepo, 'allForDocument', async () => [row(1)]);

    const res = mockRes();
    await controller.getDocumentChunks(req(), res);

    assert.strictEqual(res.body.items[0].content, 'page 1 text');
    assert.strictEqual(res.body.items[0].chunkId, 'docB::p1::c0');
    assert.strictEqual(res.body.items[0].read, undefined, 'the chunk ACL is not a response field');
  });

  await t.test('pages without dropping or repeating a chunk', async () => {
    // The generator reads a whole document by walking pages. A boundary that overlaps would feed
    // the same passage to the model twice; one that skips would drop conditions silently.
    t.mock.method(documentsRepo, 'getById', async () => ({ id: 'docB' }));
    t.mock.method(chunksRepo, 'allForDocument', async () =>
      [row(1), row(2), row(3), row(4), row(5)]);

    const first = mockRes();
    await controller.getDocumentChunks(req({ page: '1', pageSize: '2' }), first);
    const second = mockRes();
    await controller.getDocumentChunks(req({ page: '2', pageSize: '2' }), second);

    assert.deepStrictEqual(first.body.items.map(c => c.pageNumber), [1, 2]);
    assert.deepStrictEqual(second.body.items.map(c => c.pageNumber), [3, 4]);
    assert.strictEqual(second.body.count, 5, 'the total is the whole document, not the page');
  });

  await t.test('is declared once, and the handler it names exists', () => {
    // A second entry for the same method and path is dead: `match` takes the first hit, so a
    // duplicate naming a handler that was never written raises nothing — not at load, not at
    // dispatch — until somebody deletes the entry above it and every request becomes a 500.
    const declared = routes.filter(r => r.method === 'get' && r.path === '/documents/:id/chunks');

    assert.strictEqual(declared.length, 1, 'one entry, so the table cannot hide a dead handler');
    assert.strictEqual(declared[0].load(), controller.getDocumentChunks);
  });
});
