import { describe, expect, it } from 'vitest';
import { dayMonth } from './dates';

/** Local noon, so the day is the same whatever timezone the test box runs in. */
const noonOn = (month: number, day: number) => new Date(2026, month, day, 12).toISOString();

describe('dayMonth', () => {
  // Angular's `date:'dd MMM'` under its default locale. en-CA's ICU data spells September
  // "Sept.", which is the difference this helper exists to hold.
  it('spells every month the way the Angular screens do', () => {
    const months = Array.from({ length: 12 }, (_, month) => dayMonth(noonOn(month, 5)));

    expect(months).toEqual([
      '05 Jan', '05 Feb', '05 Mar', '05 Apr', '05 May', '05 Jun',
      '05 Jul', '05 Aug', '05 Sep', '05 Oct', '05 Nov', '05 Dec',
    ]);
  });

  it('pads the day to two digits', () => {
    expect(dayMonth(noonOn(8, 1))).toBe('01 Sep');
    expect(dayMonth(noonOn(8, 24))).toBe('24 Sep');
  });

  it('renders nothing for a missing or unparseable date', () => {
    expect(dayMonth(null)).toBe('');
    expect(dayMonth(undefined)).toBe('');
    expect(dayMonth('')).toBe('');
    expect(dayMonth('not a date')).toBe('');
  });
});
