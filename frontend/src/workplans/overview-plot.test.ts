import { describe, expect, it } from 'vitest';
import { plotAt, plotPx } from './overview-plot';

describe('plotPx and plotAt', () => {
  it('leave 84 px empty at each end of the track', () => {
    expect(plotPx(0, 1000)).toBe(84);
    expect(plotPx(1, 1000)).toBe(916);
  });

  it('invert each other', () => {
    expect(plotAt(plotPx(0.37, 1000), 1000)).toBeCloseTo(0.37, 10);
    expect(plotPx(plotAt(500, 1000), 1000)).toBeCloseTo(500, 10);
  });
});
