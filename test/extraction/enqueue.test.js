'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { enqueueExtraction } = require('../../src/extraction/enqueue');
const { logger } = require('../../src/utils/logger');
const { QUEUE, setExtractionEnv, fakeQueueAndStore, queueable } = require('./fakes');

test('a queueable row is sent with its ids and reason, then stamped with the same time', async (t) => {
  setExtractionEnv(t);
  const { sent, queues, stamps } = fakeQueueAndStore(t);

  assert.strictEqual(await enqueueExtraction(queueable(), 'intake'), true);

  assert.deepStrictEqual(queues, [QUEUE]);
  assert.strictEqual(sent.length, 1);
  const [{ enqueuedAt, ...ids }] = sent;
  assert.deepStrictEqual(ids, { documentId: 'doc-1', projectId: '207', reason: 'intake' });
  assert.match(enqueuedAt, /^\d{4}-\d{2}-\d{2}T/);
  const stamp = stamps.get('doc-1');
  assert.strictEqual(stamp.partitionKey, '207');
  assert.deepStrictEqual(stamp.operations, [{ op: 'set', path: '/extractionQueuedAt', value: enqueuedAt }]);
});

test('the skip rules send nothing and stamp nothing', async (t) => {
  const skipped = {
    'update image': queueable({ documentSource: 'UPDATE' }),
    'pending scan': queueable({ scanStatus: 'pending' }),
    'rejected scan': queueable({ scanStatus: 'rejected' }),
    deleted: queueable({ isDeleted: true }),
    'no stored file': queueable({ s3Key: '' }),
    extracted: queueable({ contentExtracted: true })
  };
  for (const [name, row] of Object.entries(skipped)) {
    await t.test(name, async (t) => {
      setExtractionEnv(t);
      const { sent, stamps } = fakeQueueAndStore(t);
      assert.strictEqual(await enqueueExtraction(row, 'backlog'), false);
      assert.deepStrictEqual(sent, []);
      assert.strictEqual(stamps.size, 0);
    });
  }
});

test('with EXTRACTION_QUEUE unset nothing is sent and nothing throws', async (t) => {
  setExtractionEnv(t, {});
  const { sent, queues, stamps } = fakeQueueAndStore(t);

  assert.strictEqual(await enqueueExtraction(queueable(), 'intake'), false);
  assert.deepStrictEqual(queues, []);
  assert.deepStrictEqual(sent, []);
  assert.strictEqual(stamps.size, 0);
});

test('a failed send is logged, not thrown, and leaves the row unstamped for the backlog', async (t) => {
  setExtractionEnv(t);
  const { stamps } = fakeQueueAndStore(t, { failSend: true });
  const warn = t.mock.method(logger, 'warn', () => {});

  assert.strictEqual(await enqueueExtraction(queueable(), 'intake'), false);
  assert.strictEqual(stamps.size, 0);
  assert.strictEqual(warn.mock.calls[0].arguments[0], '[extraction] enqueue failed');
});

test('a failed stamp after a sent message is logged and still counts as sent', async (t) => {
  setExtractionEnv(t);
  const { sent } = fakeQueueAndStore(t, { failStamp: true });
  const warn = t.mock.method(logger, 'warn', () => {});

  assert.strictEqual(await enqueueExtraction(queueable(), 'intake'), true);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(warn.mock.calls[0].arguments[0], '[extraction] queued stamp failed');
});
