import { describe, expect, it } from 'vitest';
import { chronological } from './record-order';
import { phaseOf } from './__tests__/works';

const names = (xs: { name: string }[]) => xs.map((x) => x.name);
const step = (name: string, start: string | null, end: string | null = null) => ({ name, ph: phaseOf(name, start, end) });

describe('chronological', () => {
  it('puts the phases in the order they started, whatever order Track lists them in', () => {
    const listed = [step('Pre-EA', '2020-03-02'), step('Early Engagement', '2021-07-31'), step('Readiness Decision', '2022-08-12'), step('DPD Development', '2021-10-29')];
    expect(names(chronological(listed))).toEqual(['Pre-EA', 'Early Engagement', 'DPD Development', 'Readiness Decision']);
  });

  it('keeps an undated step after the dated step before it', () => {
    const listed = [step('Pre-EA', '2009-01-01'), { name: 'Evaluation', ph: undefined }, step('Application Review', '2008-01-01')];
    expect(names(chronological(listed))).toEqual(['Application Review', 'Pre-EA', 'Evaluation']);
  });
});
