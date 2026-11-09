'use strict';

// The comment period hook as the timer and CLI reach it: ENGAGE checks, then the pending hook, which re-queues
// a send claim (`creating`) whose lease lapsed. Other kinds' hooks: pending.test.js.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cache = require('../../src/repositories/cache');
const commentPeriods = require('../../src/repositories/comment-periods');
const { logger } = require('../../src/utils/logger');
const { COMMENT_PERIOD } = require('../../src/sync-out/kinds');
const { reconcileOf } = require('../../src/sync-out/reconcile');
const { run } = require('../../src/scripts/sync-out-pending');
const { API, useEnv, wireQueue, wireEagle } = require('../helpers/sync-out-eagle');

const ENV = {
  SYNC_OUT_EAGLE_ENABLED: 'true',
  SYNC_OUT_EAGLE_NATIVE_ENABLED: 'true',
  EAGLE_PROTECTED_API_BASE: API,
  EAGLE_KC_CLIENT_ID: 'demi-sync-out',
  EAGLE_KC_CLIENT_SECRET: 'not-a-real-value'
};
const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();
const lapsedRow = () => ({
  id: 'lapsed', projectId: 'p-207', sourceSystem: 'demi', eagleId: '6720b3c0a1b2c3d4e5f60718', syncVersion: 2,
  syncOut: { eagle: { status: 'creating', claim: 'c-1', claimedAt: minutesAgo(10), sentVersion: 1 } }
});
const engageRow = () => ({
  id: 'engage-1', projectId: 'p-207', sourceSystem: 'engage', engagementId: 41,
  metURL: 'https://engage.example/e/41', syncVersion: 1
});

/**
 * Env on, no eagle-api call allowed, and the repository serving `engage` to the ENGAGE pass and `pending` to the
 * pending pass, each read recorded in `order`.
 */
function wire(t, { engage = [], pending = [lapsedRow()], listEveryEngage, readForWrite, env = {} } = {}) {
  useEnv(t, { ...ENV, ...env });
  t.mock.method(logger, 'info', () => {});
  t.mock.method(logger, 'warn', () => {});
  const error = t.mock.method(logger, 'error', () => {});
  wireEagle(t, {});
  const order = [];
  t.mock.method(commentPeriods, 'listEveryEngage', listEveryEngage || (async () => { order.push('engage'); return engage; }));
  t.mock.method(commentPeriods, 'readForWrite', readForWrite || (async (id) => engage.find(r => r.id === id) || null));
  t.mock.method(commentPeriods, 'listSyncPending', async () => { order.push('pending'); return pending; });
  return { sent: wireQueue(t), order, error };
}

test('the ENGAGE checks run before the pending pass, and their report rides under engage', async (t) => {
  const { order } = wire(t, { engage: [engageRow()] });

  const report = await reconcileOf(COMMENT_PERIOD)({ repair: true });

  assert.deepStrictEqual(order, ['engage', 'pending']);
  assert.deepStrictEqual(report.engage.neverSynced.map(f => f.id), ['engage-1']);
});

test('the nightly store run lists both passes, queues nothing and stores the ENGAGE report', async (t) => {
  const { sent } = wire(t, { engage: [engageRow()], pending: [lapsedRow(), engageRow()] });
  const stored = [];
  t.mock.method(cache, 'put', async (id, value) => { stored.push({ id, value }); });

  const report = await reconcileOf(COMMENT_PERIOD)({ store: true });

  assert.deepStrictEqual(report.listed, ['lapsed', 'engage-1']);
  assert.deepStrictEqual(sent, []);
  assert.deepStrictEqual(stored.map(s => [s.id, s.value.body.neverSynced.map(f => f.id)]),
    [[cache.RECONCILE_ENGAGE_REPORT_ID, ['engage-1']]]);
});

test('an ENGAGE pass that throws is logged as an error and the lapsed send claim is still re-queued', async (t) => {
  const { sent, error } = wire(t, { listEveryEngage: async () => { throw new Error('cosmos down'); } });

  const report = await reconcileOf(COMMENT_PERIOD)({ repair: true });

  assert.deepStrictEqual(report.engage, { error: 'cosmos down' });
  assert.deepStrictEqual(sent.map(m => [m.body.kind, m.body.id, m.body.repair]), [[COMMENT_PERIOD, 'lapsed', true]]);
  assert.deepStrictEqual({ queued: report.queued, failed: report.failed }, { queued: 1, failed: [] });
  assert.deepStrictEqual(error.mock.calls.map(c => [c.arguments[0], c.arguments[1].error]),
    [['[sync-out pending] commentPeriod: ENGAGE checks failed, pending pass runs anyway', 'cosmos down']]);
});

test('the CLI runs the comment period hook, ENGAGE checks first', async (t) => {
  const { order, sent } = wire(t);

  await run({ kind: COMMENT_PERIOD, repair: true });

  assert.deepStrictEqual(order, ['engage', 'pending']);
  assert.deepStrictEqual(sent.map(m => m.body.id), ['lapsed']);
});

test('an ENGAGE row whose repair throws fails the CLI, named apart from pending rows', async (t) => {
  wire(t, { engage: [engageRow()], readForWrite: async () => { throw new Error('read lost'); } });

  await assert.rejects(run({ kind: COMMENT_PERIOD, repair: true }), {
    message: '1 ENGAGE row(s) not re-queued: engage-1'
  });
});

test('with SYNC_OUT_EAGLE_ENABLED off every ENGAGE repair candidate is reported not re-queued', async (t) => {
  wire(t, { engage: [engageRow()], env: { SYNC_OUT_EAGLE_ENABLED: 'false' } });

  const report = await reconcileOf(COMMENT_PERIOD)({ repair: true });

  assert.deepStrictEqual(report.engage.notRequeued, ['engage-1']);
});

test('an ENGAGE repair candidate no consumer takes is reported not re-queued', async (t) => {
  wire(t, { engage: [{ ...engageRow(), scanStatus: 'pending' }] });

  const report = await reconcileOf(COMMENT_PERIOD)({ repair: true });

  assert.deepStrictEqual(report.engage.notRequeued, ['engage-1']);
});
