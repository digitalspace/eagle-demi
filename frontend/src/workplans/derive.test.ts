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
    isCurrent: null,
    suspendedDate: null,
    extensionDays: 0,
    suspendedDays: 0,
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

const rowOf = (w: WorkplanRow, projects: Project[] = []): WorkRow => rowsOf([w], projects, TODAY)[0];

describe('rowsOf', () => {
  it('measures a Track phase past its end against that end, not numberOfDays, hatched from the end to today', () => {
    const review = phase('Application Review', '2026-03-01T08:00:00.000Z', '2026-10-01T08:00:00.000Z', {
      numberOfDays: 180,
    });

    const row = rowOf(work([review]));

    expect(row.status).toBe('overdue');
    expect(row.daysInPhase).toBe(261);
    expect(row.plannedDays).toBe(214);
    expect(row.daysOver).toBe(47);
    expect(row.percentUsed).toBe(122);
    expect(row.overrun).toEqual({ start: '2026-10-01', end: TODAY });
    expect(row.bar).toBe('overdue');
  });

  it('turns the bar amber above 80 % of planned days, not at 80 %', () => {
    const at = (start: string, end: string) => rowOf(work([phase('Process Planning', start, end)]));

    expect(at('2026-08-29', '2026-12-07').percentUsed).toBe(80);
    expect(at('2026-08-29', '2026-12-07').bar).toBe('normal');
    expect(at('2026-08-28', '2026-12-06').percentUsed).toBe(81);
    expect(at('2026-08-28', '2026-12-06').bar).toBe('near-limit');
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

  it('marks a sheet work suspended while a suspension covers today, counting days to its start', () => {
    const stop = { kind: 'suspension', legalSection: 's.30(1)', startDate: '2026-10-01', endDate: '2027-01-31', days: 122 };
    const review = phase('Application Review', '2026-01-01', null, { interruptions: [stop], isSuspended: null });

    const row = rowOf(work([review], { source: 'sheet' }));

    expect(row.suspended).toBe(true);
    expect(row.suspendedUnder).toBe('s.30(1)');
    expect(row.daysInPhase).toBe(273);
  });

  it('counts a suspension that began before the current phase from the phase start, never below 0', () => {
    const stop = { kind: 'suspension', legalSection: 's.30(1)', startDate: '2026-01-01', endDate: null, days: null };
    const review = phase('Application Review', '2026-05-01', null, { interruptions: [stop], isSuspended: null });

    const row = rowOf(work([review], { source: 'sheet' }));

    expect(row.suspendedSince).toBe('2026-05-01');
    expect(row.daysInPhase).toBe(0);
  });

  it('does not mark a sheet work suspended while an extension covers today', () => {
    const stop = { kind: 'extension', legalSection: 's.24(4)', startDate: '2026-10-01', endDate: '2027-01-31', days: 122 };
    const review = phase('Application Review', '2026-01-01', null, { interruptions: [stop], isSuspended: null });

    expect(rowOf(work([review], { source: 'sheet' })).suspended).toBe(false);
  });

  it('stops the day count of a Track phase suspended now at the suspension start, never overdue', () => {
    const review = phase('Application Review', '2026-03-01', '2026-10-01', {
      isSuspended: true,
      suspendedDate: '2026-10-11T07:00:00.000Z',
    });

    const row = rowOf(work([review]));

    expect(row.suspendedSince).toBe('2026-10-11');
    expect(row.daysInPhase).toBe(224);
    expect(row.percentUsed).toBe(105);
    expect(row.overdue).toBe(false);
    expect(row.daysOver).toBe(0);
  });

  it('marks an in-progress Track work switched off as inactive, in its column and never overdue', () => {
    const row = rowOf(
      work(
        [
          phase('Application Review', '2026-03-01', '2026-10-01'),
          phase('Effects Assessment', '2027-01-01', '2027-06-01', { order: 2 }),
        ],
        { isActive: false },
      ),
    );

    expect(row.status).toBe('inactive');
    expect(row.overdue).toBe(false);
    expect(row.column).toBe('Review');
    expect(row.next).toBeNull();
  });

  it('takes the open phase Track marks current over phase order, not a completed one', () => {
    const marked = (isCompleted: boolean) =>
      rowOf(
        work([
          phase('Application Review', '2026-01-01', '2026-06-01'),
          phase('Effects Assessment', '2026-05-01', '2027-06-01', { order: 2, isCurrent: true, isCompleted }),
        ]),
      );

    expect(marked(false).current?.name).toBe('Effects Assessment');
    expect(marked(true).current?.name).toBe('Application Review');
  });

  it('marks a started phase that is neither completed nor current as not completed', () => {
    const row = rowOf(
      work([
        phase('Application Review', '2026-01-01', '2026-06-01'),
        phase('Effects Assessment', '2026-05-01', '2027-06-01', { order: 2 }),
      ]),
    );

    expect(row.segments.map((segment) => segment.state)).toEqual(['current', 'incomplete']);
  });

  it('packs the strip end to end by phase days, an overdue phase pushing later ones right with today inside it', () => {
    const row = rowOf(
      work([
        phase('Early Engagement', '2026-01-01', '2026-03-01', { isCompleted: true }),
        phase('Application Review', '2026-03-01', '2026-10-01', { order: 2 }),
        phase('Effects Assessment', '2027-01-01', '2027-03-01', { order: 3 }),
      ]),
    );
    // 59 days, then 261 days from start to today (214 planned plus the overrun), then 59 days.
    const [early, review, effects] = row.segments;

    expect(review).toMatchObject({ state: 'current', end: '2026-10-01' });
    expect(early.share).toBeCloseTo(59 / 379);
    expect(review.offset).toBeCloseTo(59 / 379);
    expect(review.share).toBeCloseTo(261 / 379);
    expect(effects.offset).toBeCloseTo(320 / 379);
    expect(row.todayAt).toBeCloseTo(320 / 379);
    // The 47-day overrun pushes the strip's end past Effects Assessment's planned end.
    expect(row.stripEnd).toBe('2027-04-17');
  });

  it('keeps today in an overdue current phase when the next phase has already started', () => {
    const row = rowOf(
      work([
        phase('Application Review', '2026-03-01', '2026-10-01'),
        phase('Effects Assessment', '2026-11-01', '2027-03-01', { order: 2 }),
      ]),
    );
    const [review, effects] = row.segments;

    expect([review.state, effects.state]).toEqual(['current', 'incomplete']);
    expect(row.todayAt).toBeCloseTo(review.offset + review.share);
  });

  it('puts today at the start of the next phase when no phase is under way', () => {
    const row = rowOf(
      work([
        phase('Early Engagement', '2026-01-01', '2026-03-01', { isCompleted: true }),
        phase('Application Review', '2027-01-01', '2027-03-01', { order: 2 }),
      ]),
    );

    expect(row.todayAt).toBeCloseTo(row.segments[1].offset);
    expect(row.todayAt).toBeCloseTo(0.5);
  });

  it('leaves a phase that ends before it starts off the lifecycle strip unless it is the current phase', () => {
    const row = rowOf(
      work([
        phase('Early Engagement', '2025-06-01', '2025-01-01', { isCompleted: true }),
        phase('Application Review', '2026-01-01', '2026-12-01', { order: 2 }),
      ]),
    );

    expect(row.segments.map((segment) => segment.name)).toEqual(['Application Review']);
  });

  it('takes the decision event date, else the start of the open decision phase, never Readiness Decision', () => {
    const readiness = phase('Readiness Decision', '2026-10-01', '2027-01-01');
    const decision = phase('Decision', '2027-04-01', '2027-05-01', { order: 2 });

    expect(rowOf(work([readiness, decision], { decisionEventDate: '2027-03-15' })).decisionDate).toBe('2027-03-15');
    expect(rowOf(work([readiness, decision])).decisionDate).toBe('2027-04-01');
    expect(rowOf(work([readiness])).decisionDate).toBeNull();
  });

  it('gives a closed work no decision date from a pending decision event or an open decision phase', () => {
    const closedWith = (decisionEventDate: string | null) =>
      rowOf(
        work([phase('Application Review', '2026-01-01', '2026-06-01'), phase('Decision', '2027-04-01', null, { order: 2 })], {
          isActive: false,
          workState: 'WITHDRAWN',
          decisionEventDate,
        }),
      );

    expect(closedWith('2027-03-15').decisionDate).toBeNull();
    expect(closedWith(null).decisionDate).toBeNull();
  });

  it('waits on a phase Track marks current that starts after today, as not started in its column with it next', () => {
    const marked = (previousDone: boolean) =>
      rowOf(
        work([
          phase('Application Review', '2026-01-01', '2026-11-16', { isCompleted: previousDone }),
          phase('Effects Assessment', '2026-11-18', '2027-03-18', { order: 2, isCurrent: true }),
        ]),
      );

    const waiting = marked(true);
    expect(waiting.current).toBeNull();
    expect(waiting.status).toBe('not-started');
    expect(waiting.column).toBe('Review');
    expect(waiting.next).toEqual({ name: 'Effects Assessment', date: '2026-11-18', inDays: 1 });
    expect(marked(false).current?.name).toBe('Application Review');
  });

  it('reads an open sheet work with no started phase as not started with its next date, not unknown', () => {
    const row = rowOf(work([phase('Application Review', '2027-01-01', '2027-06-01')], { source: 'sheet' }));

    expect(row.status).toBe('not-started');
    expect(row.next).toEqual({ name: 'Application Review', date: '2027-01-01', inDays: 45 });
  });

  it('names the earliest of the next phase start and the decision as next', () => {
    const phases = [phase('A', '2026-10-01', '2027-06-01'), phase('B', '2027-03-01', null, { order: 2 })];

    const row = rowOf(work(phases, { anticipatedDecisionDate: '2027-01-01' }));

    expect(row.next).toEqual({ name: 'Decision', date: '2027-01-01', inDays: 45 });
  });

  it('closes a work with isActive false even though a phase has no end date', () => {
    const review = phase('Application Review', '2026-01-01', null);

    const row = rowOf(work([review], { isActive: false, workState: 'CLOSED' }));

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

  it('closes an active work whose decision date has passed', () => {
    const row = rowOf(work([phase('Application Review', '2026-01-01', null)], { decisionDate: '2026-11-01' }));

    expect(row.status).toBe('closed');
  });

  it.each(['COMPLETED', 'CLOSED', 'WITHDRAWN', 'TERMINATED'])('closes a Track work in state %s that is still flagged active', (workState) => {
    const decided = phase('Transfer Decision', '2025-11-01', '2025-12-05', { isCompleted: true });

    const row = rowOf(work([decided], { workState, isActive: true }));

    expect(row.status).toBe('closed');
  });

  it('reads a Track current phase that ends before it starts as status unknown, unmeasured, with its bar running to today', () => {
    const contact = phase('Initial Contact', '2026-03-23T09:00:00.000Z', '2024-11-02T09:00:00.000Z');

    const row = rowOf(work([contact]));

    expect(row.status).toBe('unknown');
    expect(row.overdue).toBe(false);
    expect(row.plannedDays).toBeNull();
    expect(row.percentUsed).toBeNull();
    expect(row.bar).toBeNull();
    expect(row.segments[0]).toMatchObject({ end: TODAY, share: 1 });
  });

  it('marks a work next-30 when its next milestone is at most 30 days away, else on track', () => {
    const nextOn = (start: string) =>
      rowOf(work([phase('A', '2026-10-01', '2027-06-01'), phase('B', start, null, { order: 2 })]));

    expect(nextOn('2026-12-17').status).toBe('next-30');
    expect(nextOn('2026-12-18').status).toBe('on-track');
  });

  it('joins region by projectId', () => {
    const project: Project = { id: 901, name: 'Sample', gatingState: 'admitted', region: 'Sample Region North', type: 'Mines' };

    const row = rowOf(work([]), [project]);

    expect(row.region).toBe('Sample Region North');
  });
});

describe('columnOf', () => {
  it.each([
    ['READINESS DECISION', 'Referral', 'Planning'],
    ['DPD Development (Proponent Time)', 'Early Engagement', 'Proponent time'],
    ['SubStart Decision', null, 'Decision'],
    ["Minister's Designation Intake", null, 'Intake'],
    ['Pre-EA (Exemption Request)', 'Pre-Application', 'Intake'],
    ['Transfer Pre-Application', null, 'Planning'],
    ['Information Requirement Planning', null, 'Planning'],
    ['Amendment Procedures', null, 'Planning'],
    ['A renamed phase', 'Referral and Decision', 'Decision'],
    ['A renamed phase', 'a stage nobody mapped', 'Review'],
  ])('puts %s (stage %s) in %s: name first, then stage, then Review', (name, stage, column) => {
    expect(columnOf({ name, stage })).toBe(column);
  });
});

describe('byAttention', () => {
  it('puts overdue first by days over, then soonest next milestone, not started, inactive and unknown, closed last', () => {
    const titled = (title: string, phases: WorkplanPhase[], extra: Partial<WorkplanRow> = {}) =>
      work(phases, { title, workId: title, ...extra });
    const rows = rowsOf(
      [
        titled('closed', [], { isActive: false, workState: 'COMPLETED' }),
        titled('unknown', [phase('Pre-Application', '2006-11-09', null, { isSuspended: null })], {
          source: 'sheet',
          workState: 'in-progress',
        }),
        titled('inactive', [phase('A', '2026-01-01', '2026-10-08')], { isActive: false }),
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
      'inactive',
      'unknown',
      'closed',
    ]);
  });
});
