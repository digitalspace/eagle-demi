'use strict';

// Reconcile and rows DEMI creates itself: an organization born in DEMI has no Eagle copy, so it
// must not read as gone from Eagle and trip the nightly drift alert.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { listsSummary } = require('../../src/scripts/reconcile-eagle');

const EAGLE_ORG = { id: '5c1f7a3e9b1d2c0012340001', kind: 'Organization', sourceSystem: 'eagle', read: ['public'], isPublished: true };
const DEMI_ORG = { id: '0b7c3d5e-1f2a-4b6c-8d9e-0a1b2c3d4e5f', kind: 'Organization', sourceSystem: 'demi', read: ['public'], isPublished: true };
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
