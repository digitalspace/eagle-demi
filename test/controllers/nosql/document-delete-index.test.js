'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const documents = require('../../../src/repositories/documents');
const aiSearch = require('../../../src/search/ai-search');
const documentController = require('../../../src/controllers/nosql/document');
const { logger } = require('../../../src/utils/logger');
const { mockRes } = require('../../helpers/mock-res');

test('with search configured, a failed index removal keeps the row and answers 503', async (t) => {
  t.mock.method(aiSearch, 'config', () => ({ configured: true }));
  t.mock.method(aiSearch, 'deleteFromIndex', async () => 0);
  t.mock.method(aiSearch, 'deleteChunksForDocument', async () => 0);
  t.mock.method(documents, 'getById', async () => ({ id: 'd1', projectId: '207' }));
  t.mock.method(documents, 'patchExtraction', async () => ({}));
  const deleteById = t.mock.method(documents, 'deleteById', async () => true);
  t.mock.method(logger, 'error', () => {});

  const res = mockRes();
  await documentController.deleteDocument({ params: { id: 'd1' }, query: {} }, res);

  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(deleteById.mock.callCount(), 0,
    'a deleted row cannot be found again, so the index entry would stay searchable');
  assert.strictEqual(res.headers['Retry-After'], '30');
});
