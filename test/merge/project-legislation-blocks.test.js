'use strict';

/** Every legislation block an Eagle push sends is kept on the row, less both extension lists, and whole in `sources.eagle`. */

const test = require('node:test');
const assert = require('node:assert');

const trackProjects = require('../../src/data/track_projects_enriched.json');
const { mergeEagleOnlyProject, mergeTrackProject } = require('../../src/merge/project');

const OPTS = { now: '2026-07-30T00:00:00.000Z' };
const TRACK_207 = trackProjects.find(p => p.track_project_id === 207);

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

  await t.test('a block that is not current is on the row', () => {
    assert.strictEqual(mergeEagleOnlyProject(RAW).legislation_2002.name, 'Mine 2002');
  });

  await t.test('the current year and the year list are on the row', () => {
    const row = mergeEagleOnlyProject(RAW);
    assert.deepStrictEqual([row.currentLegislationYear, row.legislationYearList], ['legislation_2018', [2002, 2018]]);
  });

  await t.test('the merged legislation blocks hold no extension lists; sources.eagle keeps them', () => {
    const extension = { type: 'Extension', appliedTo: 'Application review' };
    const raw = {
      _id: TRACK_207.epic_guid,
      read: ['public'],
      currentLegislationYear: 'legislation_2018',
      legislationYearList: [2002, 2018],
      legislation_2002: { name: 'Old Name', reviewExtensions: [extension], reviewSuspensions: [] },
      legislation_2018: { name: 'New Name', reviewExtensions: [extension], reviewSuspensions: [] }
    };

    const tracked = mergeTrackProject(TRACK_207, raw, OPTS);
    const eagleOnly = mergeEagleOnlyProject(raw, OPTS);
    const blockKeys = (merged) => [Object.keys(merged.legislation_2002), Object.keys(merged.legislation_2018)];

    assert.deepStrictEqual(blockKeys(tracked), [['name'], ['name']]);
    assert.deepStrictEqual(blockKeys(eagleOnly), [['name'], ['name']]);
    assert.deepStrictEqual(tracked.sources.eagle.legislation_2002.reviewExtensions, [extension]);
  });
});
