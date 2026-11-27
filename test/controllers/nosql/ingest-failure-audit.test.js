'use strict';

/**
 * POST /documents/:id/chunks that fails after the refusals: one `document.ingest` failure row with a
 * fixed error class, because chunks may already be written or deleted when the request stops.
 */

process.env.NODE_ENV = 'test';
// Before src/config is first required: the audit writer is inert without these, and a batch of 1
// drains through the stub transport as each row is appended.
process.env.AUDIT_DCR_ENDPOINT = 'https://dcr-test.canadacentral-1.ingest.monitor.azure.com';
process.env.AUDIT_DCR_IMMUTABLE_ID = 'dcr-testimmutableid';
process.env.AUDIT_MAX_BATCH = '1';

const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');

const audit = require('../../../src/utils/audit');
const config = require('../../../src/config');
const documents = require('../../../src/repositories/documents');
const chunks = require('../../../src/repositories/chunks');
const documentController = require('../../../src/controllers/nosql/document');
const { logger } = require('../../../src/utils/logger');
const { mockRes } = require('../../helpers/mock-res');

const STAFF = { sub: 'kc-sub-1', preferred_username: 'staff.person', realm_access: { roles: ['sysadmin'] } };
const DOC = { id: 'd1', projectId: '207', read: ['staff', 'sysadmin'], isPublished: false };

let rows = [];
audit._setTransport(async (_stream, batch) => { rows.push(...batch); });

async function ingest(req) {
  rows = [];
  const res = mockRes();
  await documentController.ingestChunks({ params: { id: 'd1' }, query: {}, user: STAFF, ...req }, res);
  await audit.flush();
  return res;
}

const jsonBody = { body: { markdown: 'z'.repeat(4000) } };

test('a failed chunk ingest', async (t) => {
  t.beforeEach((t) => {
    t.mock.method(logger, 'error', () => {});
    t.mock.method(logger, 'warn', () => {});
  });
  t.afterEach(() => t.mock.restoreAll());
  t.after(() => audit._resetTransport());

  await t.test('a JSON ingest whose chunk write falls short writes one failure row', async (t) => {
    t.mock.method(documents, 'getById', async () => ({ ...DOC }));
    t.mock.method(documents, 'patchExtraction', async () => ({}));
    t.mock.method(chunks, 'replaceForDocument', async () => ({ succeeded: 0, failed: 1, statusCounts: { 429: 1 } }));

    const res = await ingest(jsonBody);

    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(rows.length, 1);
    const [row] = rows;
    assert.strictEqual(row.Action, 'document.ingest');
    assert.strictEqual(row.Outcome, 'failure');
    assert.strictEqual(row.TargetId, 'd1');
    assert.strictEqual(row.ProjectId, '207');
    assert.deepStrictEqual(row.Detail, { errorClass: 'write-incomplete', status: 500, streamed: false });
    assert.ok(!JSON.stringify(row).includes(res.body.error), 'the row is kept for years; the message is not');
  });

  await t.test('an ingest whose chunks the index kept writes one failure row', async (t) => {
    t.mock.method(documents, 'getById', async () => ({ ...DOC }));
    t.mock.method(documents, 'patchExtraction', async () => ({}));
    t.mock.method(chunks, 'replaceForDocument', async () => ({
      succeeded: 0, failed: 1, statusCounts: { stillIndexed: 1 }
    }));

    const res = await ingest(jsonBody);

    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].Outcome, 'failure');
    assert.deepStrictEqual(rows[0].Detail, { errorClass: 'index-delete-incomplete', status: 503, streamed: false });
  });

  await t.test('an over-cap JSON ingest writes one failure row', async (t) => {
    const cap = config.maxChunksPerDocument;
    config.maxChunksPerDocument = 1;
    t.after(() => { config.maxChunksPerDocument = cap; });
    t.mock.method(documents, 'getById', async () => ({ ...DOC }));
    t.mock.method(documents, 'patchExtraction', async () => ({}));
    const replace = t.mock.method(chunks, 'replaceForDocument', async () => ({ succeeded: 0, failed: 0 }));

    const res = await ingest({ body: { markdown: Array.from({ length: 10 }, () => 'w'.repeat(2000)).join('\n\n') } });

    assert.strictEqual(res.statusCode, 413);
    assert.strictEqual(replace.mock.callCount(), 0);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].Outcome, 'failure');
    assert.deepStrictEqual(rows[0].Detail, { errorClass: 'cap-exceeded', status: 413, streamed: false });
  });

  await t.test('a thrown ingest fault writes one failure row naming the error class, not its message', async (t) => {
    const marker = 'sdk-response-body-7f3a';
    t.mock.method(documents, 'getById', async () => ({ ...DOC }));
    t.mock.method(documents, 'patchExtraction', async () => ({}));
    t.mock.method(chunks, 'replaceForDocument', async () => { throw new TypeError(marker); });

    const res = await ingest(jsonBody);

    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].Outcome, 'failure');
    assert.deepStrictEqual(rows[0].Detail,
      { errorClass: 'internal', status: 500, streamed: false, errorName: 'TypeError' });
    assert.ok(!JSON.stringify(rows[0]).includes(marker));
  });

  await t.test('a streamed ingest refused at line 1 writes one failure row marked streamed', async (t) => {
    t.mock.method(documents, 'getById', async () => ({ ...DOC }));
    const patch = t.mock.method(documents, 'patchExtraction', async () => ({}));

    const res = await ingest({
      stream: Readable.from(['not json\n']), is: (type) => type === 'application/x-ndjson'
    });

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(patch.mock.callCount(), 0);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].Outcome, 'failure');
    assert.deepStrictEqual(rows[0].Detail, { errorClass: 'bad-request', status: 400, streamed: true });
  });

  await t.test('an ingest refused for repeated failures writes no row', async (t) => {
    t.mock.method(documents, 'getById', async () => ({
      ...DOC, chunkIngestFailures: config.chunkIngestMaxFailures, chunkIngestFailedAt: new Date().toISOString()
    }));
    t.mock.method(documents, 'patchExtraction', async () => ({}));

    const res = await ingest(jsonBody);

    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(rows.length, 0, 'a refusal is not an ingest');
  });

  await t.test('a fault before the document is read answers 500 and writes no row', async (t) => {
    t.mock.method(documents, 'getById', async () => { throw new Error('read failed'); });

    const res = await ingest(jsonBody);

    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(rows.length, 0);
  });
});
