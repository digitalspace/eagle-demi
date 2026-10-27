'use strict';

// The stored `works[]` shape, written by hand from the contract rather than built by the mapper,
// so a mapper change cannot move it.

const phase = (overrides) => ({
  name: 'Early Engagement',
  eaActId: 3,
  eaActName: '2018 Act',
  workType: 'Assessment',
  startDate: '2019-02-01T00:00:00.000Z',
  endDate: '2019-08-01T00:00:00.000Z',
  numberOfDays: 180,
  legislated: true,
  sortOrder: 1,
  isCompleted: true,
  ...overrides
});

const milestone = (overrides) => ({
  name: 'Early Engagement Start',
  position: 'START',
  eventType: 1,
  actualDate: '2019-02-01T00:00:00.000Z',
  anticipatedDate: '2019-02-01T00:00:00.000Z',
  outcome: null,
  numberOfDays: 0,
  ...overrides
});

const TRANSITION_DATE = '2019-12-16T00:00:00.000Z';

const ASSESSMENT_WORK = Object.freeze({
  trackWorkId: 1101,
  workTypeId: 6,
  workType: 'Assessment',
  title: 'Cariboo Gold Assessment',
  eaAct: '2018 Act',
  startDate: '2016-05-02T00:00:00.000Z',
  isActive: false,
  workState: 'COMPLETED',
  decisionDate: '2023-10-10T00:00:00.000Z',
  anticipatedDecisionDate: '2023-09-30T00:00:00.000Z',
  outcome: 'Certificate Issued',
  phases: [
    phase({ name: 'Pre-EA (EAC Assessment)', sortOrder: 1 }),
    phase({ name: 'EAC Decision', sortOrder: 7, startDate: '2023-08-01T00:00:00.000Z',
      endDate: '2023-10-10T00:00:00.000Z', numberOfDays: 30 })
  ],
  milestones: [
    milestone({ name: 'Project Transitioning FROM the EA Act (2002)', position: 'INTERMEDIATE',
      eventType: 22, actualDate: TRANSITION_DATE, anticipatedDate: null }),
    milestone({ name: 'EAC Decision', position: 'END', eventType: 22,
      actualDate: '2023-10-10T00:00:00.000Z', anticipatedDate: '2023-09-30T00:00:00.000Z',
      outcome: 'Certificate Issued', numberOfDays: 30 })
  ]
});

const AMENDMENT_WORK = Object.freeze({
  trackWorkId: 1102,
  workTypeId: 7,
  workType: 'Amendment',
  title: null,
  eaAct: '2018 Act',
  startDate: '2025-03-03T00:00:00.000Z',
  isActive: true,
  workState: 'IN_PROGRESS',
  decisionDate: null,
  anticipatedDecisionDate: '2026-12-01T00:00:00.000Z',
  outcome: null,
  phases: [phase({ name: 'Amendment Review', workType: 'Amendment', startDate: '2025-03-03T00:00:00.000Z',
    endDate: null, isCompleted: false })],
  milestones: [milestone({ name: 'Amendment Decision', position: 'END', eventType: 22,
    actualDate: null, anticipatedDate: '2026-12-01T00:00:00.000Z' })]
});

/** A fresh copy each call, so no test can change what the next one sees. */
const trackWorks = () => structuredClone([ASSESSMENT_WORK, AMENDMENT_WORK]);

module.exports = { trackWorks, TRANSITION_DATE };
