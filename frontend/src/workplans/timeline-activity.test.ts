import { describe, expect, it } from 'vitest';
import type { WorkRow } from './derive';
import { activeByQuarter } from './timeline-activity';
import { dayNumber } from './timeline-scale';

const TODAY = '2026-11-17';
type Bounds = [start: string | null, end: string, notAfter?: string];
const phase = ([startDate, endDate, notAfter]: Bounds, order: number) => ({
  name: `Phase ${order}`,
  startDate,
  endDate,
  order,
  isCompleted: true,
  undated: notAfter ? { startDate: { notAfter } } : null,
  interruptions: [],
});
const work = (bounds: Bounds[], overrun: { start: string; end: string } | null = null) =>
  ({ phases: bounds.map(phase), current: null, overrun, closed: true }) as unknown as WorkRow;
const row = (start: string, end: string, overrunEnd?: string) =>
  work([[start, end]], overrunEnd ? { start: end, end: overrunEnd } : null);

describe('activeByQuarter', () => {
  it('counts each work in every quarter its phases or overrun touch, quarters cut to the range', () => {
    const range = { start: dayNumber('2026-02-15'), end: dayNumber('2026-10-01') };
    const rows = [
      row('2026-01-01', '2026-03-31'),
      row('2026-05-01', '2026-05-02', '2026-08-10'),
      work([]),
    ];

    const cells = activeByQuarter(rows, range, TODAY);

    expect(cells.map((cell) => [cell.label, cell.count])).toEqual([
      ['Q1 2026', 1],
      ['Q2 2026', 1],
      ['Q3 2026', 1],
    ]);
    expect(cells[0].start).toBe(range.start);
  });

  it('counts a phase ending on a quarter’s first day in that quarter', () => {
    const range = { start: dayNumber('2026-01-01'), end: dayNumber('2026-07-01') };

    expect(activeByQuarter([row('2026-02-01', '2026-04-01')], range, TODAY).map((cell) => cell.count)).toEqual([1, 1]);
  });

  it('leaves a work out of a quarter that falls in the gap between its phases', () => {
    const range = { start: dayNumber('2026-01-01'), end: dayNumber('2027-01-01') };
    const gap = work([
      ['2026-01-10', '2026-02-10'],
      ['2026-11-01', '2026-12-01'],
    ]);

    expect(activeByQuarter([gap], range, TODAY).map((cell) => cell.count)).toEqual([1, 0, 0, 1]);
  });

  it('counts a phase drawn from the latest day its undated start can be, as the bar is', () => {
    const range = { start: dayNumber('2026-01-01'), end: dayNumber('2026-07-01') };

    expect(activeByQuarter([work([[null, '2026-05-01', '2026-02-01']])], range, TODAY).map((cell) => cell.count)).toEqual([1, 1]);
  });
});
