'use strict';

// A write that has landed must answer even when its sync-out queue call hangs.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const syncOut = require('../../src/sync-out');
const { DOCUMENT } = require('../../src/sync-out/kinds');
const { logger } = require('../../src/utils/logger');

test('enqueueQuietly answers once a stuck enqueue times out, and its late failure is still logged', async (t) => {
  let entered;
  let fail;
  const called = new Promise((resolve) => { entered = resolve; });
  t.mock.method(syncOut, 'enqueue', () => {
    entered();
    return new Promise((_resolve, reject) => { fail = reject; });
  });
  const errors = t.mock.method(logger, 'error', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const answered = syncOut.enqueueQuietly({ id: 'd1', projectId: '207' }, { kind: DOCUMENT });
  await called;
  t.mock.timers.tick(5000);
  assert.deepStrictEqual(await answered, []);
  fail(new Error('queue down'));
  await new Promise(resolve => setImmediate(resolve));

  assert.deepStrictEqual(errors.mock.calls.map(c => c.arguments[0]),
    ['[sync-out] enqueue timed out', '[sync-out] enqueue failed after timeout']);
});
