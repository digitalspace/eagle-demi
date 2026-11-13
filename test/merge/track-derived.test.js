'use strict';

/** Project values derived from works of any source: Act years, the Assessment pick, active work, transitions. */

const test = require('node:test');
const assert = require('node:assert');

const { pickAssessmentWork, workActYear } = require('../../src/merge/assessment-work');
const { activeWorkOf, legislationTransitions, trackPhasesOf } = require('../../src/merge/track-derived');
const { publicWorksOf } = require('../../src/seed/track-mappers');

const ROW = { id: '1001', name: 'Made-up Mine' };
const MILESTONE = 'Project Transitioning FROM the EA Act (2002)';

/** A made-up stored sheet Assessment under the 2002 Act. */
const sheetDoc = (n, fields = {}) => ({
  id: `sheet-00000000-0000-4000-8000-00000000000${n}`, projectId: '1001', source: 'sheet', owner: 'sheet',
  workTypeCode: 'assessment', actYear: 2002, startDate: '2004-02-01', phases: [], ...fields
});

/** A made-up stored Track Assessment holding the transition milestone dated `actualDate`. */
const trackDoc = (actualDate) => ({
  id: 'track-31', projectId: '1001', source: 'track', trackWorkId: 31, workTypeId: 6, startDate: '2025-01-10',
  phases: [{ name: 'Early Engagement', milestones: [{ name: MILESTONE, actualDate }] }]
});

const sheetWork = (n, fields = {}) => publicWorksOf([sheetDoc(n, fields)], ROW)[0];

test('sheet work has no 2018 default', () => {
  assert.strictEqual(workActYear({ source: 'sheet', workTypeCode: 'assessment' }), null);
  assert.strictEqual(workActYear({ source: 'sheet', actYear: 1996, eaAct: '2018 Act' }), 1996, 'actYear comes first');
});

test('the Assessment pick breaks a tie between sheet works on the work id', () => {
  const works = [sheetWork(1), sheetWork(3), sheetWork(2)];

  assert.strictEqual(pickAssessmentWork(works).workId, sheetDoc(3).id);
});

test('sheet assessment phases appear under their actYear', () => {
  const work = sheetWork(1, { phases: [{ id: 'pre-application', name: 'Pre-Application', sortOrder: 1 }] });

  const phases = trackPhasesOf({ works: [work], phases: [] }, () => 2018);

  assert.deepStrictEqual(phases.map(one => [one.phase.name, one.year]), [['Pre-Application', 2002]]);
});

test('activeWork carries workId for a sheet work', () => {
  const work = sheetWork(1, { isActive: true });

  const active = activeWorkOf({ works: [work] }, null);

  assert.strictEqual(active.workId, work.workId);
  assert.strictEqual(active.trackWorkId, null);
});

test('legislationTransitions with sheet transitionOut', async (t) => {
  const handOver = (date, dateSource) => ({ actYear: 1996, transitionOut: { toActYear: 2002, date, dateSource } });

  await t.test('sheet transitionOut adds the 1996-2002 pair when Eagle\'s list lacks it', () => {
    const works = publicWorksOf([sheetDoc(1, handOver('2003-02-01', 'sheet'))], ROW);

    assert.deepStrictEqual(legislationTransitions([2002, 2018], works), [
      { fromYear: 1996, toYear: 2002, date: '2003-02-01' },
      { fromYear: 2002, toYear: 2018, date: null }
    ]);
  });

  await t.test('sheet date before 2025 beats Track\'s milestone date', () => {
    const out = { transitionOut: { toActYear: 2018, date: '2021-03-01', dateSource: 'sheet' } };
    const works = publicWorksOf([trackDoc('2025-05-30T00:00:00.000Z'), sheetDoc(1, out)], ROW);

    assert.strictEqual(legislationTransitions([2002, 2018], works)[0].date, '2021-03-01');
  });

  const fallback477 = { transitionOut: { toActYear: 2018, date: '2025-05-21', dateSource: 'track' } };
  const publicDateOf = (works) => works.find(work => work.source === 'sheet').transitionOut.date;

  await t.test('477: Track\'s milestone beats the fallback, the same date as the public transitionOut', () => {
    const works = publicWorksOf([trackDoc('2025-05-30T19:00:00.000Z'), sheetDoc(1, fallback477)], ROW);

    const [{ date }] = legislationTransitions([2002, 2018], works);

    assert.strictEqual(date, '2025-05-30');
    assert.strictEqual(date, publicDateOf(works));
  });

  await t.test('477: with no milestone the fallback date is used, the same date as the public transitionOut', () => {
    const works = publicWorksOf([sheetDoc(1, fallback477)], ROW);

    const [{ date }] = legislationTransitions([2002, 2018], works);

    assert.strictEqual(date, '2025-05-21');
    assert.strictEqual(date, publicDateOf(works));
  });

  await t.test('undated transition gives date null', () => {
    const works = publicWorksOf([sheetDoc(1, handOver(null, 'none'))], ROW);

    assert.deepStrictEqual(legislationTransitions([], works), [{ fromYear: 1996, toYear: 2002, date: null }]);
  });
});
