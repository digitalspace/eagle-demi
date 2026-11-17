'use strict';

// A row Eagle deleted stays stored, narrowed to staff, but no staff read built on these lookups shows it.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../../src/config');
const cosmos = require('../../src/db/cosmos-nosql');
const projects = require('../../src/repositories/projects');
const bulkDownloads = require('../../src/repositories/bulk-downloads');
const queue = require('../../src/jobs/bulk-download-queue');
const documentController = require('../../src/controllers/nosql/document');
const bulkController = require('../../src/controllers/nosql/bulk-download');
const { gateChunksByParent } = require('../../src/search/chunk-query');
const { NOT_DELETED } = require('../../src/repositories/_sql');
const { makeRes } = require('../../src/http/router');

const STAFF = { realm_access: { roles: ['staff'] } };
const STAFF_ACCESS = { tier: 'staff', roles: ['staff'] };

// Project A's newest upload is one Eagle deleted; B's newest live upload falls between A's two.
const ROWS = [
  { id: 'a-gone', projectId: 'A', read: ['staff'], isDeleted: true, dateUploaded: '2026-11-10', s3Key: 'A/gone.pdf' },
  { id: 'a-live', projectId: 'A', read: ['staff'], isDeleted: false, dateUploaded: '2026-11-01', s3Key: 'A/live.pdf' },
  { id: 'b-live', projectId: 'B', read: ['staff'], dateUploaded: '2026-11-05', s3Key: 'B/live.pdf' },
  { id: 'b-gone', projectId: 'B', read: ['staff'], isDeleted: true, dateUploaded: '2026-10-01', s3Key: 'B/gone.pdf' }
];

/** Cosmos fake honouring NOT_DELETED, the id lists, `@projectId`, and the upload-maxima GROUP BY. */
function fakeDocuments(t) {
  t.mock.method(cosmos, 'query', async (_container, spec) => {
    const param = name => spec.parameters.find(p => p.name === name)?.value;
    const ids = spec.parameters.filter(p => /^@[bd]id\d/.test(p.name)).map(p => p.value);
    const rows = ROWS
      .filter(row => !spec.query.includes(NOT_DELETED.clause) || row.isDeleted !== true)
      .filter(row => !ids.length || ids.includes(row.id))
      .filter(row => !param('@projectId') || row.projectId === param('@projectId'));
    if (!spec.query.includes('GROUP BY')) {
      return { items: structuredClone(rows).sort((a, b) => b.dateUploaded.localeCompare(a.dateUploaded)) };
    }
    const newest = new Map();
    for (const row of rows) {
      if (!newest.has(row.projectId) || row.dateUploaded > newest.get(row.projectId)) newest.set(row.projectId, row.dateUploaded);
    }
    return { items: [...newest].map(([projectId, dateUploaded]) => ({ projectId, dateUploaded })) };
  });
}

async function call(handler, req) {
  const res = makeRes('test');
  await handler({ query: {}, params: {}, headers: {}, header: () => undefined, user: STAFF, ...req }, res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
}

test('recent uploads rank a project by its newest live upload', async (t) => {
  fakeDocuments(t);
  t.mock.method(projects, 'getById', async (_access, id) => ({ id, name: `Project ${id}`, read: ['staff'] }));

  const res = await call(documentController.getRecentUploads, {});

  assert.deepStrictEqual(res.body.items.map(item => [item.projectId, item.dateUploaded]),
    [['B', '2026-11-05'], ['A', '2026-11-01']]);
});

test('a bulk download of only deleted documents answers 404', async (t) => {
  fakeDocuments(t);
  config.bulkDownloadsQueue = 'bulk-downloads';
  t.after(() => { config.bulkDownloadsQueue = undefined; });
  t.mock.method(bulkDownloads, 'acquireSlot', async () => true);
  t.mock.method(bulkDownloads, 'releaseSlot', async () => true);
  t.mock.method(bulkDownloads, 'create', async job => job);
  t.mock.method(queue, 'enqueue', async () => {});

  const res = await call(bulkController.createBulkDownload, { body: { documentIds: ['a-gone', 'b-gone'] } });

  assert.strictEqual(res.status, 404);
});

test('a chunk whose parent document Eagle deleted is withheld', async (t) => {
  fakeDocuments(t);
  t.mock.method(projects, 'listByIds', async () => []);

  const { visible } = await gateChunksByParent(STAFF_ACCESS,
    [{ documentId: 'a-gone', projectId: 'A' }, { documentId: 'a-live', projectId: 'A' }], 2);

  assert.deepStrictEqual(visible.map(chunk => chunk.documentId), ['a-live']);
});
