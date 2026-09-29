'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { normalizeSubType } = require('../../src/search/sub-type');

test('normalizeSubType', async (t) => {
  await t.test('a name eagle-admin already uses passes through, trimmed', () => {
    assert.strictEqual(normalizeSubType('  Coal Mines '), 'Coal Mines');
    assert.strictEqual(normalizeSubType('Transmission Pipelines'), 'Transmission Pipelines');
  });

  await t.test('empty or missing is null, so the caller falls through to its default', () => {
    for (const value of [undefined, null, '', '   ', 42, {}]) {
      assert.strictEqual(normalizeSubType(value), null, `for ${JSON.stringify(value)}`);
    }
  });

  await t.test('Transmission Lines takes the eagle-admin name under every Act', () => {
    for (const year of [undefined, 2002, 2018]) {
      assert.strictEqual(normalizeSubType('Transmission Lines', year), 'Electric Transmission Lines');
    }
  });

  await t.test('solid waste follows the legislation year', () => {
    const name = 'Solid Waste Management Facilities';
    const LOCAL = 'Local Government Solid Waste Management Facilities';
    assert.strictEqual(normalizeSubType(name, 2002), LOCAL);
    assert.strictEqual(normalizeSubType(name, 1996), LOCAL, '2002 or earlier');
    // Eagle's `legislation` is the Act label, not the bare year.
    assert.strictEqual(normalizeSubType(name, '2002 Environmental Assessment Act'), LOCAL);
    assert.strictEqual(normalizeSubType(name, 2018), 'Solid Waste Management');
    assert.strictEqual(normalizeSubType(name, '2018 Environmental Assessment Act'),
      'Solid Waste Management');
    assert.strictEqual(normalizeSubType(name), 'Solid Waste Management', 'no year reads as 2018');
    assert.strictEqual(normalizeSubType(name, 'unknown'), 'Solid Waste Management');
  });

  await t.test('marine port takes the 2002 name only under the 2002 Act or earlier', () => {
    const name = 'Marine Port Projects';
    assert.strictEqual(normalizeSubType(name, 2002), 'Marine Port Facilities');
    assert.strictEqual(normalizeSubType(name, '2002 Environmental Assessment Act'),
      'Marine Port Facilities');
    assert.strictEqual(normalizeSubType(name, 1996), 'Marine Port Facilities');
    assert.strictEqual(normalizeSubType(name, 2018), name);
    assert.strictEqual(normalizeSubType(name), name, 'no year reads as 2018');
  });
});
