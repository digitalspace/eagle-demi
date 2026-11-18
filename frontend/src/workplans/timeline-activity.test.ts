import { describe, expect, it } from 'vitest';
import type { WorkRow } from './derive';
import { activeByQuarter } from './timeline-activity';
import { dayNumber } from './timeline-scale';

const row = (start: string, end: string, overrunEnd?: string) =>
  ({ segments: [{ start, end }], overrun: overrunEnd ? { start: end, end: overrunEnd } : null }) as unknown as WorkRow;

describe('activeByQuarter', () => {
  it('counts each work in every quarter its phases or overrun touch, quarters cut to the range', () => {
    const range = { start: dayNumber('2026-02-15'), end: dayNumber('2026-10-01') };
    const rows = [
      row('2026-01-01', '2026-03-31'),
      row('2026-05-01', '2026-05-02', '2026-08-10'),
      { segments: [], overrun: null } as unknown as WorkRow,
    ];

    const cells = activeByQuarter(rows, range);

    expect(cells.map((cell) => [cell.label, cell.count])).toEqual([
      ['Q1 2026', 1],
      ['Q2 2026', 1],
      ['Q3 2026', 1],
    ]);
    expect(cells[0].start).toBe(range.start);
  });

  it('leaves a work out of a quarter that falls in the gap between its phases', () => {
    const range = { start: dayNumber('2026-01-01'), end: dayNumber('2027-01-01') };
    const gap = {
      segments: [
        { start: '2026-01-10', end: '2026-02-10' },
        { start: '2026-11-01', end: '2026-12-01' },
      ],
      overrun: null,
    } as unknown as WorkRow;

    expect(activeByQuarter([gap], range).map((cell) => cell.count)).toEqual([1, 0, 0, 1]);
  });
});
