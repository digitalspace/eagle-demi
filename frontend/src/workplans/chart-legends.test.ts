import { describe, expect, it } from 'vitest';
import { EXTRA_TIME_LABEL, PHASE_KEY } from './chart-colours';
import { KIND_GROUPS, KINDS, legendOf } from './chart-kinds';
import { OVERVIEW_LEGEND } from './overview-legend';

describe('the Record legend', () => {
  it('lists every mark kind in exactly one group', () => {
    const listed = KIND_GROUPS.flatMap((group) => group.kinds);

    expect([...listed].sort()).toEqual(Object.keys(KINDS).sort());
  });

  it('draws each entry under its own label', () => {
    const labels = legendOf().flatMap((group) => group.items.map((item) => item.label));

    expect(new Set(labels).size).toBe(labels.length);
  });

  it('keys Extra Time right after Evaluation', () => {
    const keys = PHASE_KEY.map((entry) => entry.key);

    expect(keys.indexOf('extra')).toBe(keys.indexOf('ready') + 1);
  });
});

describe('the Overview legend', () => {
  it('draws each entry under its own label', () => {
    const labels = OVERVIEW_LEGEND.flat().flatMap((group) => group.items.map((item) => item.label));

    expect(new Set(labels).size).toBe(labels.length);
  });

  it('keys Extra Time right after Evaluation', () => {
    const colours = OVERVIEW_LEGEND.flat().find((group) => group.title === 'Phase colours')?.items.map((item) => item.label) ?? [];

    expect(colours.indexOf(EXTRA_TIME_LABEL)).toBe(colours.indexOf('Readiness Decision (2018), Evaluation (1996, 2002)') + 1);
  });
});
