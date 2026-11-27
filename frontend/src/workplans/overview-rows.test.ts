import { describe, expect, it } from 'vitest';
import { phaseOf, workOf } from './__tests__/works';
import { phaseDays } from './chart-facts';
import { rowTags } from './overview-chips';
import { rowFacts } from './overview-rows';

const TODAY = '2026-11-17';

// Day 260 on TODAY.
const running = (extra = {}) => phaseOf('Process Planning', '2026-03-02', null, { isCurrent: true, numberOfDays: 30, ...extra });

describe('rowFacts', () => {
  it('counts the day of a phase with a legal limit and tags the days over it', () => {
    const facts = rowFacts([workOf([running({ legislated: true })])], TODAY);

    expect(facts.l2).toBe('Day 260 of Process Planning');
    expect(facts.tail).toBe('230 days over limit');
  });

  it('says a planned length on the status line and never tags it: an overage is for legislated phases only', () => {
    const facts = rowFacts([workOf([running({ legislated: false })])], TODAY);

    expect(facts.l2).toMatch(/^Day \d+ of Process Planning, planned \d+ days$/);
    expect(facts.tail).toBe('');
    expect(facts.over).toBe(0);
  });

  it('never tags a work Track switched off as over plan', () => {
    const facts = rowFacts([workOf([running({ legislated: false })], { isActive: false })], TODAY);

    expect(facts.l2).toBe('Process Planning, inactive in Track');
    expect(facts.tail).toBe('');
  });

  it('names the outcome of a finished row without repeating its work type', () => {
    const amendment = workOf([], {
      workTypeCode: 'amendment',
      workType: 'Amendment',
      workState: 'COMPLETED',
      isActive: false,
      outcome: 'Amendment Granted',
      decisionDate: '2015-01-20',
    });
    const facts = rowFacts([amendment], TODAY);

    expect(facts.l2w).toBe('Amendment');
    expect(facts.l2).toBe('Approved 2015-01-20');
  });
});

describe('rowTags', () => {
  it('flags a passed planned decision red and a phase ending before it starts yellow', () => {
    const work = workOf([running({ numberOfDays: null }), phaseOf('Pre-EA', '2025-06-01', '2025-01-01', { isCompleted: true })], { decisionEventDate: '2026-10-01' });

    expect(rowTags(rowFacts([work], TODAY), TODAY).map((tag) => [tag.text, tag.tone])).toEqual([
      ['Decision overdue', 'red'],
      ['Dates conflict', 'yellow'],
    ]);
  });
});

describe('phaseDays', () => {
  const evaluation = phaseOf('Evaluation', '2005-01-01', '2005-12-31', { isCompleted: true, numberOfDays: 30, legislated: true });
  const sheet = { source: 'sheet' as const, workState: 'completed', isActive: false };

  it('never counts a 2002 sheet Evaluation over its limit, as its real end is unknown', () => {
    expect(phaseDays(evaluation, { ...sheet, actYear: 2002 }, TODAY)?.over).toBe(0);
  });

  it('counts the same Evaluation over its limit under the 1996 Act', () => {
    expect(phaseDays(evaluation, { ...sheet, actYear: 1996 }, TODAY)?.over).toBe(334);
  });
});
