'use strict';

/**
 * DELETE /documents/:id when the purge keeps the row because some chunks could not be removed:
 * a retryable 503, the row untouched, and a failure audit row, because the search-index entries
 * are already gone by then.
 */

process.env.NODE_ENV = 'test';
// Before src/config is first required: the audit writer is inert without these, and a batch of 1
// drains through the stub transport as each row is appended.
process.env.AUDIT_DCR_ENDPOINT = 'https://dcr-test.canadacentral-1.ingest.monitor.azure.com';
process.env.AUDIT_DCR_IMMUTABLE_ID = 'dcr-testimmutableid';
process.env.AUDIT_MAX_BATCH = '1';

const test = require('node:test');
const assert = require('node:assert');

const audit = require('../../../src/utils/audit');
const documents = require('../../../src/repositories/documents');
const chunks = require('../../../src/repositories/chunks');
const aiSearch = require('../../../src/search/ai-search');
const documentController = require('../../../src/controllers/nosql/document');
const { logger } = require('../../../src/utils/logger');

let rows = [];
audit._setTransport(async (_stream, batch) => { rows.push(...batch); });

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    setHeader(k, v) { this.headers[k] = v; }
  };
}

test('a delete whose chunks are not all removed', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.after(() => audit._resetTransport());

  await t.test('is a retryable 503 that keeps the row and audits the failure', async (t) => {
    rows = [];
    t.mock.method(aiSearch, 'deleteChunksForDocument', async () => 2);
    t.mock.method(aiSearch, 'deleteFromIndex', async () => 1);
    t.mock.method(chunks, 'removeForDocument', async () => ({ succeeded: 1, failed: 1 }));
    t.mock.method(documents, 'getById', async () => ({ id: 'd1', projectId: '207', displayName: 'Plan' }));
    t.mock.method(documents, 'patchExtraction', async () => ({}));
    const deleteById = t.mock.method(documents, 'deleteById', async () => true);
    t.mock.method(logger, 'error', () => {});

    const res = mockRes();
    await documentController.deleteDocument({ params: { id: 'd1' }, query: {} }, res);
    await audit.flush();

    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.headers['Retry-After'], '30');
    // Pinned so the purge's internal error text never reaches the caller.
    assert.deepStrictEqual(Object.keys(res.body).sort(),
      ['error', 'removedChunks', 'removedChunksFromSearch', 'removedFromSearch']);
    assert.match(res.body.error, /Retry the delete/);
    assert.strictEqual(res.body.removedChunks, 1);
    assert.strictEqual(deleteById.mock.callCount(), 0);

    assert.strictEqual(rows.length, 1);
    const [row] = rows;
    assert.strictEqual(row.Action, 'document.delete');
    assert.strictEqual(row.Outcome, 'failure');
    assert.strictEqual(row.TargetId, 'd1');
    assert.deepStrictEqual(row.Detail, {
      displayName: 'Plan', removedChunks: 1, removedFromSearch: 1, removedChunksFromSearch: 2, rowKept: true
    });
  });
});
