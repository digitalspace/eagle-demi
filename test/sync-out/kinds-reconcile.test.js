'use strict';

// Each registered kind's reconcile hook, as the nightly timer and the CLI reach it: a create whose
// lease lapsed is re-queued once as a repair, through the kind's real consumer and lease rule.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const commentPeriods = require('../../src/repositories/comment-periods');
const documents = require('../../src/repositories/documents');
const lists = require('../../src/repositories/lists');
const projects = require('../../src/repositories/projects');
const { logger } = require('../../src/utils/logger');
const { KINDS, COMMENT_PERIOD, DOCUMENT, ORGANIZATION, PROJECT, kindOf } = require('../../src/sync-out/kinds');
const { API, useEnv, wireQueue, wireEagle } = require('../helpers/sync-out-eagle');

const ENV = {
  SYNC_OUT_EAGLE_ENABLED: 'true',
  SYNC_OUT_EAGLE_NATIVE_ENABLED: 'true',
  SYNC_OUT_EAGLE_DOCUMENT_ENABLED: 'true',
  SYNC_OUT_EAGLE_ORGANIZATION_ENABLED: 'true',
  SYNC_OUT_EAGLE_PROJECT_ENABLED: 'true',
  EAGLE_PROTECTED_API_BASE: API,
  EAGLE_KC_CLIENT_ID: 'demi-sync-out',
  EAGLE_KC_CLIENT_SECRET: 'not-a-real-value'
};
const EAGLE_ID = '6720b3c0a1b2c3d4e5f60718';
const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();
const lapsedClaim = (extra = {}) =>
  ({ eagle: { status: 'creating', claim: 'c-1', claimedAt: minutesAgo(10), sentVersion: 1, ...extra } });

const ROWS = {
  [COMMENT_PERIOD]: { repo: commentPeriods, row: {
    id: 'lapsed', projectId: 'p-207', sourceSystem: 'demi', eagleId: EAGLE_ID, syncVersion: 2, syncOut: lapsedClaim() } },
  [DOCUMENT]: { repo: documents, row: {
    id: 'lapsed', projectId: '1234', sourceSystem: 'demi', eagleId: EAGLE_ID, syncVersion: 2, syncOut: lapsedClaim() } },
  [ORGANIZATION]: { repo: lists, row: {
    id: 'lapsed', kind: 'Organization', projectId: null, sourceSystem: 'demi', eagleId: EAGLE_ID, syncVersion: 2,
    syncOut: lapsedClaim() } },
  [PROJECT]: { repo: projects, row: {
    id: 'lapsed', sourceSystem: 'track', sources: {}, eagleId: EAGLE_ID, syncVersion: 2,
    syncOut: lapsedClaim({ mintedId: EAGLE_ID }) } }
};

/** Env on, logger quiet, no eagle-api call allowed, and `engage` as the ENGAGE rows the comment period pass reads. */
function wire(t, { engage = [] } = {}) {
  useEnv(t, ENV);
  t.mock.method(logger, 'info', () => {});
  t.mock.method(logger, 'warn', () => {});
  wireEagle(t, {});
  const order = [];
  t.mock.method(commentPeriods, 'listEveryEngage', async () => { order.push('engage'); return engage; });
  return { sent: wireQueue(t), order };
}

test('every registered kind has a case here', () => {
  assert.deepStrictEqual(Object.keys(ROWS).sort(), Object.keys(KINDS).sort());
});

for (const [kind, { repo, row }] of Object.entries(ROWS)) {
  test(`${kind}: a create claim whose lease lapsed is re-queued once as a repair`, async (t) => {
    const { sent } = wire(t);
    t.mock.method(repo, 'listSyncPending', async () => [structuredClone(row)]);

    const report = await kindOf(kind).reconcile({ repair: true });

    assert.deepStrictEqual(sent.map(m => [m.body.kind, m.body.id, m.body.repair]), [[kind, 'lapsed', true]]);
    assert.deepStrictEqual({ queued: report.queued, failed: report.failed }, { queued: 1, failed: [] });
  });
}

test('commentPeriod: the ENGAGE checks run before the pending hook, and a row both re-queue is sent once', async (t) => {
  const engageRow = {
    id: 'engage-1', projectId: 'p-207', sourceSystem: 'engage', engagementId: 41,
    metURL: 'https://engage.example/e/41', syncVersion: 1
  };
  const { sent, order } = wire(t, { engage: [engageRow] });
  t.mock.method(commentPeriods, 'readForWrite', async () => structuredClone(engageRow));
  t.mock.method(commentPeriods, 'listSyncPending', async () => {
    order.push('pending');
    return [structuredClone(ROWS[COMMENT_PERIOD].row), structuredClone(engageRow)];
  });

  const report = await kindOf(COMMENT_PERIOD).reconcile({ repair: true });

  assert.deepStrictEqual(order, ['engage', 'pending']);
  assert.deepStrictEqual(report.engage.neverSynced.map(f => f.id), ['engage-1']);
  assert.deepStrictEqual(sent.map(m => m.body.id), ['engage-1', 'lapsed']);
});
