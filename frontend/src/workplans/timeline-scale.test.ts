import { describe, expect, it } from 'vitest';
import type { WorkplanRow } from '../api/sheet-works';
import fixture from '../../parity/fixtures/workplans.json';
import { byAttention, rowsOf } from './derive';
import { daysOf, groupsOf, summaryOf } from './timeline-rows';
import {
  dayNumber,
  drawnKinds,
  extentOf,
  holdsDay,
  scaleFor,
  scrollFor,
  spansOf,
  tagDayOf,
  ticksFor,
  xOf,
} from './timeline-scale';

const TODAY = '2026-11-17';
const VIEWPORT = 1000;
const rows = rowsOf(fixture.works as WorkplanRow[], [], TODAY);
const extent = extentOf(rows, TODAY);

describe('timeline scale', () => {
  it('Fit all spans the earliest phase start to the latest phase end', () => {
    const scale = scaleFor(extent, 'fit', TODAY, VIEWPORT);

    expect(scale.start).toBe(dayNumber('1997-02-01'));
    expect(scale.end).toBe(dayNumber('2028-02-01'));
    expect(scale.width).toBe(VIEWPORT);
  });

  it('Year zoom scrolls today into the viewport', () => {
    const scale = scaleFor(extent, 'year', TODAY, VIEWPORT);
    const todayInView = xOf(scale, dayNumber(TODAY)) - scrollFor(scale, dayNumber(TODAY), VIEWPORT);

    expect(scale.width).toBeGreaterThan(VIEWPORT);
    expect(todayInView).toBeGreaterThan(0);
    expect(todayInView).toBeLessThan(VIEWPORT);
  });

  it('Year zoom runs past the latest phase end', () => {
    const scale = scaleFor(extent, 'year', TODAY, VIEWPORT);

    expect(scale.end).toBeGreaterThanOrEqual(dayNumber('2028-02-01'));
  });

  const closed = extentOf(rows.filter((row) => row.work.actYear === 1996), TODAY);

  it('Fixed zoom stretches to today by default', () => {
    expect(holdsDay(scaleFor(closed, 'quarter', TODAY, VIEWPORT), dayNumber(TODAY))).toBe(true);
  });

  it('Fixed zoom leaves today off a group of closed works', () => {
    const scale = scaleFor(closed, 'quarter', TODAY, VIEWPORT, { includeToday: false });

    expect(holdsDay(scale, dayNumber(TODAY))).toBe(false);
  });

  it('a cell cut short at the axis edge drops its label, a full cell keeps it', () => {
    const { bottom } = ticksFor(scaleFor(extent, 'fit', TODAY, 240));

    expect(bottom[0]).toMatchObject({ label: '' });
    expect(bottom[1]).toMatchObject({ label: '2000' });
  });
});

describe('suspension', () => {
  const suspended = rows.find((row) => row.suspended)!;

  it('only a dated interruption draws a hatched span, which the legend keys', () => {
    expect(drawnKinds([suspended], TODAY).has('suspended')).toBe(false);
    expect(drawnKinds(rows, TODAY).has('suspended')).toBe(true);
  });

  it('the suspended tag starts after the current phase, clear of its label', () => {
    const spans = spansOf(suspended, TODAY);
    const current = spans.find((span) => span.kind === 'current')!;

    expect(tagDayOf(spans, TODAY)).toBe(dayNumber(current.end));
  });

  it('an extension draws an extension band', () => {
    const work = structuredClone(suspended.work);
    work.phases[1].interruptions = [
      { kind: 'extension', startDate: '2026-03-01', endDate: '2026-04-01', days: 31, legalSection: null },
    ];

    const spans = spansOf(rowsOf([work], [], TODAY)[0], TODAY, { layers: 'all' });

    expect(spans.filter((span) => span.start === '2026-03-01')).toEqual([
      expect.objectContaining({ kind: 'extension', layer: 'overlay', end: '2026-04-01' }),
    ]);
  });
});

describe('span layers', () => {
  const sheet1996 = (title: string) =>
    rows.find((row) => row.work.source === 'sheet' && row.work.actYear === 1996 && row.work.title?.startsWith(title))!;

  it('a phase with an undated start spans from its notAfter day and is marked approximate', () => {
    const [preApplication] = spansOf(sheet1996('Sample Alpha'), TODAY);

    expect(preApplication).toMatchObject({
      name: 'Pre-Application',
      start: '2001-03-01',
      approx: { start: true, end: false },
    });
  });

  it('extentOf covers a decision marker past the last phase', () => {
    const work = { ...sheet1996('Sample Delta').work, decisionDate: '2000-03-01' };

    expect(extentOf(rowsOf([work], [], TODAY), TODAY, { layers: 'all' })?.end).toBe(dayNumber('2000-03-01'));
  });
});

describe('timeline rows', () => {
  const byTitle = (title: string) => rows.find((row) => row.work.title === title)!;

  it('days column reads overrun, used of planned, suspended, not started and closed', () => {
    expect(daysOf(byTitle('Sample Alpha Transmission Line - Assessment'))).toBe('+47d over');
    expect(daysOf(byTitle('Sample Epsilon Terminal - Amendment'))).toBe('311 d, suspended');
    expect(daysOf(byTitle('Sample Beta Quarry - Amendment'))).toBe('47/182');
    expect(daysOf(byTitle('sample gamma wind farm - Assessment'))).toBe('Not started');
    expect(daysOf(byTitle('Sample Delta Pipeline - EAC Extension'))).toBe('Closed');
  });

  it('days column reads Inactive for a Track work switched off past its end', () => {
    const alpha = { ...byTitle('Sample Alpha Transmission Line - Assessment').work, isActive: false };

    expect(daysOf(rowsOf([alpha], [], TODAY)[0])).toBe('Inactive');
  });

  it('screen-reader summary names a started phase that is neither done nor current as not completed', () => {
    const alpha = structuredClone(byTitle('Sample Alpha Transmission Line - Assessment').work);
    alpha.phases[2] = { ...alpha.phases[2], startDate: '2026-10-02T08:00:00.000Z', isCurrent: true };

    expect(summaryOf(rowsOf([alpha], [], TODAY)[0])).toContain('Not completed: Application Review,');
  });

  it('groups by Act, newest first, with each group\'s overdue count', () => {
    const groups = groupsOf(rows, 'act');

    expect(groups.map((g) => [g.label, g.rows.length, g.overdue])).toEqual([
      ['2018 Act', 5, 1],
      ['2002 Act', 7, 0],
      ['1996 Act', 2, 0],
    ]);
  });

  it('sorts each group by attention when asked, by first phase start otherwise', () => {
    const titles = (group: { rows: typeof rows }) => group.rows.map((row) => row.work.title);
    const byStart = groupsOf(rows, 'act')[0];
    const attention = groupsOf(rows, 'act', 'attention')[0];

    expect(titles(attention)).toEqual(titles({ rows: [...byStart.rows].sort(byAttention) }));
    expect(titles(attention)).not.toEqual(titles(byStart));
  });
});
