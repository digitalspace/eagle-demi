'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { datePhasesFromDocuments, deriveAssessments, actBlocks } = require('../../src/merge/assessments');
const { mergeEagleOnlyProject, carryDemiOnlyFields } = require('../../src/merge/project');
const fx = require('../fixtures/act-assessments');

const yearOf = (derived, year) => derived.assessments.find(one => one.legislationYear === year);
const documentsPhases = (assessment) => assessment.phases.filter(phase => phase.source === 'documents');

/** A row as the dating pass leaves it. */
function dated(row, documents, periods = []) {
  return { ...row, documentPhases: datePhasesFromDocuments(documents, periods, fx.PHASE_ROWS, actBlocks(row)) };
}

test('datePhasesFromDocuments', async (t) => {
  const phases = datePhasesFromDocuments(fx.only2002Documents(), [], fx.PHASE_ROWS, [{ year: 2002 }]);
  const review = phases.find(phase => phase.stage === 'Application Review');

  await t.test('a leading run over two years early is dropped', () => {
    assert.deepStrictEqual([review.startDate, review.documentCount], ['2010-03-02T00:00:00.000Z', 10]);
  });

  await t.test('a document phase spans its first and last kept posting', () => {
    assert.strictEqual(review.endDate, '2010-12-01T00:00:00.000Z');
  });

  await t.test('documents before 1971, before the Act was in force, in Post Decision or off the rail date nothing', () => {
    assert.deepStrictEqual(phases.map(phase => phase.name), ['Application Review']);
  });

  await t.test('1996 Pre-EA and Pre-Application documents date one phase', () => {
    const [phase, ...rest] = datePhasesFromDocuments(fx.only1996Documents(), [], fx.PHASE_ROWS, [{ year: 1996 }]);
    assert.deepStrictEqual([phase.legislationYear, phase.stage, phase.phaseIds, phase.documentCount, rest.length],
      [1996, 'Pre-Application', [fx.PHASES.preEa.id, fx.PHASES.preApplication.id], 2, 0]);
  });

  await t.test('a comment period goes to the latest Act in force when it opened', () => {
    const [period] = datePhasesFromDocuments([], [{ id: 'cp1', dateStarted: '2020-02-01T00:00:00.000Z',
      dateCompleted: '2020-03-01T00:00:00.000Z', informationLabel: 'Draft plan' }], fx.PHASE_ROWS, [{ year: 2002 }, { year: 2018 }]);
    assert.deepStrictEqual([period.legislationYear, period.commentPeriodId, period.label], [2018, 'cp1', 'Draft plan']);
  });

  await t.test('a document after the new Act was in force but before the recorded transition stays on the old Act', () => {
    const row = dated(fx.movedFrom1996('2004-06-01T00:00:00.000Z'),
      [fx.document(fx.PHASES.preApplication, '2003-05-01T00:00:00.000Z')]);
    assert.deepStrictEqual(row.documentPhases.map(phase => phase.legislationYear), [1996]);
  });

  await t.test('a comment period before the recorded transition goes to the old Act', () => {
    const row = dated({ ...fx.cariboo(),
      legislationTransitions: [{ fromYear: 2002, toYear: 2018, date: '2021-03-01T00:00:00.000Z' }] },
    [], [{ id: 'cp3', dateStarted: '2020-06-01T00:00:00.000Z' }]);
    assert.deepStrictEqual(row.documentPhases.map(entry => [entry.commentPeriodId, entry.legislationYear]), [['cp3', 2002]]);
  });

  await t.test('without a transition record the new Act begins on its in-force date', () => {
    const row = dated(fx.movedFrom1996(null),
      [fx.document(fx.PHASES.preApplication, '2003-05-01T00:00:00.000Z')],
      [{ id: 'cp4', dateStarted: '2003-05-01T00:00:00.000Z' }]);
    assert.deepStrictEqual(row.documentPhases.map(entry => entry.legislationYear), [2002, 2002]);
  });

  await t.test('a comment period opened before any listed Act was in force dates nothing', () => {
    const periods = [{ id: 'cp5', dateStarted: '2017-06-01T00:00:00.000Z' }];
    assert.deepStrictEqual(datePhasesFromDocuments([], periods, fx.PHASE_ROWS, [{ year: 2018 }]), []);
  });

  await t.test('a transition dated before its Act was in force starts the Act on its in-force date', () => {
    const periods = [{ id: 'cp6', dateStarted: '2017-06-01T00:00:00.000Z' }];
    const acts = [{ year: 2002 }, { year: 2018, start: '2015-01-01T00:00:00.000Z' }];
    const [period] = datePhasesFromDocuments([], periods, fx.PHASE_ROWS, acts);
    assert.strictEqual(period.legislationYear, 2002);
  });

  await t.test('a comment period that ends before it starts has no end', () => {
    const [period] = datePhasesFromDocuments([], [{ id: 'cp2', dateStarted: '2020-02-01T00:00:00.000Z',
      dateCompleted: '1969-12-31T08:00:00.000Z' }], fx.PHASE_ROWS, [{ year: 2018 }]);
    assert.strictEqual(period.endDate, null);
  });
});

test('deriveAssessments', async (t) => {
  await t.test('a Track-dated stage drops its document phase', () => {
    const row = dated(fx.only2018WithWorks(), [{ projectPhaseId: fx.PHASES.earlyEngagement.id,
      datePosted: '2020-01-10T00:00:00.000Z' }]);
    assert.strictEqual(row.documentPhases.length, 1, 'the pass must date the stage for the drop to matter');
    const early = yearOf(deriveAssessments(row), 2018).phases.filter(phase => phase.stage === 'Early Engagement');
    assert.deepStrictEqual(early.map(phase => phase.source), ['track']);
  });

  await t.test('a document stage Track does not date is kept, after the Track stages before it', () => {
    const row = dated(fx.only2018WithWorks(), [{ projectPhaseId: fx.PHASES.effectsAssessment.id,
      datePosted: '2021-01-10T00:00:00.000Z' }]);
    const phases = yearOf(deriveAssessments(row), 2018).phases;
    assert.deepStrictEqual(phases.map(phase => [phase.stage, phase.source]), [
      ['Early Engagement', 'track'], ['Readiness Decision', 'track'],
      ['Effects Assessment and Recommendation', 'documents']]);
  });

  await t.test('Cariboo 2002 has null decisionDate and transitionDate 2019-12-16', () => {
    const block2002 = yearOf(deriveAssessments(fx.cariboo()), 2002);
    assert.deepStrictEqual([block2002.decisionDate, block2002.transitionDate], [null, fx.TRANSITION_DATE]);
  });

  await t.test('Cariboo has a 2002 and a 2018 assessment, its Track phases under 2018', () => {
    const derived = deriveAssessments(fx.cariboo());
    assert.deepStrictEqual(derived.assessments.map(one => [one.legislationYear, one.phases.length]), [[2002, 0], [2018, 2]]);
  });

  await t.test('Cariboo has no Decision date milestone on 2002 and one on 2018', () => {
    const derived = deriveAssessments(fx.cariboo());
    assert.deepStrictEqual(derived.assessments.map(one => one.milestones.map(m => m.name)), [[], ['Decision date']]);
  });

  await t.test('a bare phase id takes its name from lists', () => {
    const derived = deriveAssessments(fx.cariboo(), { lists: fx.PHASE_ROWS });
    assert.deepStrictEqual(yearOf(derived, 2002).currentPhase, { id: fx.PHASES.applicationReview.id, name: 'Application Review' });
  });

  await t.test('a bare phase id without lists has a null name', () => {
    assert.deepStrictEqual(yearOf(deriveAssessments(fx.cariboo()), 2002).currentPhase,
      { id: fx.PHASES.applicationReview.id, name: null });
  });

  await t.test('the assessment work and the amendment are filed under the Act they name', () => {
    assert.deepStrictEqual(yearOf(deriveAssessments(fx.cariboo()), 2018).trackWorkIds, [1101, 1102]);
  });

  await t.test('a dial on decisionDate hides assessments[].decisionDate', () => {
    const row = { ...fx.only2002(), vis: { decisionDate: 2 } };
    const assessment = yearOf(deriveAssessments(row), 2002);
    assert.deepStrictEqual([assessment.decisionDate, assessment.milestones.map(m => m.name)],
      [null, ['180-day review starts']]);
  });

  await t.test('without a dial the decision date is published', () => {
    assert.strictEqual(yearOf(deriveAssessments(fx.only2002()), 2002).decisionDate, '2011-05-20T00:00:00.000Z');
  });

  await t.test('a dial on currentPhaseName removes its id from phaseIds', () => {
    const row = { ...fx.only2002(), vis: { currentPhaseName: 2 } };
    assert.deepStrictEqual(deriveAssessments(row).phaseIds, [fx.PHASES.preApplication.id, fx.PHASES.applicationReview.id]);
  });

  await t.test('phaseIds hold the current phase, the history and the dated phases once each', () => {
    const row = dated(fx.only2002(), fx.only2002Documents());
    assert.deepStrictEqual(deriveAssessments(row).phaseIds,
      [fx.PHASES.postDecision.id, fx.PHASES.preApplication.id, fx.PHASES.applicationReview.id]);
  });

  await t.test('a dial on works empties activeWork and trackWorkIds', () => {
    const row = { ...fx.only2018WithWorks(), vis: { works: 2 } };
    const derived = deriveAssessments(row);
    assert.deepStrictEqual([derived.activeWork, yearOf(derived, 2018).trackWorkIds], [null, []]);
  });

  await t.test('the live assessment work is the active work, at its first open phase', () => {
    assert.deepStrictEqual(deriveAssessments(fx.only2018WithWorks()).activeWork,
      { trackWorkId: 2201, eaAct: '2018 Act', workType: 'Assessment', currentPhase: 'Readiness Decision' });
  });

  await t.test('a live work with no Track id is not the active work', () => {
    const row = fx.only2018WithWorks();
    row.works = row.works.map(work => ({ ...work, trackWorkId: null }));
    assert.strictEqual(deriveAssessments(row).activeWork, null);
  });

  await t.test('no works falls back to phases', () => {
    const [phase] = yearOf(deriveAssessments(fx.prod2018()), 2018).phases;
    assert.deepStrictEqual([phase.stage, phase.source, phase.startDate], ['Early Engagement', 'track', '2021-05-03T00:00:00.000Z']);
  });

  await t.test('deriveAssessments on a row with documentPhases emits documents phases', () => {
    const row = dated(fx.only2002(), fx.only2002Documents());
    assert.deepStrictEqual(documentsPhases(yearOf(deriveAssessments(row), 2002)).map(phase => [phase.stage, phase.documentCount]),
      [['Application Review', 10]]);
  });

  await t.test('a comment period is a milestone of its Act', () => {
    const row = dated(fx.only2002(), [], [{ id: 'cp1', dateStarted: '2010-04-01T00:00:00.000Z' }]);
    const period = yearOf(deriveAssessments(row), 2002).milestones.find(m => m.commentPeriodId === 'cp1');
    assert.deepStrictEqual([period.name, period.date], ['Public comment period', '2010-04-01T00:00:00.000Z']);
  });

  await t.test('the certificate sits on the block that issued it', () => {
    assert.deepStrictEqual(yearOf(deriveAssessments(fx.only2002()), 2002).certificate,
      { number: 'E10-01', signedDate: '2011-06-01T00:00:00.000Z', expiresDate: null });
  });

  await t.test('a certificate whose decision is known only by id sits on that decision\'s block', () => {
    const row = { ...fx.cariboo(), eaCertificate: 'E10-01' };
    row.legislation_2002.eacDecision = fx.DECISIONS.issued._id;
    delete row.legislation_2018.eacDecision;
    const derived = deriveAssessments(row);
    assert.deepStrictEqual(derived.assessments.map(one => [one.legislationYear, Boolean(one.certificate)]),
      [[2002, true], [2018, false]]);
  });

  await t.test('a certificate field holding a state, not a number, gives no certificate', () => {
    const row = { ...fx.only2002(), eaCertificate: 'In progress' };
    assert.strictEqual(yearOf(deriveAssessments(row), 2002).certificate, null);
  });
});

test('the merge derives assessments', async (t) => {
  const RAW = {
    _id: '5850d1b4652f7e0019b52c0e',
    read: ['public', 'staff', 'sysadmin'],
    currentLegislationYear: 'legislation_2002',
    legislationYearList: [2002],
    legislation_2002: { name: 'Valley Mine', legislationYear: 2002, decisionDate: '2011-05-20T00:00:00.000Z' }
  };

  await t.test('carryDemiOnlyFields(row, null) derives assessments', () => {
    const merged = carryDemiOnlyFields(mergeEagleOnlyProject(RAW), null);
    assert.deepStrictEqual(merged.assessments.map(one => [one.legislationYear, one.decisionDate]),
      [[2002, '2011-05-20T00:00:00.000Z']]);
  });

  await t.test('a push rebuild keeps carried documentPhases', () => {
    const stored = dated(fx.only2002(), fx.only2002Documents());
    const merged = carryDemiOnlyFields(mergeEagleOnlyProject(RAW), stored);
    assert.deepStrictEqual([merged.documentPhases, documentsPhases(merged.assessments[0]).length],
      [stored.documentPhases, 1]);
  });

  await t.test('a push rebuild keeps the stored names of a phase and decision whose ids still match', () => {
    const rebuilt = () => {
      const row = fx.cariboo();
      row.legislation_2002.eacDecision = fx.DECISIONS.issued._id;
      return row;
    };
    const lists = [...fx.PHASE_ROWS, { id: fx.DECISIONS.issued._id, name: fx.DECISIONS.issued.name }];
    const stored = { ...rebuilt(), assessments: deriveAssessments(rebuilt(), { lists }).assessments };
    const assessment = yearOf(carryDemiOnlyFields(rebuilt(), stored), 2002);
    assert.deepStrictEqual([assessment.currentPhase.name, assessment.decision.name],
      ['Application Review', 'Certificate Issued']);
  });

  await t.test('a push rebuild drops a stored name once the id moves', () => {
    const stored = { ...fx.cariboo(), assessments: deriveAssessments(fx.cariboo(), { lists: fx.PHASE_ROWS }).assessments };
    const moved = fx.cariboo();
    moved.legislation_2002.currentPhaseName = fx.PHASES.referral.id;
    assert.deepStrictEqual(yearOf(carryDemiOnlyFields(moved, stored), 2002).currentPhase,
      { id: fx.PHASES.referral.id, name: null });
  });

  await t.test('the derived fields are rebuilt, not carried', () => {
    const stored = { ...fx.only2002(), assessments: [{ legislationYear: 1996 }], phaseIds: ['stale'] };
    const merged = carryDemiOnlyFields(mergeEagleOnlyProject(RAW), stored);
    assert.deepStrictEqual([merged.assessments.map(one => one.legislationYear), merged.phaseIds], [[2002], []]);
  });
});
