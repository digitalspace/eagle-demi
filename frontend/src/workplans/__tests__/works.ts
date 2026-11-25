import type { WorkplanPhase, WorkplanRow } from '../../api/sheet-works';

/** A Workplans phase for tests: a dated, unfinished phase with no time limit unless `extra` says otherwise. */
export function phaseOf(name: string, start: string | null, end: string | null, extra: Partial<WorkplanPhase> = {}): WorkplanPhase {
  return {
    name,
    stage: null,
    order: 1,
    startDate: start,
    endDate: end,
    numberOfDays: null,
    isCompleted: false,
    isSuspended: false,
    isCurrent: null,
    suspendedDate: null,
    extensionDays: 0,
    suspendedDays: 0,
    undated: null,
    interruptions: [],
    ...extra,
  };
}

/** A Workplans row for tests: a Track 2018 assessment in progress on project 950. */
export function workOf(phases: WorkplanPhase[], extra: Partial<WorkplanRow> = {}): WorkplanRow {
  return {
    projectId: '950',
    projectName: 'Sample Zeta Mine',
    eagleId: 'e950',
    workId: 'track-950',
    source: 'track',
    title: 'Sample Zeta Mine - Assessment',
    workTypeCode: 'assessment',
    workType: 'Assessment',
    actYear: 2018,
    workState: 'IN_PROGRESS',
    isActive: true,
    decisionEventDate: null,
    startDate: null,
    decisionDate: null,
    anticipatedDecisionDate: null,
    outcome: null,
    outcomeFrom: null,
    transitionOut: null,
    undated: null,
    shownAfterFlip: true,
    untilTrack: false,
    replaces: [],
    phases,
    ...extra,
  };
}
