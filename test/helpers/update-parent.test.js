'use strict';

/**
 * `helpers/update-parent:updateRead`, the one rule for an Update's stored `read[]`: Eagle's own under
 * the parent's ceiling, except a legacy open row (no read, no status, active), which takes the
 * parent's read. eagle-api shows a missing read to anonymous callers and prunes `read: []`.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { updateRead, inheritsParentRead, readUnder } = require('../../src/helpers/update-parent');
const { PUBLIC_ACL, PRIVATE_ACL } = require('./eagle-mirror-fixtures');

// Spelled out, not built from readForLevel, so the assertion cannot agree with any helper output.
const PUBLIC_PARENT = { id: '207', read: ['staff', 'idir', 'public'] };
const PRIVATE_PARENT = { id: '207', read: PRIVATE_ACL };

/** An Eagle `RecentActivity` as the pre-2025 migration left it: no `read` field at all. */
const legacy = (extra = {}) => ({ status: null, active: true, ...extra });

test('updateRead — a legacy open update takes its parent\'s read', async (t) => {
  await t.test('missing read, null status, active: the parent\'s read', () => {
    assert.deepStrictEqual(updateRead(legacy(), PUBLIC_PARENT), ['staff', 'idir', 'public']);
    assert.deepStrictEqual(updateRead(legacy(), PRIVATE_PARENT), PRIVATE_ACL);
  });

  await t.test('a null read and a missing status count as missing', () => {
    assert.deepStrictEqual(updateRead({ active: true }, PUBLIC_PARENT), ['staff', 'idir', 'public']);
    assert.deepStrictEqual(updateRead(legacy({ read: null, status: undefined }), PUBLIC_PARENT),
      ['staff', 'idir', 'public']);
  });

  await t.test('under a parent an Eagle push sealed, the read that parent\'s next push lands', () => {
    const parent = {
      id: '207', read: ['compliance'], doc: { read: ['compliance'], sources: { eagle: { read: ['compliance', 'public'] } } }
    };
    assert.deepStrictEqual(updateRead(legacy(), parent), ['public']);
  });

  await t.test('no parent, nothing to inherit', () => {
    assert.deepStrictEqual(updateRead(legacy(), null), []);
  });
});

test('updateRead — every other update keeps today\'s rule', async (t) => {
  await t.test('an empty read is a read, not a missing one: eagle-api prunes it, so it stays []', () => {
    assert.strictEqual(inheritsParentRead(legacy({ read: [] })), false);
    assert.deepStrictEqual(updateRead(legacy({ read: [] }), PUBLIC_PARENT), []);
  });

  await t.test('missing read with a status stays []', () => {
    assert.deepStrictEqual(updateRead(legacy({ status: 'published' }), PUBLIC_PARENT), []);
    assert.deepStrictEqual(updateRead(legacy({ status: 'draft' }), PUBLIC_PARENT), []);
  });

  await t.test('missing read on an inactive row stays []', () => {
    assert.deepStrictEqual(updateRead(legacy({ active: false }), PUBLIC_PARENT), []);
    assert.deepStrictEqual(updateRead(legacy({ active: undefined }), PUBLIC_PARENT), []);
  });

  await t.test('a non-empty read is its own, and still capped by the parent', () => {
    assert.deepStrictEqual(updateRead(legacy({ read: PUBLIC_ACL }), PUBLIC_PARENT), PUBLIC_ACL);
    assert.deepStrictEqual(updateRead(legacy({ read: PUBLIC_ACL }), PRIVATE_PARENT), ['staff']);
    assert.deepStrictEqual(updateRead(legacy({ read: ['sysadmin'] }), PUBLIC_PARENT), ['sysadmin']);
  });

  await t.test('a read that is not a list is not missing: stored as [], never widened', () => {
    assert.strictEqual(inheritsParentRead(legacy({ read: 'public' })), false);
    assert.deepStrictEqual(updateRead(legacy({ read: 'public' }), PUBLIC_PARENT), []);
  });
});

test('readUnder — an Eagle read with no ladder token is never opened to team', async (t) => {
  for (const parent of [['team'], ['sysadmin'], [], ['project-team'], ['staff'], ['staff', 'idir', 'public']]) {
    await t.test(`under parent ${JSON.stringify(parent)} it stays ['sysadmin']`, () => {
      assert.deepStrictEqual(readUnder(['sysadmin'], { read: parent }), ['sysadmin']);
    });
  }

  await t.test('a ladder read above its parent is capped', () => {
    assert.deepStrictEqual(readUnder(['sysadmin', 'public'], { read: ['staff'] }), ['staff']);
  });

  await t.test('an empty read under a sealed parent is sealed, as before', () => {
    assert.deepStrictEqual(readUnder([], { read: ['compliance'], doc: { sealedAt: 'x' } }), ['compliance']);
  });
});
