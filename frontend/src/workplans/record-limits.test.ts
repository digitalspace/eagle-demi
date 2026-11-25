import { describe, expect, it } from 'vitest';
import type { WorkplanMilestone } from '../api/sheet-works';
import { phaseOf, workOf } from './__tests__/works';
import { extPlan, pickSum } from './record-limits';

const extension = (actualDate: string, numberOfDays: number): WorkplanMilestone => ({
  name: 's.24(4) Extension of Time Limit',
  actualDate,
  anticipatedDate: null,
  endDate: null,
  outcome: null,
  numberOfDays,
  code: null,
  eventType: null,
  position: null,
  kind: 'extension',
});

describe('pickSum', () => {
  it('takes the events that add up to the target exactly, not a smaller set that overshoots it', () => {
    expect(pickSum([{ n: 50 }, { n: 10 }, { n: 20 }], 30)).toEqual([{ n: 10 }, { n: 20 }]);
  });

  it('takes the fewest events when more than one set adds up', () => {
    expect(pickSum([{ n: 10 }, { n: 20 }, { n: 30 }], 30)).toEqual([{ n: 30 }]);
  });

  it('gives null when no set adds up to the target', () => {
    expect(pickSum([{ n: 40 }], 30)).toBeNull();
  });
});

describe('extPlan', () => {
  const review = phaseOf('Application Review', '2020-01-01', '2020-06-30', { order: 1, isCompleted: true, extensionDays: 30 });
  const decision = phaseOf('EAC Decision', '2020-07-01', '2020-09-30', { order: 2, isCompleted: true, extensionDays: 45 });

  it('counts the events inside a phase that add up to its extension days toward that phase', () => {
    const plan = extPlan(workOf([review], { milestones: [extension('2020-03-01', 30)] }));

    expect(plan.evs.map((x) => [x.ph?.name, x.counted])).toEqual([['Application Review', true]]);
    expect(plan.noDates).toEqual([0]);
  });

  it('keeps the extension days no events add up to as days with no recorded dates', () => {
    const plan = extPlan(workOf([review, decision], { milestones: [extension('2020-03-01', 30), extension('2020-08-01', 20)] }));

    expect(plan.noDates).toEqual([0, 45]);
    expect(plan.evs.map((x) => [x.ph?.name, x.counted])).toEqual([
      ['Application Review', true],
      ['EAC Decision', false],
    ]);
  });
});
