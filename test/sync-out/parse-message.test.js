'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const syncOut = require('../../src/sync-out');
const restamp = require('../../src/jobs/restamp-chunks');

test('an unparseable sync-out message is named as one', async () => {
  await assert.rejects(syncOut.run('x', { attempt: 1, maxAttempts: 2 }), { message: /^sync-out message is not JSON: / });
});

test('an unparseable chunk restamp message is named as one', () => {
  assert.throws(() => restamp.parseMessage('x'), { message: /^chunk restamp message is not JSON: / });
});
