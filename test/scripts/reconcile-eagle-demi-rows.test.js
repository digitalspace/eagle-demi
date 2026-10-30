'use strict';

// Reconcile and rows DEMI creates itself: one born in DEMI is not gone from Eagle, and once sync-out
// creates its Eagle copy, that copy (named by the row's `eagleId`) is not missing from DEMI.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const sources = require('../../src/seed/sources');
const { listsSummary, reconcile } = require('../../src/scripts/reconcile-eagle');

const EAGLE_ORG = { id: '5c1f7a3e9b1d2c0012340001', kind: 'Organization', sourceSystem: 'eagle', read: ['public'], isPublished: true };
const DEMI_ORG = { id: '0b7c3d5e-1f2a-4b6c-8d9e-0a1b2c3d4e5f', kind: 'Organization', sourceSystem: 'demi', read: ['public'], isPublished: true };
const COPIED_ORG = { ...DEMI_ORG, id: '1c8d4e6f-2a3b-4c7d-9e0f-1b2c3d4e5f60', eagleId: '5c1f7a3e9b1d2c0012340003' };
const GONE_ORG = { id: '5c1f7a3e9b1d2c0012340002', kind: 'Organization', sourceSystem: 'eagle', read: ['public'], isPublished: true };

test('an organization created in DEMI is counted but is not drift', () => {
  const summary = listsSummary([EAGLE_ORG, DEMI_ORG], new Set([EAGLE_ORG.id]), new Map([[EAGLE_ORG.id, ['public']]]));

  assert.strictEqual(summary.inDemi, 2);
  assert.deepStrictEqual(summary.unpublishedOrDeleted, []);
  assert.deepStrictEqual(summary.aclMismatch, []);
});

test('an Eagle-mirrored organization Eagle no longer publishes is still drift', () => {
  const summary = listsSummary([EAGLE_ORG, GONE_ORG, DEMI_ORG], new Set([EAGLE_ORG.id]), new Map());

  assert.deepStrictEqual(summary.unpublishedOrDeleted.map(row => row.id), [GONE_ORG.id]);
});

test('an organization created in DEMI and then in Eagle holds its Eagle copy', () => {
  const summary = listsSummary([COPIED_ORG], new Set([COPIED_ORG.eagleId]), new Map());

  assert.deepStrictEqual(summary.eagleOnly, []);
});

const EAGLE_API_BASE = 'https://eagle-test.example/api/public';
const PROJECT = { id: 'p-1', eagleId: 'P1', sourceSystem: 'eagle', read: ['public'], isPublished: true };
const COPIED_PERIOD = { id: '2d9e5f70-3b4c-4d8e-8f10-2c3d4e5f6071', projectId: PROJECT.id, sourceSystem: 'demi',
  eagleId: '5c1f7a3e9b1d2c0012340004', read: ['public'], isPublished: true };

/** Every reconcile read stubbed: Eagle publishes project P1 and one period, DEMI holds both. */
function periodDeps() {
  const { PAGE_SIZE, freshById, settledTotal } = sources;
  const datasets = {
    CommentPeriod: [{ _id: COPIED_PERIOD.eagleId, project: PROJECT.eagleId, read: ['public'] }],
    ProjectNotification: [], Organization: [], List: [], RecentActivity: []
  };
  const none = async () => [];
  const zero = async () => 0;
  return {
    sources: {
      PAGE_SIZE, freshById, settledTotal, EAGLE_API_BASE,
      loadTrackProjects: () => [],
      fetchEagleProjects: async () => [{ _id: PROJECT.eagleId, read: ['public'] }],
      fetchAllPages: async (base, dataset) => datasets[dataset],
      streamEagleDocuments: async () => ({ count: 0, total: 0 })
    },
    projects: { listWithEagleId: async () => [PROJECT], countWithEagleId: async () => 1 },
    documents: { listSeededIds: none, countSeededIds: zero, countParentFieldsPending: zero },
    commentPeriods: {
      listEveryByProject: async projectId => (projectId === PROJECT.id ? [COPIED_PERIOD] : []),
      countByProject: async projectId => (projectId === PROJECT.id ? 1 : 0)
    },
    lists: { KINDS: { LIST: 'List', ORGANIZATION: 'Organization' }, listEveryOfKind: none, countByKind: zero },
    notifications: { listEvery: none, count: zero },
    updates: { listEvery: none, count: zero },
    users: { listAclRows: none },
    groups: { listAclRows: none },
    inspections: { listAclRows: none }
  };
}

test('a comment period created in DEMI and then in Eagle holds its Eagle copy', async () => {
  const summary = await reconcile([], periodDeps());

  assert.deepStrictEqual(summary.commentPeriods.eagleOnly, []);
});
