import { describe, expect, it } from 'vitest';
import type { WorkplanPhase, WorkplanRow } from '../api/sheet-works';
import type { Project } from '../api/types';
import { byAttention, columnOf, rowsOf, type WorkRow } from './derive';

const TODAY = '2026-11-17';

function phase(name: string, start: string | null, end: string | null, extra: Partial<WorkplanPhase> = {}): WorkplanPhase {
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
    ...extra,
  };
}

function work(phases: WorkplanPhase[], extra: Partial<WorkplanRow> = {}): WorkplanRow {
  return {
    projectId: '901',
    projectName: 'Sample Alpha Transmission Line',
    workId: 'track-1',
    source: 'track',
    title: 'Sample work',
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

const rowOf = (w: WorkplanRow, projects: Project[] = []): WorkRow => rowsOf([w], projects, TODAY)[0];

describe('rowsOf', () => {
  it('marks a Track phase past its planned end overdue, hatched from that end to today', () => {
    const row = rowOf(work([phase('Application Review', '2026-03-01T08:00:00.000Z', '2026-10-01T08:00:00.000Z')]));

    expect(row.status).toBe('overdue');
    expect(row.daysOver).toBe(47);
    expect(row.overrun).toEqual({ start: '2026-10-01', end: TODAY });
    expect(row.bar).toBe('overdue');
  });

  it('turns the bar amber above 80 % of planned days, not at 80 %', () => {
    const at = (start: string) => rowOf(work([phase('Process Planning', start, '2027-06-01', { numberOfDays: 100 })]));

    expect(at('2026-08-29').percentUsed).toBe(80);
    expect(at('2026-08-29').bar).toBe('normal');
    expect(at('2026-08-28').percentUsed).toBe(81);
    expect(at('2026-08-28').bar).toBe('near-limit');
  });

  it('reads a Track work whose first phase starts after today as not started, in Intake', () => {
    const row = rowOf(work([phase('Early Engagement', '2027-02-01T08:00:00.000Z', '2027-08-01T08:00:00.000Z')]));

    expect(row.status).toBe('not-started');
    expect(row.current).toBeNull();
    expect(row.column).toBe('Intake');
    expect(row.next).toEqual({ name: 'Early Engagement', date: '2027-02-01', inDays: 76 });
  });

  it('counts an undated sheet start as begun by its latest possible day', () => {
    const notAfter = { startDate: { notAfter: '2001-03-01' } };
    const review = phase('Application Review', null, null, { undated: notAfter, isSuspended: null });

    const row = rowOf(work([review], { source: 'sheet', undated: notAfter }));

    expect(row.notStarted).toBe(false);
    expect(row.current?.name).toBe('Application Review');
    expect(row.daysInPhase).toBeNull();
  });

  it('marks a sheet work suspended while an interruption covers today', () => {
    const stop = { kind: 'suspension', legalSection: 's.30(1)', startDate: '2026-10-01', endDate: '2027-01-31', days: 122 };
    const review = phase('Application Review', '2026-01-01', null, { interruptions: [stop], isSuspended: null });

    const row = rowOf(work([review], { source: 'sheet' }));

    expect(row.suspended).toBe(true);
    expect(row.suspendedUnder).toBe('s.30(1)');
  });

  it('closes a work with isActive false even though a phase has no end date', () => {
    const row = rowOf(work([phase('Application Review', '2026-01-01', null)], { isActive: false }));

    expect(row.status).toBe('closed');
    expect(row.current).toBeNull();
    expect(row.column).toBeNull();
  });

  it('closes an active work that moved to another Act', () => {
    const row = rowOf(
      work([phase('Application Review', '2026-01-01', null)], {
        source: 'sheet',
        transitionOut: { toActYear: 2002, date: null },
      }),
    );

    expect(row.closed).toBe(true);
  });

  it('joins region and project type by projectId', () => {
    const project: Project = { id: 901, name: 'Sample', gatingState: 'admitted', region: 'Sample Region North', type: 'Mines' };

    const row = rowOf(work([]), [project]);

    expect(row.region).toBe('Sample Region North');
    expect(row.projectType).toBe('Mines');
  });
});

describe('columnOf', () => {
  it.each([
    ['READINESS DECISION', 'Referral', 'Planning'],
    ['DPD Development (Proponent Time)', 'Early Engagement', 'Proponent time'],
    ['SubStart Decision', null, 'Decision'],
    ['A renamed phase', 'Referral and Decision', 'Decision'],
    ['A renamed phase', 'a stage nobody mapped', 'Review'],
  ])('puts %s (stage %s) in %s: name first, then stage, then Review', (name, stage, column) => {
    expect(columnOf({ name, stage })).toBe(column);
  });
});

describe('byAttention', () => {
  it('puts overdue first by days over, then soonest next milestone, then not started, then closed', () => {
    const titled = (title: string, phases: WorkplanPhase[], extra: Partial<WorkplanRow> = {}) =>
      work(phases, { title, workId: title, ...extra });
    const rows = rowsOf(
      [
        titled('closed', [], { isActive: false }),
        titled('not started', [phase('Pre-EA', '2027-01-01', '2027-06-01')]),
        titled('next in 60 d', [phase('A', '2026-10-01', '2027-06-01'), phase('B', '2027-01-16', null, { order: 2 })]),
        titled('overdue 10 d', [phase('A', '2026-01-01', '2026-11-07')]),
        titled('next in 5 d', [phase('A', '2026-10-01', '2027-06-01'), phase('B', '2026-11-22', null, { order: 2 })]),
        titled('overdue 40 d', [phase('A', '2026-01-01', '2026-10-08')]),
      ],
      [],
      TODAY,
    );

    expect(rows.sort(byAttention).map((row) => row.work.title)).toEqual([
      'overdue 40 d',
      'overdue 10 d',
      'next in 5 d',
      'next in 60 d',
      'not started',
      'closed',
    ]);
  });
});
