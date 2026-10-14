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
  t.mock.method(documents, 'patchExtraction', async () => ({}));
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

test('purgeDocument keeps the row when its chunks are not all removed', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const cases = [
    ['chunk removal throws', async () => { throw new Error('cosmos 503'); }, /cosmos 503/],
    ['some chunks fail', async () => ({ succeeded: 3, failed: 2 }), /2 chunk\(s\) not removed/]
  ];
  for (const [label, removeForDocument, reason] of cases) {
    await t.test(`${label}: no row delete, reported as kept`, async (t) => {
      const order = stubAll(t);
      t.mock.method(chunks, 'removeForDocument', removeForDocument);
      const errors = t.mock.method(logger, 'error', () => {});

      const result = await purgeDocument(ROW);

      assert.strictEqual(documents.deleteById.mock.callCount(), 0,
        'the row is the only handle a retried purge has on the chunks left behind');
      assert.strictEqual(result.rowKept, true);
      assert.match(result.chunkRemovalError, reason);
      assert.deepStrictEqual(order, [], 'the PDF title record is not lost, so it is not logged');
      assert.match(errors.mock.calls[0].arguments[0], /row kept/);
      // The stamp moves _ts, so the document indexer puts the kept row back in search.
      const [[id, projectId, fields]] = documents.patchExtraction.mock.calls.map(c => c.arguments);
      assert.deepStrictEqual([id, projectId, Object.keys(fields)], ['d1', '207', ['chunkPurgeFailedAt']]);
      assert.ok(!Number.isNaN(Date.parse(fields.chunkPurgeFailedAt)));
    });
  }

  await t.test('a stamp that fails is logged and the row is still reported kept', async (t) => {
    stubAll(t);
    t.mock.method(chunks, 'removeForDocument', async () => ({ succeeded: 0, failed: 1 }));
    t.mock.method(documents, 'patchExtraction', async () => { throw new Error('412'); });
    const errors = t.mock.method(logger, 'error', () => {});

    const result = await purgeDocument(ROW);

    assert.strictEqual(result.rowKept, true);
    assert.match(errors.mock.calls[1].arguments[0], /could not stamp kept document d1: 412/);
  });

  await t.test('every chunk removed deletes the row and reports it gone', async (t) => {
    stubAll(t);
    t.mock.method(chunks, 'removeForDocument', async () => ({ succeeded: 4, failed: 0 }));

    const result = await purgeDocument(ROW);

    assert.strictEqual(documents.patchExtraction.mock.callCount(), 0);
    assert.strictEqual(documents.deleteById.mock.callCount(), 1);
    assert.strictEqual(result.rowKept, false);
    assert.strictEqual(result.removedChunks, 4);
  });
});
