import { describe, expect, it } from 'vitest';
import { phaseToneOf } from './phase-tone';

describe('phaseToneOf', () => {
  it.each([
    ['Initial Contact', 'review'],
    ['Early Engagement', 'review'],
    ['Pre-EA', 'planning'],
    ['Process Planning', 'planning'],
    ['Application Development (Proponent)', 'proponent'],
    ['Readiness Decision', 'readiness'],
    ['Recommendation', 'decision'],
    ['SubStart Decision', 'decision'],
  ])('colours %s as %s, as the design templates do', (name, tone) => {
    expect(phaseToneOf({ name, stage: null })).toBe(tone);
  });
});
