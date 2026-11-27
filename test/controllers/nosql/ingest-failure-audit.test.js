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
const aiSearch = require('../../../src/search/ai-search');
const { STREAM_REFUSED_AFTER_WRITE } = require('../../../src/domain/document-ingest');
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

function ndjson(lines) {
  return {
    stream: Readable.from(lines.map(line => `${line}\n`)), is: (type) => type === 'application/x-ndjson'
  };
}

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

  await t.test('a stream refused after a batch was written records the failure on the document', async (t) => {
    const marker = 'host-block-text-9c2e';
    t.mock.method(documents, 'getById', async () => ({
      ...DOC, chunkIngestFailures: 1, chunkIngestFailedAt: new Date().toISOString()
    }));
    const patch = t.mock.method(documents, 'patchExtraction', async () => ({}));
    const upsert = t.mock.method(chunks, 'upsertBatch', async (_a, _id, batch) => ({ succeeded: batch.length, failed: 0 }));
    const deletes = [
      t.mock.method(chunks, 'deleteSurplus', async () => ({})),
      t.mock.method(chunks, 'removeForDocument', async () => ({})),
      t.mock.method(aiSearch, 'deleteChunksByIds', async () => ({})),
      t.mock.method(aiSearch, 'deleteChunksForDocument', async () => ({}))
    ];
    const pages = Array.from({ length: 260 }, (_, i) => JSON.stringify(`\fPage ${i} ${marker} ${'p'.repeat(1500)}`));

    const res = await ingest(ndjson(['{}', ...pages, 'not json']));

    assert.ok(upsert.mock.callCount() >= 1, 'precondition: a batch was written before the bad line');
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, `line ${pages.length + 2} is not valid JSON`);
    assert.strictEqual(patch.mock.callCount(), 1);
    const fields = patch.mock.calls[0].arguments[2];
    assert.strictEqual(fields.contentExtractionError, STREAM_REFUSED_AFTER_WRITE);
    assert.strictEqual(fields.chunkIngestFailures, 2);
    assert.strictEqual(typeof fields.chunkIngestFailedAt, 'string');
    assert.ok(!('contentExtracted' in fields));
    assert.ok(!JSON.stringify(fields).includes(marker));
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual(rows[0].Detail, { errorClass: 'bad-request-partial', status: 400, streamed: true });
    assert.strictEqual(logger.error.mock.callCount(), 1);
    assert.ok(logger.error.mock.calls[0].arguments[0].startsWith('[Document Controller] Chunk ingest failed:'));
    assert.deepStrictEqual(deletes.map(d => d.mock.callCount()), [0, 0, 0, 0]);
  });

  await t.test('a stream refused at a later line before any batch was written records nothing on the document', async (t) => {
    t.mock.method(documents, 'getById', async () => ({ ...DOC }));
    const patch = t.mock.method(documents, 'patchExtraction', async () => ({}));
    const upsert = t.mock.method(chunks, 'upsertBatch', async () => ({ succeeded: 0, failed: 0 }));

    const res = await ingest(ndjson(['{}', JSON.stringify(`\fPage one ${'p'.repeat(200)}`), '{"not":"a string"}']));

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(upsert.mock.callCount(), 0);
    assert.strictEqual(patch.mock.callCount(), 0);
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual(rows[0].Detail, { errorClass: 'bad-request', status: 400, streamed: true });
  });

  await t.test('a JSON ingest with no markdown string writes one failure row', async (t) => {
    t.mock.method(documents, 'getById', async () => ({ ...DOC }));
    t.mock.method(documents, 'patchExtraction', async () => ({}));

    const res = await ingest({ body: { markdown: 42 } });

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].Outcome, 'failure');
    assert.deepStrictEqual(rows[0].Detail, { errorClass: 'bad-request', status: 400, streamed: false });
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
