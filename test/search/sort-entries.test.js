'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { sortEntries } = require('../../src/search/sort-entries');

test('sortEntries', async (t) => {
  await t.test('a comma-joined value from eagle-admin yields one entry per key, trimmed', () => {
    assert.deepStrictEqual(sortEntries('-datePosted, +displayName'), ['-datePosted', '+displayName']);
  });

  await t.test('empty pieces of a comma-joined value are dropped', () => {
    assert.deepStrictEqual(sortEntries(['-datePosted,,', '']), ['-datePosted']);
  });
});
