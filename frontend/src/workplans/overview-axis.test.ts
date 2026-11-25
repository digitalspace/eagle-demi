import { describe, expect, it } from 'vitest';
import { phaseOf, workOf } from './__tests__/works';
import { axisOf, axisTicks } from './overview-axis';

const TODAY = '2026-11-17';
// Dates from 1999 to 2005 give a 1999 to 2006 axis, with the 2002 Act line inside it.
const WORKS = [workOf([phaseOf('Evaluation', '1999-03-01', '2005-06-01', { isCompleted: true })], { actYear: 2002 })];

const actLabel = (ppy: number) => {
  const axis = axisOf(WORKS, 2002, TODAY);
  if (!axis) throw new Error('no axis');
  return axisTicks(axis, ppy, TODAY).tlabels.find((label) => label.cls === 'upper');
};

describe('the Act line label', () => {
  it('names the Act and its day when the track has room', () => {
    expect(actLabel(200)?.text).toBe('2002 Act took effect 2002-12-30');
  });

  it('falls back to a shorter form on a narrow track, keeping the full one on hover', () => {
    expect(actLabel(40)).toMatchObject({ text: '2002 Act', title: '2002 Act took effect 2002-12-30' });
  });
});
