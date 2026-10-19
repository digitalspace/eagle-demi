'use strict';

/** Every legislation block an Eagle push sends is kept in `sources.eagle`, never on the row's top level. */

const test = require('node:test');
const assert = require('node:assert');

const { mergeEagleOnlyProject } = require('../../src/merge/project');

const RAW = {
  _id: '5850d1b4652f7e0019b52c0e',
  read: ['public', 'staff', 'sysadmin'],
  currentLegislationYear: 'legislation_2018',
  legislationYearList: [2002, 2018],
  legislation_2002: { name: 'Mine 2002', legislationYear: 2002 },
  legislation_2018: { name: 'Mine 2018', legislationYear: 2018 }
};

test('legislation blocks on an Eagle merge', async (t) => {
  await t.test('the current block is the top level', () => {
    assert.strictEqual(mergeEagleOnlyProject(RAW).name, 'Mine 2018');
  });

  await t.test('a block that is not current is kept in sources.eagle', () => {
    assert.strictEqual(mergeEagleOnlyProject(RAW).sources.eagle.legislation_2002.name, 'Mine 2002');
  });

  await t.test('no block reaches the top level of the row', () => {
    assert.strictEqual(mergeEagleOnlyProject(RAW).legislation_2002, undefined);
  });
});
