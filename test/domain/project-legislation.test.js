'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { lockRefusal } = require('../../src/domain/project-legislation');

const BCA = { legislationYear: 2025, legislation: 'Building Canada Act' };

test('lockRefusal', async (t) => {
  await t.test('another year on a locked Act is refused', () => {
    assert.strictEqual(lockRefusal(BCA, { legislationYear: 2018 }), 'Project is under the Building Canada Act');
  });

  await t.test('clearing the year on a locked Act is refused', () => {
    assert.ok(lockRefusal(BCA, { legislationYear: null }));
  });

  await t.test('another label on a locked Act is refused', () => {
    assert.ok(lockRefusal(BCA, { legislation: '2018 Environmental Assessment Act' }));
  });

  await t.test('naming the locked year and label again is allowed', () => {
    assert.strictEqual(lockRefusal(BCA, { legislationYear: 2025, legislation: 'Building Canada Act' }), null);
  });

  await t.test('a write that names neither field is allowed', () => {
    assert.strictEqual(lockRefusal(BCA, { name: 'Renamed' }), null);
  });

  await t.test('a year stored as a string still locks', () => {
    assert.ok(lockRefusal({ legislationYear: '2025' }, { legislationYear: 2002 }));
  });

  await t.test('a row with only the label still locks', () => {
    assert.ok(lockRefusal({ legislation: 'Building Canada Act' }, { legislationYear: 2002 }));
  });

  await t.test('an unlocked Act may move', () => {
    assert.strictEqual(lockRefusal({ legislationYear: 2002 }, { legislationYear: 2025 }), null);
  });

  await t.test('a row with no Act may move', () => {
    assert.strictEqual(lockRefusal({}, { legislationYear: 2018 }), null);
  });
});
