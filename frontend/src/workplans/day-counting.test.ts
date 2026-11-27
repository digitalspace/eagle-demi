import { describe, expect, it } from 'vitest';
import { countsFromDayOne, phaseDays } from './chart-facts';
import { phaseOf, workOf } from './__tests__/works';

// The worked example in the proposed rules (Nov 2026): A non-legislated 90 days, B legislated 180, C legislated 30.
const A = phaseOf('A', '2027-03-01', '2027-05-29', { isCompleted: true, numberOfDays: 90, legislated: false });
const B = phaseOf('B', '2027-05-30', '2027-11-26', { isCompleted: true, numberOfDays: 180, legislated: true });
const C = phaseOf('C', '2027-11-27', '2027-12-26', { isCompleted: true, numberOfDays: 30, legislated: true });
const work = workOf([A, B, C], { workState: 'COMPLETED' });
const days = (p: typeof A) => phaseDays(p, work, '2028-06-01');

describe('counting days by the proposed rules', () => {
  it('counts a non-legislated phase from Day One, a legislated one after it from Day Zero, and the next from Day One', () => {
    expect([A, B, C].map((p) => countsFromDayOne(p, work.phases))).toEqual([true, false, true]);
    expect([days(A)?.length, days(B)?.length, days(C)?.length]).toEqual([90, 180, 30]);
  });

  it('puts each deadline on the day the worked example ends the phase, with no overage', () => {
    expect([days(B)?.limitDate, days(C)?.limitDate]).toEqual(['2027-11-26', '2027-12-26']);
    expect([days(A)?.over, days(B)?.over, days(C)?.over]).toEqual([0, 0, 0]);
  });

  it('works phase B through an extension and a suspension: 220 days taken, 210 allowed, 10 over', () => {
    const b = phaseOf('B', '2027-05-30', '2028-01-25', { isCompleted: true, numberOfDays: 180, legislated: true, extensionDays: 30, suspendedDays: 20 });
    const d = phaseDays(b, workOf([A, b], { workState: 'COMPLETED' }), '2028-06-01');
    expect([d?.counted, d?.limit, d?.over, d?.limitDate]).toEqual([220, 210, 10, '2028-01-15']);
  });

  it('never counts an overage on a non-legislated phase', () => {
    const late = phaseOf('A', '2027-03-01', '2027-09-01', { isCompleted: true, numberOfDays: 90, legislated: false });
    expect(phaseDays(late, workOf([late], { workState: 'COMPLETED' }), '2028-06-01')?.over).toBe(0);
  });
});
