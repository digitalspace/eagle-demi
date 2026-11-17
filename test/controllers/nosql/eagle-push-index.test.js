'use strict';

// Staff lists page in the documents index, so an Eagle push writes its row there itself rather than
// leaving it to the indexer's next run.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const projects = require('../../../src/repositories/projects');
const documents = require('../../../src/repositories/documents');
const aiSearch = require('../../../src/search/ai-search');
const documentController = require('../../../src/controllers/nosql/document');
const {
  storedEagleProject, eagleDocument, documentReadForWriteFromGet, DOCUMENT_EAGLE_ID, STAFF, mockRes
} = require('../../helpers/eagle-mirror-fixtures');

/** One stored document row, read back and written as Cosmos would, plus the index rows sent. */
function wire(t) {
  let stored = null;
  t.mock.method(projects, 'getByEagleId', async () => storedEagleProject());
  t.mock.method(documents, 'getById', async () => stored && structuredClone(stored));
  t.mock.method(documents, 'upsert', async (item) => { stored = item; return item; });
  documentReadForWriteFromGet(t);
  t.mock.method(aiSearch, 'config', () => ({ configured: true }));
  return t.mock.method(aiSearch, 'upsertIndexRows', async (_index, rows) => rows.length);
}

const push = doc => documentController.upsertFromEagle(
  { params: { eagleId: DOCUMENT_EAGLE_ID }, query: {}, body: { doc }, user: STAFF }, mockRes());

test('a push that creates a document puts its whole index row in at once', async (t) => {
  const sent = wire(t);

  await push(eagleDocument());

  assert.deepStrictEqual(sent.mock.calls.map(c => c.arguments[1].map(row =>
    [row.id, row.projectId, row.displayName, row.fileNameTokens, row.searchVis])),
  [[[DOCUMENT_EAGLE_ID, '207', 'Application', 'application.pdf', 4]]]);
});

test('a delete that changes only isDeleted on a staff-level row still reaches the index', async (t) => {
  const sent = wire(t);

  await push(eagleDocument({ read: ['staff', 'sysadmin'], isDeleted: false }));
  await push(eagleDocument({ read: ['staff', 'sysadmin'], isDeleted: true }));

  assert.deepStrictEqual(sent.mock.calls.map(c => c.arguments[1].map(row => [row.read, row.isDeleted])),
    [[[['staff'], false]], [[['staff'], true]]]);
});
