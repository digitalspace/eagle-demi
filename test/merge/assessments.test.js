'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { datePhasesFromDocuments, deriveAssessments, actBlocks } = require('../../src/merge/assessments');
const { pickAssessmentWork } = require('../../src/merge/assessment-work');
const { mergeEagleOnlyProject, mergeTrackProject, carryDemiOnlyFields } = require('../../src/merge/project');
const fx = require('../fixtures/act-assessments');
const { trackWorks, TRANSITION_DATE } = require('../fixtures/track-works-contract');

const yearOf = (derived, year) => derived.assessments.find(one => one.legislationYear === year);
const documentsPhases = (assessment) => assessment.phases.filter(phase => phase.source === 'documents');

const READINESS = '5d0000000000000000000002';
const PLANNING = '5d0000000000000000000003';
const catalogEntry = (catalogId, name, stage, order, trackPhaseCodeIds = [], aliases = []) =>
  ({ catalogId, group: 'assessment', eagleListId: catalogId, name, stage, order, trackPhaseCodeIds, workTypeIds: [6], aliases });

/** Written by hand, so a catalog build change cannot move it. */
const CATALOG = Object.freeze({
  2002: [
    catalogEntry(fx.PHASES.preApplication.id, 'Pre-Application', 'Pre-Application', 1),
    catalogEntry(fx.PHASES.applicationReview.id, 'Application Review', 'Application Review', 3),
    { ...catalogEntry(fx.PHASES.postDecision.id, 'Post Decision - Certificate Issued', 'Post Decision', 8), group: 'postDecision' }
  ],
  2018: [
    catalogEntry(fx.PHASES.earlyEngagement.id, 'Early Engagement', 'Early Engagement', 1, [11]),
    catalogEntry(READINESS, 'Readiness Decision', 'Readiness Decision', 2, [12]),
    catalogEntry(PLANNING, 'Process Planning', 'Process Planning', 3, [13]),
    catalogEntry(fx.PHASES.effectsAssessment.id, 'Effects Assessment', 'Effects Assessment and Recommendation', 5, [15],
      ['Effects Assessment and Recommendation']),
    catalogEntry('5d0000000000000000000006', 'Referral', 'Referral and Decision', 6, [16])
  ]
});

/** A 2018 row whose works come only through `worksForDerive`, with Track, documents and Eagle history phases. */
function sequenceRow() {
  const row = dated(fx.only2018WithWorks(), [fx.document(fx.PHASES.effectsAssessment, '2021-01-10T00:00:00.000Z')]);
  delete row.works;
  const history = [fx.PHASES.earlyEngagement.id, { _id: PLANNING, name: 'Process Planning' }, fx.PHASES.effectsAssessment.id];
  const current = { _id: PLANNING, name: 'Process Planning' };
  Object.assign(row, { phaseHistory: history, currentPhaseName: current });
  Object.assign(row.legislation_2018, { phaseHistory: history, currentPhaseName: current });
  return row;
}

function sequenceWorks() {
  const [assessment] = trackWorks();
  return [{ ...assessment, trackWorkId: 2201, isActive: true, phases: [
    { ...assessment.phases[0], name: 'Pre-EA (EAC Assessment)', phaseCodeId: 901, sortOrder: 0, isCompleted: true },
    { ...assessment.phases[0], name: 'Early Engagement', phaseCodeId: 11, isCompleted: true },
    { ...assessment.phases[0], name: 'Readiness Decision', phaseCodeId: 12, isCompleted: false,
      startDate: '2019-08-02T00:00:00.000Z', endDate: null },
    { ...assessment.phases[0], name: 'EAC Decision', phaseCodeId: 16, isCompleted: false,
      startDate: '2022-01-02T00:00:00.000Z', endDate: null }
  ] }];
}

const sequenceOf = (row) => yearOf(deriveAssessments(row, { worksForDerive: sequenceWorks(), catalog: CATALOG }), 2018).phases;
const statuses = (phases) => phases.map(phase => [phase.name, phase.source, phase.status]);

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
  await t.test('a stage dated by documents and Track keeps only the documents phase and its dates', () => {
    const bare = fx.only2018WithWorks();
    // No Eagle current phase, so the kept documents phase is the only source of its id.
    delete bare.currentPhaseName;
    delete bare.legislation_2018.currentPhaseName;
    const row = dated(bare, [{ projectPhaseId: fx.PHASES.earlyEngagement.id, datePosted: '2020-01-10T00:00:00.000Z' }]);
    assert.strictEqual(row.documentPhases.length, 1, 'the pass must date the stage for the drop to matter');
    const derived = deriveAssessments(row);
    const early = yearOf(derived, 2018).phases.filter(phase => phase.stage === 'Early Engagement');
    assert.deepStrictEqual([early.map(phase => [phase.source, phase.startDate, phase.endDate]), derived.phaseIds],
      [[['documents', '2020-01-10T00:00:00.000Z', null]], [fx.PHASES.earlyEngagement.id]]);
  });

  await t.test('a documents phase sorts before a Track phase of the same rank', () => {
    const row = { ...fx.prod2018(), phases: [{ name: 'Unlisted Track phase', eaActName: '2018 Act' }],
      documentPhases: [{ legislationYear: 2018, stage: null, name: 'Unlisted Eagle phase', phaseIds: [],
        startDate: '2021-01-10T00:00:00.000Z', endDate: null, documentCount: 1 }] };
    assert.deepStrictEqual(yearOf(deriveAssessments(row), 2018).phases.map(phase => phase.source), ['documents', 'track']);
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

  await t.test('without an Eagle current phase the live assessment work is the active work, at its first open phase', () => {
    const row = fx.only2018WithWorks();
    delete row.currentPhaseName;
    delete row.legislation_2018.currentPhaseName;
    assert.deepStrictEqual(deriveAssessments(row).activeWork,
      { trackWorkId: 2201, eaAct: '2018 Act', workType: 'Assessment', currentPhase: 'Readiness Decision' });
  });

  await t.test('the active work takes Eagle\'s current phase over its open Track phase', () => {
    assert.strictEqual(deriveAssessments(fx.only2018WithWorks()).activeWork.currentPhase, 'Early Engagement');
  });

  for (const eaAct of ['2018 Act', null, 'Unknown Act']) {
    await t.test(`a work with eaAct ${eaAct} on a 2002 row takes its open Track phase, not Eagle's current phase`, () => {
      const row = fx.only2002();
      const current = { _id: fx.PHASES.applicationReview.id, name: 'Application Review' };
      row.currentPhaseName = current;
      row.legislation_2002.currentPhaseName = current;
      row.works = [{ ...trackWorks()[1], eaAct }];
      assert.deepStrictEqual(deriveAssessments(row).activeWork,
        { trackWorkId: 1102, eaAct, workType: 'Amendment', currentPhase: 'Amendment Review' });
    });
  }

  await t.test('a raw live work with no Track id is not the active work', () => {
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

test('pickAssessmentWork', async (t) => {
  const work = (trackWorkId, overrides) => ({ ...trackWorks()[0], trackWorkId, ...overrides });
  const cases = [
    ['the active work beats a later start', [work(1, { isActive: true }), work(2, { startDate: '2024-01-01T00:00:00.000Z' })], 1],
    ['else the latest start wins', [work(1, { startDate: '2024-01-01T00:00:00.000Z' }), work(2)], 1],
    ['a tie goes to the highest Track work id', [work(1), work(2)], 2],
    ['a work under another Act is not picked', [work(1, { eaAct: '2002 Act', startDate: '2024-01-01T00:00:00.000Z' }), work(2)], 2]
  ];
  for (const [name, works, picked] of cases) {
    await t.test(name, () => assert.strictEqual(pickAssessmentWork(works, { year: 2018 }).trackWorkId, picked));
  }

  await t.test('each Act draws its Track phases from the work picked for that Act', () => {
    const phase = (name, eaActName) => ({ ...trackWorks()[0].phases[0], name, eaActName });
    const row = { ...fx.cariboo(), works: [
      work(1, { startDate: '2016-01-01T00:00:00.000Z', phases: [phase('Early Engagement', '2018 Act')] }),
      work(2, { startDate: '2020-01-01T00:00:00.000Z', phases: [phase('Readiness Decision', '2018 Act')] }),
      work(3, { eaAct: '2002 Act', startDate: '2010-01-01T00:00:00.000Z', phases: [phase('Application Review', '2002 Act')] })
    ] };
    const trackNames = (derived, year) => yearOf(derived, year).phases.filter(one => one.source === 'track').map(one => one.name);
    const derived = deriveAssessments(row);
    assert.deepStrictEqual([trackNames(derived, 2002), trackNames(derived, 2018)], [['Application Review'], ['Readiness Decision']]);
  });
});

test('the phase sequence with a catalog', async (t) => {
  await t.test('Eagle history sits undated beside the dated phases, less those on a stage already dated', () => {
    assert.deepStrictEqual(statuses(sequenceOf(sequenceRow())), [
      ['Early Engagement', 'track', 'done'],
      ['Readiness Decision', 'track', 'done'],
      ['Process Planning', 'eagle', 'current'],
      ['Effects Assessment', 'documents', 'planned'],
      ['Referral', 'track', 'planned'],
      ['Pre-EA (EAC Assessment)', 'track', 'done']
    ]);
  });

  const byCurrent = [['a bare id', PLANNING, 'Process Planning'],
    ['name', { _id: 'unknown', name: 'process planning' }, 'Process Planning'],
    ['a catalog alias', { _id: 'unknown', name: 'Effects Assessment and Recommendation' }, 'Effects Assessment']];
  for (const [how, current, name] of byCurrent) {
    await t.test(`the current phase is found by ${how}`, () => {
      const row = sequenceRow();
      row.currentPhaseName = current;
      row.legislation_2018.currentPhaseName = current;
      assert.strictEqual(sequenceOf(row).find(phase => phase.status === 'current').name, name);
    });
  }

  await t.test('without an Eagle current phase the first open Track phase is current', () => {
    const row = sequenceRow();
    delete row.currentPhaseName;
    delete row.legislation_2018.currentPhaseName;
    assert.deepStrictEqual(statuses(sequenceOf(row)).slice(1, 3),
      [['Readiness Decision', 'track', 'current'], ['Process Planning', 'eagle', 'undated']]);
  });

  await t.test('a Track phase the catalog lacks keeps its Track name and sort order under its code', () => {
    const [phase] = sequenceOf(sequenceRow()).filter(one => one.catalogId === 'track-901');
    assert.deepStrictEqual([phase.name, phase.stage, phase.order, phase.trackWorkId], ['Pre-EA (EAC Assessment)', null, 0, 2201]);
  });

  await t.test('a current phase on no listed phase still splits done from planned at its catalog place', () => {
    const derived = deriveAssessments(dated(fx.only2002(), fx.only2002Documents()), { catalog: CATALOG });
    assert.deepStrictEqual(statuses(yearOf(derived, 2002).phases),
      [['Pre-Application', 'eagle', 'undated'], ['Application Review', 'documents', 'done']]);
  });

  await t.test('a dial on works keeps worksForDerive out of assessments and activeWork', () => {
    const derived = deriveAssessments({ ...sequenceRow(), vis: { works: 2 } }, { worksForDerive: sequenceWorks(), catalog: CATALOG });
    assert.deepStrictEqual([yearOf(derived, 2018).phases.filter(one => one.source === 'track'), derived.activeWork], [[], null]);
  });

  await t.test('a dial on phaseHistory leaves no Eagle history entry', () => {
    const derived = deriveAssessments({ ...sequenceRow(), vis: { phaseHistory: 2 } }, { worksForDerive: sequenceWorks(), catalog: CATALOG });
    assert.deepStrictEqual(yearOf(derived, 2018).phases.filter(one => one.source === 'eagle'), []);
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

  await t.test('with no stored works, worksForDerive still gives the transitions, Track phases and active work', () => {
    const raw = { ...RAW, currentLegislationYear: 'legislation_2018', legislationYearList: [2002, 2018],
      legislation_2018: { name: 'Valley Mine', legislationYear: 2018 } };
    const opts = { worksForDerive: trackWorks() };
    const merged = carryDemiOnlyFields(mergeTrackProject({ track_project_id: 9001 }, raw, opts), null, undefined, opts);
    assert.deepStrictEqual([merged.works, merged.legislationTransitions,
      yearOf(merged, 2018).phases.map(phase => phase.source), merged.activeWork.trackWorkId],
    [undefined, [{ fromYear: 2002, toYear: 2018, date: TRANSITION_DATE }], ['track', 'track'], 1102]);
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
