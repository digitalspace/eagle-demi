'use strict';

/**
 * purgeDocument and a titled PDF: the stored file stays, and the record of its original bytes is
 * logged before the row that holds it is deleted. Search, chunks, the row and storage are stubbed.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const documents = require('../../src/repositories/documents');
const chunks = require('../../src/repositories/chunks');
const aiSearch = require('../../src/search/ai-search');
const storage = require('../../src/storage');
const { logger } = require('../../src/utils/logger');
const { purgeDocument } = require('../../src/helpers/purge');

const ROW = Object.freeze({
  id: 'd1', projectId: '207', s3Key: 'etl/site-c/1389817063122_20d7490a.pdf',
  pdfTitle: {
    sourceKey: 'etl/site-c/1389817063122_20d7490a.pdf', originalLength: 104857,
    originalSha256: 'a'.repeat(64), title: 'Application Part A', status: 'titled'
  }
});

/** Stubs every collaborator; returns the ordered log of info lines and the row delete. */
function stubAll(t) {
  const order = [];
  t.mock.method(aiSearch, 'deleteChunksForDocument', async () => 0);
  t.mock.method(aiSearch, 'deleteFromIndex', async () => 1);
  t.mock.method(chunks, 'removeForDocument', async () => ({ succeeded: 0 }));
  t.mock.method(documents, 'deleteById', async () => { order.push('row'); return true; });
  t.mock.method(storage, 'removeObject', async () => {});
  t.mock.method(logger, 'info', (msg) => { order.push(msg); });
  return order;
}

test('purgeDocument and a titled PDF', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('logs the original length and hash, then deletes the row', async (t) => {
    const order = stubAll(t);

    await purgeDocument(ROW);

    assert.strictEqual(order.length, 2);
    assert.strictEqual(order[1], 'row', 'logged after the row is gone, the record is already lost');
    assert.match(order[0], /pdf-title\.original/);
    assert.match(order[0], /id=d1\b/);
    assert.match(order[0], /s3Key=etl\/site-c\/1389817063122_20d7490a\.pdf\b/);
    assert.match(order[0], /originalLength=104857\b/);
    assert.match(order[0], new RegExp(`originalSha256=${'a'.repeat(64)}\\b`));
  });

  await t.test('a reconcile purge, given the row as listSeededIds returns it, logs it too',
    async (t) => {
      const order = stubAll(t);
      const { id, projectId, pdfTitle } = ROW;

      await purgeDocument({ id, projectId, read: ['public'], isPublished: true, pdfTitle });

      assert.deepStrictEqual(order.slice(1), ['row']);
      assert.match(order[0], /sourceKey=etl\/site-c\/1389817063122_20d7490a\.pdf\b/,
        'the reconcile row has no s3Key, so the record must name the object itself');
      assert.match(order[0], /originalLength=104857\b/);
      assert.match(order[0], new RegExp(`originalSha256=${'a'.repeat(64)}\\b`));
    });

  await t.test('never removes the stored file', async (t) => {
    stubAll(t);

    const result = await purgeDocument(ROW);

    assert.strictEqual(storage.removeObject.mock.callCount(), 0);
    assert.strictEqual(result.storedFileRetained, true);
  });

  await t.test('a row with no PDF title record logs nothing for it', async (t) => {
    const order = stubAll(t);

    await purgeDocument({ id: 'd1', projectId: '207', s3Key: ROW.s3Key });

    assert.deepStrictEqual(order, ['row']);
  });
});
