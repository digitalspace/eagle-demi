'use strict';

// Both native document creates hand the saved row to sync-out, and a sync-out that cannot queue never fails or stalls them.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const documents = require('../../../src/repositories/documents');
const projects = require('../../../src/repositories/projects');
const storage = require('../../../src/storage');
const syncOut = require('../../../src/sync-out');
const { logger } = require('../../../src/utils/logger');
const documentController = require('../../../src/controllers/nosql/document');
const { mockRes } = require('../../helpers/eagle-mirror-fixtures');
const { useEnv } = require('../../helpers/sync-out-eagle');

const PARENT = { id: '207', read: ['public', 'staff'], isPublished: true, region: 'skeena' };

const createRequest = () => ({ query: {}, body: { project: '207', displayName: 'Report', s3Key: 'p/abc.pdf' } });

const CREATES = [
  ['createDocument', 201, createRequest],
  ['extractDocument', 202, () => ({
    query: {}, params: {}, body: { project: '207' },
    file: { path: '/tmp/up1', originalname: 'Report.pdf', mimetype: 'application/pdf' }
  })]
];

function wireWrite(t) {
  t.mock.method(projects, 'getById', async () => PARENT);
  t.mock.method(storage, 'putFile', async () => {});
  const saved = [];
  t.mock.method(documents, 'upsert', async (doc) => { saved.push(doc); return doc; });
  return saved;
}

test('native document creates queue sync-out', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  for (const [name, status, request] of CREATES) {
    await t.test(`${name} enqueues the saved row once as a document`, async () => {
      const saved = wireWrite(t);
      const enqueue = t.mock.method(syncOut, 'enqueue', async () => []);
      const res = mockRes();

      await documentController[name](request(), res);

      assert.strictEqual(res.statusCode, status);
      assert.strictEqual(enqueue.mock.callCount(), 1);
      assert.deepStrictEqual(enqueue.mock.calls[0].arguments, [saved[0], { kind: 'document' }]);
    });

  }

  await t.test('a create answers 201 when sync-out is on but no queue is set', async (tt) => {
    useEnv(tt, { SYNC_OUT_EAGLE_ENABLED: 'true', SYNC_OUT_EAGLE_DOCUMENT_ENABLED: 'true', SYNC_OUT_EAGLE_NATIVE_ENABLED: 'true' });
    const queue = process.env.SYNC_OUT_QUEUE;
    delete process.env.SYNC_OUT_QUEUE;
    tt.after(() => { if (queue !== undefined) process.env.SYNC_OUT_QUEUE = queue; });
    const saved = wireWrite(t);
    const errors = t.mock.method(logger, 'error', () => {});
    const res = mockRes();

    await documentController.createDocument(createRequest(), res);

    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(saved.length, 1, 'the row is saved');
    assert.deepStrictEqual(errors.mock.calls.map(c => c.arguments[0]), ['[sync-out] enqueue failed']);
  });

  await t.test('a create answers 201 once a stuck enqueue times out, and its late failure is still logged', async (tt) => {
    wireWrite(t);
    let entered;
    let fail;
    const called = new Promise((resolve) => { entered = resolve; });
    t.mock.method(syncOut, 'enqueue', () => {
      entered();
      return new Promise((_resolve, reject) => { fail = reject; });
    });
    const errors = t.mock.method(logger, 'error', () => {});
    tt.mock.timers.enable({ apis: ['setTimeout'] });
    const res = mockRes();

    const answered = documentController.createDocument(createRequest(), res);
    await called;
    tt.mock.timers.tick(5000);
    await answered;
    assert.strictEqual(res.statusCode, 201);
    fail(new Error('queue down'));
    await new Promise(resolve => setImmediate(resolve));

    assert.deepStrictEqual(errors.mock.calls.map(c => c.arguments[0]),
      ['[sync-out] enqueue timed out', '[sync-out] enqueue failed after timeout']);
  });
});
