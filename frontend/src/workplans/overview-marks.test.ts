import { describe, expect, it } from 'vitest';
import type { WorkplanRow } from '../api/sheet-works';
import { phaseOf, workOf } from './__tests__/works';
import type { Mark, MarkNotes } from './chart-types';
import { assessMarks } from './overview-assess';
import { layoutRow } from './overview-layout';
import { laterMarks } from './overview-later';
import type { MarkAxis } from './overview-marks';

const TODAY = '2026-11-17';
const A0 = Date.UTC(2000, 0, 1);
const A1 = Date.UTC(2030, 0, 1);
const AXIS: MarkAxis = { start: '2000-01-01', end: '2030-01-01', units: 1000, px: (day) => ((Date.parse(day) - A0) / (A1 - A0)) * 1000 };

const notes = (): MarkNotes => ({ undated: 0, open: 0, intr: 0, faults: 0, passed: 0, hidden: 0, oneDay: 0, planned: false, moved: false });

const decided = (outcome: string, extra: Partial<WorkplanRow> = {}) =>
  workOf([phaseOf('Application Review', '2010-01-01', '2011-01-01', { isCompleted: true })], {
    workState: 'COMPLETED',
    isActive: false,
    outcome,
    decisionDate: '2011-01-01',
    ...extra,
  });

const decisionOf = (marks: Mark[]) => marks.find((m) => /\bdk\b/.test(m.cls));

describe('assessMarks decision circle', () => {
  it.each([
    ['Certificate Issued', 'ev dk go', 'Decision, go'],
    ['Certificate Refused', 'ev dk no', 'Decision, refused'],
    ['Terminated', 'ev dk no', 'Decision, terminated'],
  ])('draws %s as %s', (outcome, cls, type) => {
    const mark = decisionOf(assessMarks(decided(outcome), AXIS, [], notes(), TODAY));

    expect(mark?.cls).toBe(cls);
    expect(mark?.type).toBe(type);
  });
});

describe('laterMarks decision circle', () => {
  const amendment = (outcome: string) => decided(outcome, { workTypeCode: 'amendment', workType: 'Amendment' });

  it('draws none for an approved later work, whose bar already ends at its decision', () => {
    expect(decisionOf(laterMarks([amendment('Amendment Granted')], AXIS, notes(), TODAY))).toBeUndefined();
  });

  it('draws a red circle for a terminated later work', () => {
    expect(decisionOf(laterMarks([amendment('Terminated')], AXIS, notes(), TODAY))?.cls).toBe('ev dk no');
  });
});

describe('laterMarks lanes', () => {
  const later = (start: string, end: string) =>
    decided('Amendment Granted', {
      workTypeCode: 'amendment',
      workType: 'Amendment',
      phases: [phaseOf('Amendment Review', start, end, { isCompleted: true })],
      startDate: start,
      decisionDate: end,
    });
  const tops = (works: WorkplanRow[]) => laterMarks(works, AXIS, notes(), TODAY).map((m) => m.style.top);

  it('drops an overlapping bar to the next lane, 28 px down', () => {
    expect(tops([later('2010-01-01', '2012-01-01'), later('2011-01-01', '2013-01-01')])).toEqual([24, 52]);
  });

  it('keeps bars that do not overlap on the main track', () => {
    expect(tops([later('2010-01-01', '2011-01-01'), later('2012-01-01', '2013-01-01')])).toEqual([24, 24]);
  });
});

describe('layoutRow', () => {
  const at = (cls: string, x0: number, top: number, x1 = x0): Mark => ({ cls, style: { top }, tip: null, type: '', docKind: 'source record', doc: null, x0, x1 });

  it('puts a marker that would touch the one before on the next line, and moves the bars down 16 px', () => {
    const row: MarkNotes = { ...notes(), kpx: 1 };
    const { marks } = layoutRow([at('ev note', 500, 4), at('ev note', 505, 4), at('ph', 400, 24, 600)], row, [2018], 2018);

    expect(marks.map((m) => m.style.top)).toEqual([4, 20, 40]);
    expect(row.h).toBe(24 + 20 + 6 + 16);
  });

  it('sets the jump links 4 px off the first and last bar, kept inside the 84 px end room past a no-end arrow', () => {
    const { jumps } = layoutRow([at('ph', 0, 24, 990), at('arrow', 1000, 28)], { ...notes(), kpx: 1 }, [1996, 2002, 2018], 2002);
    const [prev, next] = jumps;

    expect([prev.dir, prev.year, next.dir, next.year]).toEqual(['prev', 1996, 'next', 2018]);
    // 72 px link plus the 4 px gap, and a 1e-2 px rounding allowance.
    expect(prev.left).toBeCloseTo(-7.601, 6);
    // Unclamped it would start at 1012.01 px.
    expect(next.left).toBeCloseTo(101.2, 6);
  });
});
