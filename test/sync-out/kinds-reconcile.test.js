'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const queues = require('../../src/jobs/queue-client');
const documents = require('../../src/repositories/documents');
const { DOCUMENT, kindOf } = require('../../src/sync-out/kinds');

const ENV = { SYNC_OUT_EAGLE_ENABLED: 'true', SYNC_OUT_EAGLE_DOCUMENT_ENABLED: 'true' };

const docRow = (id, sentVersion) => ({
  id, projectId: '1234', sourceSystem: 'demi', eagleId: `eagle-${id}`, syncVersion: 3,
  syncOut: { eagle: { status: 'sent', sentVersion } }
});

test('the document reconcile hook re-queues only rows whose version Eagle has not been sent', async (t) => {
  const previous = Object.fromEntries(Object.keys(ENV).map(k => [k, process.env[k]]));
  Object.assign(process.env, ENV);
  t.after(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  t.mock.method(documents, 'listSyncPending', async () => [docRow('owed', 2), docRow('current', 3)]);
  const sent = [];
  t.mock.method(queues, 'queueClientFor', () => ({ sendMessage: async (body) => { sent.push(JSON.parse(body)); } }));
  const log = { info: () => {}, warn: () => {} };

  const report = await kindOf(DOCUMENT).reconcile({ repair: true, log });

  assert.deepStrictEqual(sent, [{ kind: DOCUMENT, consumer: 'eagle', id: 'owed', projectId: '1234', attempt: 1, repair: true }]);
  assert.deepStrictEqual({ listed: report.listed, queued: report.queued, failed: report.failed },
    { listed: ['owed'], queued: 1, failed: [] });
});
