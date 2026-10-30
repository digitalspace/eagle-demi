'use strict';

// Reconcile and rows DEMI creates itself: one born in DEMI is not gone from Eagle, and once sync-out
// creates its Eagle copy, that copy (named by the row's `eagleId`) is not missing from DEMI.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { listsSummary } = require('../../src/scripts/reconcile-eagle');

const EAGLE_ORG = { id: '5c1f7a3e9b1d2c0012340001', kind: 'Organization', sourceSystem: 'eagle', read: ['public'], isPublished: true };
const DEMI_ORG = { id: '0b7c3d5e-1f2a-4b6c-8d9e-0a1b2c3d4e5f', kind: 'Organization', sourceSystem: 'demi', read: ['public'], isPublished: true };
const COPIED_ORG = { ...DEMI_ORG, id: '1c8d4e6f-2a3b-4c7d-9e0f-1b2c3d4e5f60', eagleId: '5c1f7a3e9b1d2c0012340003' };
const GONE_ORG = { id: '5c1f7a3e9b1d2c0012340002', kind: 'Organization', sourceSystem: 'eagle', read: ['public'], isPublished: true };
const UNCLAIMED_ID = '5c1f7a3e9b1d2c0012340004';

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

test('an organization created in DEMI and then in Eagle holds its Eagle copy and no other', () => {
  const summary = listsSummary([COPIED_ORG], new Set([COPIED_ORG.eagleId, UNCLAIMED_ID]), new Map());

  assert.deepStrictEqual(summary.eagleOnly, [UNCLAIMED_ID]);
});

// Reporting a lost Eagle copy needs the row's own read[] (only a public row is in Eagle's id set): later slice.
test('an organization whose Eagle copy is gone is in no drift bucket', () => {
  const summary = listsSummary([COPIED_ORG], new Set(), new Map());

  assert.deepStrictEqual(summary.eagleOnly, []);
  assert.deepStrictEqual(summary.unpublishedOrDeleted, []);
});
