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
    workState: 'in-progress',
    isActive: true,
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
  it('lists every open phase start and the expected decision in six months, in date order', () => {
    const fixture = rows(FIXTURE.works as WorkplanRow[]);

    const found = milestonesIn(fixture, TODAY, windowEnd(TODAY, '6m'));

    expect(found.map((m) => [m.date, m.row.work.workId, m.what])).toEqual([
      ['2026-12-01', 'track-9101', 'Effects Assessment starts'],
      ['2026-12-15', 'track-9301', 'Application Development (Proponent) starts'],
      ['2027-02-01', 'track-9401', 'Pre-EA starts'],
      ['2027-04-01', 'track-9201', 'Decision starts'],
      ['2027-05-01', 'track-9101', 'Referral starts'],
      ['2027-05-01', 'track-9201', 'Decision expected'],
      ['2027-05-01', 'track-9202', 'SubStart Decision starts'],
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
      ['Today starts', 0],
      ['Last day starts', 90],
    ]);
  });

  it('gives a closed work no milestones', () => {
    const closed = work('w', [phase('Effects Assessment', '2026-12-01')], {
      isActive: false,
      anticipatedDecisionDate: '2026-12-20',
    });

    expect(milestonesIn(rows([closed]), TODAY, windowEnd(TODAY, '90d'))).toEqual([]);
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
