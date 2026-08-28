'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { ROLE_LEVELS, levelFromRoles } = require('../../src/vis/level');

// Every expectation is a literal. Re-running levelFromRoles to build the expected value would
// pass against any table, including an empty one.

test('levelFromRoles', async (t) => {
  await t.test('a role table entry maps to its level', () => {
    assert.strictEqual(levelFromRoles(['sysadmin']), 0);
    assert.strictEqual(levelFromRoles(['demi-admin']), 0);
    assert.strictEqual(levelFromRoles(['staff']), 2);
    assert.strictEqual(levelFromRoles(['demi-service-read']), 2);
    assert.strictEqual(levelFromRoles(['demi-service-write']), 2);
    assert.strictEqual(levelFromRoles(['compliance']), 2);
    assert.strictEqual(levelFromRoles(['public']), 4);
  });

  await t.test('the lowest level of several roles wins', () => {
    assert.strictEqual(levelFromRoles(['public', 'sysadmin']), 0);
    assert.strictEqual(levelFromRoles(['public', 'staff']), 2);
    assert.strictEqual(levelFromRoles(['staff', 'demi-admin']), 0);
  });

  await t.test('an unknown role does not grant a level', () => {
    assert.strictEqual(levelFromRoles(['not-a-role']), 4);
    assert.strictEqual(levelFromRoles(['not-a-role', 'staff']), 2);
    assert.strictEqual(levelFromRoles(['project:207']), 4);
  });

  await t.test('no roles at all is anonymous', () => {
    assert.strictEqual(levelFromRoles([]), 4);
    assert.strictEqual(levelFromRoles(undefined), 4);
    assert.strictEqual(levelFromRoles(null), 4);
    assert.strictEqual(levelFromRoles('staff'), 4);
  });

  await t.test('compliance is in the table', () => {
    // Grantable on an API key (src/controllers/nosql/api-key.js:31), so it must carry a level.
    assert.strictEqual(ROLE_LEVELS.compliance, 2);
  });

  await t.test('no role maps to level 1 or 3 before Phase 3', () => {
    assert.deepStrictEqual(Object.values(ROLE_LEVELS).filter(l => l === 1), []);
    assert.deepStrictEqual(Object.values(ROLE_LEVELS).filter(l => l === 3), []);
  });
});
