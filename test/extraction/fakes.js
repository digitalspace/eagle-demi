'use strict';

const cosmos = require('../../src/db/cosmos-nosql');
const queueClient = require('../../src/jobs/queue-client');

const QUEUE = 'extract';
const EXTRACTION_VARS = ['EXTRACTION_QUEUE'];

/** Set the EXTRACTION_* settings for one test; anything not named is cleared. Restored after. */
function setExtractionEnv(t, values = { EXTRACTION_QUEUE: QUEUE }) {
  const saved = EXTRACTION_VARS.map(v => [v, process.env[v]]);
  for (const v of EXTRACTION_VARS) {
    if (values[v] === undefined) delete process.env[v];
    else process.env[v] = values[v];
  }
  t.after(() => {
    for (const [v, value] of saved) {
      if (value === undefined) delete process.env[v];
      else process.env[v] = value;
    }
  });
}

/**
 * Messages sent, parsed, and the stamps patched, per document id. `failSend` makes every send throw,
 * `failSendFor` only the send for that document id.
 */
function fakeQueueAndStore(t, { failSend = false, failSendFor = null, failStamp = false } = {}) {
  const sent = [];
  const queues = [];
  const stamps = new Map();
  t.mock.method(queueClient, 'queueClientFor', ({ name }) => {
    queues.push(name);
    return {
      async sendMessage(body) {
        const message = JSON.parse(body);
        if (failSend || message.documentId === failSendFor) throw new Error('queue down');
        sent.push(message);
      }
    };
  });
  t.mock.method(cosmos, 'patch', async (container, id, partitionKey, operations) => {
    if (failStamp) throw Object.assign(new Error('not found'), { code: 404 });
    stamps.set(id, { container, partitionKey, operations });
    return {};
  });
  return { sent, queues, stamps };
}

/** A row every skip rule lets through. */
const queueable = (overrides = {}) => ({
  id: 'doc-1', projectId: '207', documentSource: 'PROJECT', scanStatus: 'clean',
  isDeleted: false, s3Key: '207/0123456789abcdef0123456789abcdef.pdf', contentExtracted: false,
  ...overrides
});

module.exports = { QUEUE, setExtractionEnv, fakeQueueAndStore, queueable };
