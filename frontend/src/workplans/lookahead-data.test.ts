import { describe, expect, it } from 'vitest';
import FIXTURE from '../../parity/fixtures/workplans.json';
import type { WorkplanPhase, WorkplanRow } from '../api/sheet-works';
import { rowsOf } from './derive';
import { milestonesIn, overdueNow, weeksOf, windowEnd } from './lookahead-data';

const TODAY = '2026-11-17';

function phase(name: string, start: string, end: string | null = null): WorkplanPhase {
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
  };
}

function work(workId: string, phases: WorkplanPhase[], extra: Partial<WorkplanRow> = {}): WorkplanRow {
  return {
    projectId: '901',
    projectName: 'Sample project',
    workId,
    source: 'track',
    title: workId,
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
    transitionOut: null,
    undated: null,
    shownAfterFlip: true,
    untilTrack: false,
    replaces: [],
    phases,
    ...extra,
  };
}

const rows = (works: WorkplanRow[]) => rowsOf(works, [], TODAY);

describe('milestonesIn', () => {
  it('labels each phase start "previous → next" in its tone, and shows a decision phase once, at the decision date when it is in the window', () => {
    const fixture = rows(FIXTURE.works as WorkplanRow[]);

    const found = milestonesIn(fixture, TODAY, windowEnd(TODAY, '6m'));

    expect(found.map((m) => [m.date, m.row.work.workId, m.what, m.tone])).toEqual([
      ['2026-12-01', 'track-9101', 'Application Review → Effects Assessment', 'review'],
      ['2026-12-15', 'track-9301', 'Process Planning → Application Development (Proponent)', 'proponent'],
      ['2027-02-01', 'track-9401', 'Pre-EA', 'planning'],
      ['2027-05-01', 'track-9101', 'Effects Assessment → Referral', 'decision'],
      ['2027-05-01', 'track-9201', 'Amendment Review → Decision', 'decision'],
      // Its decision, 2027-06-01, is past the window, so the decision phase shows at its start.
      ['2027-05-01', 'track-9202', 'SubStart Assessment → SubStart Decision', 'decision'],
    ]);
  });

  it('puts a decision with no decision phase after the last phase', () => {
    const row = work('w', [phase('Review', '2026-01-01')], { anticipatedDecisionDate: '2026-12-20' });

    const found = milestonesIn(rows([row]), TODAY, windowEnd(TODAY, '90d'));

    expect(found.map((m) => [m.date, m.kind, m.what, m.phase])).toEqual([
      ['2026-12-20', 'decision', 'Review → Decision', 'Decision'],
    ]);
  });

  it('counts today and the last day of the window, not the day before or after', () => {
    const end = windowEnd(TODAY, '90d');
    const row = work('w', [
      phase('Yesterday', '2026-11-16'),
      phase('Today', '2026-11-17'),
      phase('Last day', '2027-02-15'),
      phase('Day after', '2027-02-16'),
    ]);

    const found = milestonesIn(rows([row]), TODAY, end);

    expect(end).toBe('2027-02-15');
    expect(found.map((m) => [m.what, m.inDays])).toEqual([
      ['Yesterday → Today', 0],
      ['Today → Last day', 90],
    ]);
  });

  it.each(['COMPLETED', 'IN_PROGRESS'])('gives a switched-off work in state %s no milestones', (workState) => {
    const off = work('w', [phase('Effects Assessment', '2026-12-01')], {
      isActive: false,
      workState,
      anticipatedDecisionDate: '2026-12-20',
    });

    expect(milestonesIn(rows([off]), TODAY, windowEnd(TODAY, '90d'))).toEqual([]);
  });

  it('skips the start of a phase already completed', () => {
    const done = work('w', [{ ...phase('Early Engagement', '2026-12-01'), isCompleted: true }]);

    expect(milestonesIn(rows([done]), TODAY, windowEnd(TODAY, '90d'))).toEqual([]);
  });
});

describe('weeksOf', () => {
  it('starts weeks on Monday and keeps a week that spans the year end together', () => {
    const end = windowEnd(TODAY, '90d');
    const row = work('w', [phase('A', '2026-12-31'), phase('B', '2027-01-03'), phase('C', '2027-01-04')]);

    const weeks = weeksOf(milestonesIn(rows([row]), TODAY, end), TODAY, end);
    const filled = weeks.filter((week) => week.milestones.length > 0);

    expect(weeks[0]).toMatchObject({ start: '2026-11-16', current: true });
    expect(filled.map((week) => [week.start, week.end, week.milestones.length])).toEqual([
      ['2026-12-28', '2027-01-03', 2],
      ['2027-01-04', '2027-01-10', 1],
    ]);
  });
});

describe('windowEnd', () => {
  it('ends six months from 31 August on the last day of February', () => {
    expect(windowEnd('2026-08-31', '6m')).toBe('2027-02-28');
  });
});

describe('overdueNow', () => {
  it('puts the work most days over first', () => {
    const slight = work('slight', [phase('Review', '2026-01-01', '2026-11-10')]);
    const far = work('far', [phase('Review', '2026-01-01', '2026-06-01')]);
    const onTime = work('on-time', [phase('Review', '2026-01-01', '2027-01-01')]);

    expect(overdueNow(rows([slight, far, onTime])).map((row) => row.work.workId)).toEqual(['far', 'slight']);
  });
});
