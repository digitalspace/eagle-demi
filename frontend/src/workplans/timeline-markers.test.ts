import { describe, expect, it } from 'vitest';
import type { WorkplanMilestone, WorkplanPhase, WorkplanRow } from '../api/sheet-works';
import { rowKey, rowsOf } from './derive';
import { markerSummaryOf, markersOf, transitionPairsOf } from './timeline-markers';

const TODAY = '2026-11-17';

const phase = (extra: Partial<WorkplanPhase>): WorkplanPhase => ({
  name: 'Application Review',
  stage: null,
  order: 1,
  startDate: null,
  endDate: null,
  numberOfDays: null,
  isCompleted: false,
  isSuspended: null,
  isCurrent: null,
  suspendedDate: null,
  extensionDays: null,
  suspendedDays: null,
  undated: null,
  interruptions: [],
  ...extra,
});

const milestone = (kind: WorkplanMilestone['kind'], extra: Partial<WorkplanMilestone>): WorkplanMilestone => ({
  name: null,
  code: null,
  eventType: null,
  position: null,
  actualDate: null,
  anticipatedDate: null,
  endDate: null,
  numberOfDays: null,
  outcome: null,
  kind,
  ...extra,
});

const work = (extra: Partial<WorkplanRow>): WorkplanRow => ({
  projectId: '105',
  projectName: null,
  workId: 'sheet-1',
  source: 'sheet',
  title: null,
  workTypeCode: 'assessment',
  workType: 'Assessment',
  actYear: 1996,
  workState: null,
  isActive: null,
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
  phases: [],
  ...extra,
});

const rowsFor = (works: WorkplanRow[]) => rowsOf(works, [], TODAY);
const trackWork = (extra: Partial<WorkplanRow>) =>
  work({ source: 'track', workId: 'track-1', actYear: 2018, workState: 'IN_PROGRESS', isActive: true, ...extra });

describe('transitionPairsOf', () => {
  it('pairs the 1996 and 2002 parts of one assessment by project, Acts and day', () => {
    const day = '2002-12-30';
    const [elsewhere, part1996, part2002] = rowsFor([
      work({ projectId: '134', workId: 'sheet-134', actYear: 2002, transitionIn: { fromActYear: 1996, date: day } }),
      work({ workId: 'sheet-1996', transitionOut: { toActYear: 2002, date: day } }),
      work({ workId: 'sheet-2002', actYear: 2002, transitionIn: { fromActYear: 1996, date: day } }),
    ]);
    const pairs = transitionPairsOf([elsewhere, part1996, part2002]);
    expect(pairs.get(rowKey(part1996))).toBe(rowKey(part2002));
    expect(pairs.get(rowKey(part2002))).toBe(rowKey(part1996));
  });
});

describe('markersOf', () => {
  it('gives a Track suspension one range from its suspension to its resumption', () => {
    const [row] = rowsFor([
      trackWork({
        phases: [phase({ startDate: '2025-01-01', isCurrent: true, isSuspended: false })],
        milestones: [
          milestone('suspension', { actualDate: '2025-02-01' }),
          milestone('resumption', { actualDate: '2025-05-01' }),
        ],
      }),
    ]);
    expect(markersOf(row, TODAY).ranges).toEqual([
      { kind: 'suspension', start: '2025-02-01', end: '2025-05-01', label: 'Suspension', open: false },
    ]);
  });

  it('runs Track’s open suspension from its suspended day to today, once', () => {
    const [row] = rowsFor([
      trackWork({
        phases: [phase({ startDate: '2026-01-01', isCurrent: true, isSuspended: true, suspendedDate: '2026-09-01' })],
        milestones: [milestone('suspension', { actualDate: '2026-09-01' })],
      }),
    ]);
    expect(markersOf(row, TODAY).ranges).toEqual([
      { kind: 'suspension', start: '2026-09-01', end: TODAY, label: 'Suspension', open: true },
    ]);
  });

  it('gives Track extension and interregnum milestones a range of their days', () => {
    const [row] = rowsFor([
      trackWork({
        phases: [phase({ startDate: '2025-01-01', isCurrent: true })],
        milestones: [
          milestone('extension', { name: 'Time Limit Extension', actualDate: '2025-03-01', numberOfDays: 30 }),
          milestone('interregnum', { name: 'Interregnum', actualDate: '2025-06-01', numberOfDays: 10 }),
        ],
      }),
    ]);
    expect(markersOf(row, TODAY).ranges).toEqual([
      { kind: 'extension', start: '2025-03-01', end: '2025-03-31', label: 'Time Limit Extension', open: false },
      { kind: 'interregnum', start: '2025-06-01', end: '2025-06-11', label: 'Interregnum', open: false },
    ]);
  });

  it.each([
    ['a later undated one', { undated: { startDate: { notAfter: '2005-06-01' } } }],
    ['a later one with no start at all', {}],
  ])('ends a suspension never resumed at the end of the phase it began in, not %s', (_, next) => {
    const [row] = rowsFor([
      work({
        phases: [
          phase({ order: 1, startDate: '2004-01-01', endDate: '2004-12-31', isCompleted: true }),
          phase({ order: 2, ...next }),
        ],
        milestones: [milestone('suspension', { actualDate: '2004-06-01' })],
      }),
    ]);
    expect(markersOf(row, TODAY).ranges).toMatchObject([
      { kind: 'suspension', start: '2004-06-01', end: '2004-12-31', open: false },
    ]);
  });

  it('counts a phase whose undated start falls before a suspension as the phase it began in', () => {
    const [row] = rowsFor([
      work({
        phases: [phase({ undated: { startDate: { notAfter: '2004-01-01' } }, endDate: '2004-12-31', isCompleted: true })],
        milestones: [milestone('suspension', { actualDate: '2004-06-01' })],
      }),
    ]);
    expect(markersOf(row, TODAY).ranges).toMatchObject([{ kind: 'suspension', start: '2004-06-01', end: '2004-12-31' }]);
  });

  it('leaves a sheet suspension interruption to the phase spans', () => {
    const stop = { kind: 'suspension', legalSection: 's.24(2)', startDate: '2026-01-01', endDate: null, days: null };
    const [row] = rowsFor([work({ actYear: 2002, phases: [phase({ startDate: '2025-01-01', interruptions: [stop] })] })]);
    expect(markersOf(row, TODAY).ranges).toEqual([]);
  });

  it('draws no comment period that ends before it starts', () => {
    const pcp = milestone('comment-period', { name: 'PCP', actualDate: '2004-03-01', endDate: '2004-02-01' });
    const [row] = rowsFor([work({ actYear: 2002, milestones: [pcp] })]);
    expect(markersOf(row, TODAY).ranges).toEqual([]);
    expect(markerSummaryOf(row, TODAY)).toBe('');
  });

  it('marks the Act switches and section 13 orders of a work', () => {
    const [row] = rowsFor([
      work({
        actYear: 2002,
        transitionIn: { fromActYear: 1996, date: '2002-12-30' },
        transitionOut: { toActYear: 2018, date: '2019-12-16' },
        milestones: [milestone('section-13', { actualDate: '2010-05-01' })],
      }),
    ]);
    expect(markersOf(row, TODAY).points).toEqual(
      expect.arrayContaining([
        { kind: 'section-13', day: '2010-05-01', label: 'Section 13 order' },
        { kind: 'transition-out', day: '2019-12-16', label: 'To 2018 Act' },
        { kind: 'transition-in', day: '2002-12-30', label: 'From 1996 Act' },
      ]),
    );
  });

  it('gives a sheet extension interruption a range named by its legal section', () => {
    const stop = { kind: 'extension', legalSection: 's.24(4)', startDate: '2003-12-31', endDate: '2004-06-30', days: 182 };
    const [row] = rowsFor([work({ actYear: 2002, phases: [phase({ startDate: '2003-01-01', interruptions: [stop] })] })]);
    expect(markersOf(row, TODAY).ranges).toEqual([
      { kind: 'extension', start: '2003-12-31', end: '2004-06-30', label: 'Extension s.24(4)', open: false },
    ]);
  });

  it('gives a sheet comment period a range to its end date', () => {
    const pcp = milestone('comment-period', { name: 'Other PCP', actualDate: '2003-12-03', endDate: '2004-02-02' });
    const [row] = rowsFor([work({ actYear: 2002, milestones: [pcp] })]);
    expect(markersOf(row, TODAY).ranges).toEqual([
      { kind: 'comment-period', start: '2003-12-03', end: '2004-02-02', label: 'Other PCP', open: false },
    ]);
  });
});

describe('markerSummaryOf', () => {
  it('reads the markers in date order', () => {
    const pcp = milestone('comment-period', { name: 'Application PCP', actualDate: '1998-01-12', endDate: '1998-03-27' });
    const [row] = rowsFor([work({ decisionDate: '1998-04-27', milestones: [pcp] })]);
    expect(markerSummaryOf(row, TODAY)).toBe('Application PCP 12 Jan 1998 to 27 Mar 1998. Decision 27 Apr 1998.');
  });

  it('reads a range still running as since its start', () => {
    const [row] = rowsFor([
      trackWork({ phases: [phase({ startDate: '2026-01-01', isCurrent: true, isSuspended: true, suspendedDate: '2026-09-01' })] }),
    ]);
    expect(markerSummaryOf(row, TODAY)).toBe('Suspension since 1 Sep 2026.');
  });
});
