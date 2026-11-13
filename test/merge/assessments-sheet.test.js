'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { datePhasesFromDocuments, deriveAssessments, actBlocks } = require('../../src/merge/assessments');
const { legislationTransitions } = require('../../src/merge/track-derived');
const cosmos = require('../../src/db/cosmos-nosql');
const phaseCatalog = require('../../src/domain/phase-catalog');
const { loadWorks } = require('../../src/domain/works-derive');
const fx = require('../fixtures/act-assessments');
const { trackWorks } = require('../fixtures/track-works-contract');

const yearOf = (derived, year) => derived.assessments.find(one => one.legislationYear === year);
const dated = (row, documents, periods = []) =>
  ({ ...row, documentPhases: datePhasesFromDocuments(documents, periods, fx.PHASE_ROWS, actBlocks(row)) });

const catalogEntry = (catalogId, name, order) =>
  ({ catalogId, group: 'assessment', eagleListId: catalogId, name, stage: name, order, trackPhaseCodeIds: [], workTypeIds: [6], aliases: [] });
/** Written by hand, so a catalog build change cannot move it. */
const CATALOG = Object.freeze({
  2002: [catalogEntry(fx.PHASES.preApplication.id, 'Pre-Application', 1),
    catalogEntry(fx.PHASES.applicationReview.id, 'Application Review', 3)],
  2018: [catalogEntry(fx.PHASES.earlyEngagement.id, 'Early Engagement', 1)]
});

const UNKNOWN = Object.freeze({ undated: { startDate: { notAfter: '1995-06-30' } } });
const sheetPhase = (name, startDate, endDate, extra) => ({ name, startDate, endDate, isCompleted: Boolean(endDate), ...extra });
const sheetMilestone = (name, actualDate, fields) => ({ name, code: null, actualDate, endDate: null,
  links: { commentPeriodId: null, blockField: null }, ...fields });
/** A sheet assessment work in public shape. */
const sheetWork = (actYear, phases, fields) => ({ workId: `sheet-${actYear}`, source: 'sheet', workTypeCode: 'assessment',
  actYear, isActive: false, phases, milestones: [], ...fields });
const handOver = (toActYear, date) => ({ transitionOut: { toActYear, date, dateSource: 'sheet' } });
/** `row` with the transitions `patchDerived` stores for `works`, then dated by `documents`. */
const withWorks = (row, works, documents = []) =>
  dated({ ...row, legislationTransitions: legislationTransitions(row.legislationYearList, works) }, documents);
const datesOf = (assessment) => assessment.phases.map(phase => [phase.name, phase.startDate, phase.endDate]);
const milestonesOf = (works, row = fx.only2002()) => yearOf(deriveAssessments(row, { worksForDerive: works }), 2002).milestones
  .map(m => [m.name, m.date, m.dateSource ?? null]);

test('1996 and 2002 phase dates', async (t) => {
  const review = (startDate, endDate, extra) => [sheetWork(2002, [sheetPhase('Application review', startDate, endDate, extra)])];
  const reviewPhases = (works, options) => yearOf(deriveAssessments(dated(fx.only2002(), fx.only2002Documents()),
    { worksForDerive: works, ...options }), 2002).phases.filter(phase => phase.stage === 'Application Review')
    .map(phase => [phase.name, phase.source, phase.startDate, phase.endDate, phase.dateSource ?? null]);
  const EAGLE_REVIEW = ['Application Review', 'documents', '2010-03-02T00:00:00.000Z', '2010-12-01T00:00:00.000Z', null];

  await t.test('sheet date beats Eagle date for the same 2002 phase start; Eagle phase name kept', () => {
    assert.deepStrictEqual(reviewPhases(review('2010-02-20', '2011-05-20')),
      [['Application Review', 'documents', '2010-02-20', '2011-05-20', 'sheet']]);
  });

  await t.test('sheet date beats Eagle date on the catalog path', () => {
    assert.deepStrictEqual(reviewPhases(review('2010-02-20', '2011-05-20'), { catalog: CATALOG }),
      [['Application Review', 'documents', '2010-02-20', '2011-05-20', 'sheet']]);
  });

  await t.test('unknown sheet date keeps Eagle\'s date', () => {
    assert.deepStrictEqual(reviewPhases(review(null, '2011-05-20', UNKNOWN)), [EAGLE_REVIEW]);
  });

  await t.test('a sheet phase open in the sheet stays open, not ended by Eagle', () => {
    assert.deepStrictEqual(reviewPhases(review('2010-02-20', null)), [['Application Review', 'documents', '2010-02-20', null, 'sheet']]);
  });

  await t.test('a sheet end before its start is dropped', () => {
    assert.deepStrictEqual(reviewPhases(review('2010-02-20', '2009-01-01')).map(phase => phase[3]), [null]);
  });

  await t.test('a demi work on a 2002 block lends no dates', () => {
    const demi = { ...sheetWork(2002, [sheetPhase('Application review', '2010-02-20', '2011-05-20')]), source: 'demi',
      milestones: [sheetMilestone('Start (180)', '2010-02-20', { links: { commentPeriodId: null, blockField: 'review180Start' } })] };
    assert.deepStrictEqual([reviewPhases([demi]), milestonesOf([demi]).map(m => m[2])], [[EAGLE_REVIEW], [null, null]]);
  });

  await t.test('a sheet phase no document dates is a sheet phase, and the first open one is current', () => {
    const row = fx.only2002();
    delete row.currentPhaseName;
    delete row.legislation_2002.currentPhaseName;
    const works = [sheetWork(2002, [sheetPhase('Pre-Application', '2008-01-07', '2010-02-20'), sheetPhase('Application Review', '2010-02-20', null)])];
    const phases = yearOf(deriveAssessments(row, { worksForDerive: works, catalog: CATALOG }), 2002).phases;
    assert.deepStrictEqual(phases.map(phase => [phase.name, phase.source, phase.status]),
      [['Pre-Application', 'sheet', 'done'], ['Application Review', 'sheet', 'current']]);
  });
});

test('1996 and 2002 milestones', async (t) => {
  const review180 = sheetMilestone('Start (180)', '2010-02-20', { links: { commentPeriodId: null, blockField: 'review180Start' } });
  const DECISION = ['Decision date', '2011-05-20T00:00:00.000Z', null];

  await t.test('no duplicate 180-day milestone', () => {
    assert.deepStrictEqual(milestonesOf([sheetWork(2002, [], { milestones: [review180] })]),
      [['180-day review starts', '2010-02-20', 'sheet'], DECISION]);
  });

  await t.test('a sheet milestone linked to a comment period lends it its start and end', () => {
    const row = dated(fx.only2002(), [], [{ id: 'cp1', dateStarted: '2010-04-01T00:00:00.000Z', dateCompleted: '2010-05-01T00:00:00.000Z' }]);
    const pcp = sheetMilestone('Public comment period', '2010-04-03', { endDate: '2010-05-03',
      links: { commentPeriodId: 'cp1', blockField: null } });
    const derived = deriveAssessments(row, { worksForDerive: [sheetWork(2002, [], { milestones: [pcp] })] });
    assert.deepStrictEqual(yearOf(derived, 2002).milestones.filter(m => m.commentPeriodId === 'cp1')
      .map(m => [m.name, m.date, m.endDate, m.dateSource]), [['Public comment period', '2010-04-03', '2010-05-03', 'sheet']]);
  });

  await t.test('an unlinked dated sheet milestone joins the block, and the sheet decision gives way to Eagle\'s', () => {
    const works = [sheetWork(2002, [], { milestones: [sheetMilestone('Draft AIR', '2009-06-01'),
      sheetMilestone('Undated order', null, UNKNOWN), sheetMilestone('Decision', '2011-05-18', { code: 'decision' })] })];
    assert.deepStrictEqual(milestonesOf(works),
      [['Draft AIR', '2009-06-01', 'sheet'], ['180-day review starts', '2010-03-01T00:00:00.000Z', null], DECISION]);
  });

  await t.test('the sheet decision shows on a block with no Eagle decision date', () => {
    const row = fx.only2002();
    delete row.decisionDate;
    delete row.legislation_2002.decisionDate;
    const works = [sheetWork(2002, [], { milestones: [sheetMilestone('Decision', '2011-05-18', { code: 'decision' })] })];
    assert.deepStrictEqual(milestonesOf(works, row).slice(1), [['Decision date', '2011-05-18', 'sheet']]);
  });
});

test('1996 and 2002 blocks', async (t) => {
  await t.test('1996 and 2002 blocks meet on 2002-12-30 for a transitioned project', () => {
    const works = [sheetWork(1996, [sheetPhase('Pre-EA', '1999-01-04', '2002-12-30')], handOver(2002, '2002-12-30')),
      sheetWork(2002, [sheetPhase('Application Review', '2002-12-30', null)])];
    const row = withWorks(fx.movedFrom1996(null), works, [fx.document(fx.PHASES.applicationReview, '2003-03-01T00:00:00.000Z')]);
    const [old, next] = deriveAssessments(row, { worksForDerive: works }).assessments;
    assert.deepStrictEqual([old.transitionDate, old.phases.at(-1).endDate, next.phases[0].startDate],
      ['2002-12-30', '2002-12-30', '2002-12-30']);
  });

  await t.test('sheet 2002 block ends and Track 2018 block starts on 2022-08-23 with no phase in both', () => {
    const [track] = trackWorks();
    track.milestones = [];
    track.phases = [{ ...track.phases[1], startDate: '2022-08-23', endDate: '2023-10-10' }];
    const works = [sheetWork(2002, [sheetPhase('Application Review', '2019-01-07', '2022-08-23')], handOver(2018, '2022-08-23')), track];
    const derived = deriveAssessments(withWorks(fx.cariboo(), works), { worksForDerive: works });
    assert.deepStrictEqual([yearOf(derived, 2002).transitionDate, datesOf(yearOf(derived, 2002)), datesOf(yearOf(derived, 2018))], [
      '2022-08-23', [['Application Review', '2019-01-07', '2022-08-23']], [['EAC Decision', '2022-08-23', '2023-10-10']]]);
  });

  await t.test('a Pre-EAO row with an unknown intake that moved to 2002 on 2002-12-30 gives a 1996 block then a 2002 block', () => {
    const works = [sheetWork(1996, [sheetPhase('Pre-EA', null, '2002-12-30', UNKNOWN)], handOver(2002, '2002-12-30')),
      sheetWork(2002, [sheetPhase('Application Review', '2002-12-30', null)])];
    const derived = deriveAssessments(withWorks(fx.only2002(), works), { worksForDerive: works });
    assert.deepStrictEqual(derived.assessments.map(one => [one.legislationYear, one.transitionDate]), [[1996, '2002-12-30'], [2002, null]]);
  });

  await t.test('2018 sequence unchanged', () => {
    const row = dated(fx.only2018WithWorks(), [fx.document(fx.PHASES.effectsAssessment, '2021-01-10T00:00:00.000Z')]);
    const sheet = sheetWork(2002, [sheetPhase('Early Engagement', '2019-01-07', '2021-01-20')], { milestones: [
      sheetMilestone('Start (180)', '2019-01-07', { links: { commentPeriodId: null, blockField: 'review180Start' } })] });
    const derive = (works) => yearOf(deriveAssessments(row, { worksForDerive: works, catalog: CATALOG }), 2018);
    assert.deepStrictEqual(derive([...row.works, sheet]), derive(row.works));
  });

  await t.test('a 2018 sheet work on a 2018-only row lends no phase dates and adds no milestones', () => {
    const row = dated(fx.prod2018(), [fx.document(fx.PHASES.earlyEngagement, '2021-01-10T00:00:00.000Z'),
      fx.document(fx.PHASES.earlyEngagement, '2021-03-10T00:00:00.000Z')]);
    const sheet = sheetWork(2018, [sheetPhase('Early Engagement', '2020-11-02', '2021-04-01')],
      { milestones: [sheetMilestone('Draft AIR', '2021-02-01')] });
    const block = yearOf(deriveAssessments(row, { worksForDerive: [sheet] }), 2018);
    assert.deepStrictEqual([block.phases.map(phase => [phase.name, phase.source, phase.startDate, phase.endDate,
      phase.dateSource ?? null]), block.milestones], [[['Early Engagement', 'documents', '2021-01-10T00:00:00.000Z',
      '2021-03-10T00:00:00.000Z', null]], []]);
  });
});

test('assessments[].workIds', async (t) => {
  await t.test('with WORKS_READ off, workIds lists the same works as trackWorkIds, as track- ids', () => {
    const block = yearOf(deriveAssessments(fx.cariboo()), 2018);
    assert.deepStrictEqual([block.trackWorkIds, block.workIds], [[1101, 1102], ['track-1101', 'track-1102']]);
  });

  await t.test('a Track work naming no Act sits in the same block in workIds as in trackWorkIds', () => {
    const row = { ...fx.only2002(), works: [{ ...trackWorks()[1], eaAct: null }] };
    const block = yearOf(deriveAssessments(row), 2002);
    assert.deepStrictEqual([block.trackWorkIds, block.workIds], [[1102], ['track-1102']]);
  });

  await t.test('a hidden Track amendment is in no block\'s trackWorkIds and the sheet amendment is in the 2002 block\'s workIds', async (t) => {
    const amendmentId = 'sheet-00000000-0000-4000-8000-000000000001';
    const docs = [
      { id: 'track-7', projectId: 'p1', trackWorkId: 7, source: 'track', owner: 'track', workTypeId: 7, eaAct: '2018 Act',
        decisionDate: '2024-06-01', phases: [] },
      { id: amendmentId, projectId: 'p1', source: 'sheet', owner: 'sheet', workTypeCode: 'amendment', actYear: 2002,
        decisionDate: '2024-06-01', sourceKey: 'key-1', phases: [] }
    ];
    const marker = { id: 'sheet-override', projectId: 'p1', kind: 'override', source: 'sheet', owner: 'sheet', active: true,
      boundaryAtLoad: '2025-01-01', certificates: [], hidden: [{ trackWorkId: 'track-7', sheetWorkId: amendmentId }],
      trackAlive: [], untilTrack: [], pairedTrackWorkIds: ['track-7'], batchId: 'batch-1', provenance: {}, schemaVersion: 1 };
    t.mock.method(phaseCatalog, 'load', async () => ({}));
    t.mock.method(cosmos, 'query', async () => ({ items: structuredClone(docs), continuationToken: undefined }));
    t.mock.method(cosmos, 'readItem', async (_container, id) => (id === marker.id ? structuredClone(marker) : null));
    const row = { ...fx.cariboo(), id: 'p1' };

    const derived = deriveAssessments(row, await loadWorks(row, { sources: ['track', 'sheet'] }));

    assert.deepStrictEqual([derived.assessments.flatMap(one => one.trackWorkIds), yearOf(derived, 2002).workIds], [[], [amendmentId]]);
  });
});
