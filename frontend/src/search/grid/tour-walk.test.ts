import { describe, expect, it } from 'vitest';
import type { TourStep } from './tour-steps';
import { landingAfter } from './tour-walk';

const steps = (...targets: string[]): TourStep[] =>
  targets.map((target) => ({ target, title: target, body: '' }));

describe('landingAfter', () => {
  it('hands the gone control its slot to the control after it', () => {
    const was = steps('search', 'types', 'more');

    expect(landingAfter(was, 'types', steps('search', 'more'))).toBe(1);
  });

  it('passes over later controls that have also gone', () => {
    const was = steps('search', 'types', 'scope', 'more', 'columns');

    expect(landingAfter(was, 'types', steps('search', 'more', 'columns'))).toBe(1);
  });

  it('answers with the place in the list that is left, not the old one', () => {
    const was = steps('types', 'more');

    expect(landingAfter(was, 'types', steps('search', 'scope', 'more'))).toBe(2);
  });

  it('lands on the last control left when nothing after the gone one remains', () => {
    const was = steps('search', 'types', 'more');

    expect(landingAfter(was, 'more', steps('search', 'types'))).toBe(1);
  });

  it('starts from the first control when no control was being shown', () => {
    const was = steps('search', 'types', 'more');

    expect(landingAfter(was, null, steps('types', 'more'))).toBe(0);
  });
});
