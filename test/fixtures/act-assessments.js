'use strict';

// Stored project rows and Phase List rows, written by hand so a merge change cannot move them.

const { trackWorks, TRANSITION_DATE } = require('./track-works-contract');

const phaseRow = (id, name, legislation, listOrder) =>
  ({ id, name, type: 'projectPhase', legislation, listOrder });

const PHASES = Object.freeze({
  preEa: phaseRow('5c0000000000000000000000', 'Pre-EA', 2002, 0),
  preApplication: phaseRow('5c0000000000000000000001', 'Pre-Application', 2002, 1),
  applicationReview: phaseRow('5c0000000000000000000003', 'Application Review', 2002, 3),
  referral: phaseRow('5c0000000000000000000005', 'Referral', 2002, 5),
  postDecision: phaseRow('5c0000000000000000000008', 'Post Decision - Certificate Issued', 2002, 8),
  other2002: phaseRow('5c0000000000000000000018', 'Other', 2002, 18),
  earlyEngagement: phaseRow('5d0000000000000000000001', 'Early Engagement', 2018, 1),
  effectsAssessment: phaseRow('5d0000000000000000000005', 'Effects Assessment', 2018, 5)
});

const PHASE_ROWS = Object.values(PHASES);

const DECISIONS = Object.freeze({
  issued: { _id: '5e0000000000000000000001', name: 'Certificate Issued' }
});

const document = (phase, datePosted) => ({ projectPhaseId: phase.id, datePosted });

/** A stored row: the current block hoisted to the top level, and every block beside it. */
function storedRow({ id, years, current, blocks, ...rest }) {
  const row = { id, read: ['public'], isPublished: true, legislationYearList: years,
    currentLegislationYear: `legislation_${current}`, ...blocks[current], ...rest };
  for (const [year, block] of Object.entries(blocks)) row[`legislation_${year}`] = block;
  return structuredClone(row);
}

/** 2002 only, decided, with its Application Review dated by documents. */
function only2002() {
  return storedRow({
    id: '501',
    years: [2002],
    current: 2002,
    eaCertificate: 'E10-01',
    eacSigned: '2011-06-01T00:00:00.000Z',
    blocks: {
      2002: {
        name: 'Valley Mine', legislation: '2002 Environmental Assessment Act', legislationYear: 2002,
        currentPhaseName: { _id: PHASES.postDecision.id, name: PHASES.postDecision.name },
        phaseHistory: [PHASES.preApplication.id, PHASES.applicationReview.id],
        eacDecision: DECISIONS.issued,
        decisionDate: '2011-05-20T00:00:00.000Z',
        review180Start: '2010-03-01T00:00:00.000Z'
      }
    }
  });
}

/** The 2002 row's documents: one posted years before the rest, plus three that date nothing. */
function only2002Documents() {
  const review = ['2010-03-02', '2010-04-01', '2010-05-01', '2010-06-01', '2010-07-01', '2010-08-01',
    '2010-09-01', '2010-10-01', '2010-11-01', '2010-12-01'].map(day => document(PHASES.applicationReview, `${day}T00:00:00.000Z`));
  return [
    document(PHASES.applicationReview, '2005-01-10T00:00:00.000Z'),
    ...review,
    document(PHASES.preApplication, '1969-12-31T08:00:00.000Z'),
    document(PHASES.preApplication, '2001-06-01T00:00:00.000Z'),
    document(PHASES.postDecision, '2012-01-01T00:00:00.000Z'),
    document(PHASES.other2002, '2009-01-01T00:00:00.000Z')
  ];
}

/** Cariboo Gold (`5d40cc5b4cb2c7001b1336b8`): moved from the 2002 Act to the 2018 Act. */
function cariboo() {
  return storedRow({
    id: '611',
    eagleId: '5d40cc5b4cb2c7001b1336b8',
    years: [2002, 2018],
    current: 2018,
    works: trackWorks(),
    legislationTransitions: [{ fromYear: 2002, toYear: 2018, date: TRANSITION_DATE }],
    blocks: {
      2002: { name: 'Cariboo Gold', legislationYear: 2002, decisionDate: '1969-12-31T08:00:00.000Z',
        currentPhaseName: PHASES.applicationReview.id },
      2018: { name: 'Cariboo Gold', legislationYear: 2018, eacDecision: DECISIONS.issued,
        decisionDate: '2023-10-10T00:00:00.000Z' }
    }
  });
}

/** 2018 only, its assessment work live and Early Engagement dated by Track. */
function only2018WithWorks() {
  const [assessment, amendment] = trackWorks();
  const work = { ...assessment, trackWorkId: 2201, isActive: true, workState: 'IN_PROGRESS',
    phases: [
      { ...assessment.phases[0], name: 'Early Engagement', isCompleted: true },
      { ...assessment.phases[0], name: 'Readiness Decision', sortOrder: 2, isCompleted: false,
        startDate: '2019-08-02T00:00:00.000Z', endDate: null }
    ] };
  return storedRow({
    id: '702', years: [2018], current: 2018, works: [work, { ...amendment, trackWorkId: 2202 }],
    blocks: { 2018: { name: 'Coast Terminal', legislationYear: 2018,
      currentPhaseName: { _id: PHASES.earlyEngagement.id, name: 'Early Engagement' } } }
  });
}

/** 2018 with Track phases and no works, as prod holds them. */
function prod2018() {
  return storedRow({
    id: '703', years: [2018], current: 2018,
    phases: [{ name: 'Early Engagement', eaActName: '2018 Act', startDate: '2021-05-03T00:00:00.000Z',
      endDate: '2021-11-08T00:00:00.000Z', isCompleted: true }],
    blocks: { 2018: { name: 'North Wind', legislationYear: 2018 } }
  });
}

/** 1996, whose documents Eagle files under the 2002 Pre-EA and Pre-Application rows. */
function only1996() {
  return storedRow({
    id: '804', years: [1996], current: 1996,
    blocks: { 1996: { name: 'Old Quarry', legislationYear: 1996 } }
  });
}

function only1996Documents() {
  return [
    document(PHASES.preEa, '1997-02-01T00:00:00.000Z'),
    document(PHASES.preApplication, '1998-03-01T00:00:00.000Z')
  ];
}

module.exports = {
  PHASES, PHASE_ROWS, DECISIONS, TRANSITION_DATE,
  only2002, only2002Documents, cariboo, only2018WithWorks, prod2018, only1996, only1996Documents
};
