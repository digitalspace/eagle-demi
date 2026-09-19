import { describe, expect, it } from 'vitest';
import { cad, dayMonth, dayMonthYear, dayMonthYearTime, isoDay } from './dates';
import { localIso } from './test-dates';

/** Every case here is in the same year; only the month and day carry meaning. */
const on = (month: number, day: number, hour?: number, minute?: number) =>
  localIso(2026, month, day, hour, minute);

describe('dayMonth', () => {
  // Angular's `date:'dd MMM'` under its default locale. en-CA's ICU data spells September
  // "Sept.", which is the difference this helper exists to hold.
  it('spells every month the way the Angular screens do', () => {
    const months = Array.from({ length: 12 }, (_, month) => dayMonth(on(month, 5)));

    expect(months).toEqual([
      '05 Jan', '05 Feb', '05 Mar', '05 Apr', '05 May', '05 Jun',
      '05 Jul', '05 Aug', '05 Sep', '05 Oct', '05 Nov', '05 Dec',
    ]);
  });

  it('pads the day to two digits', () => {
    expect(dayMonth(on(8, 1))).toBe('01 Sep');
    expect(dayMonth(on(8, 24))).toBe('24 Sep');
  });

  it('renders nothing for a missing or unparseable date', () => {
    expect(dayMonth(null)).toBe('');
    expect(dayMonth(undefined)).toBe('');
    expect(dayMonth('')).toBe('');
    expect(dayMonth('not a date')).toBe('');
  });
});

describe('dayMonthYear', () => {
  it('leaves the day unpadded, as Angular’s `d MMM y` does', () => {
    expect(dayMonthYear(on(8, 5))).toBe('5 Sep 2026');
    expect(dayMonthYear(on(8, 24))).toBe('24 Sep 2026');
  });

  it('renders nothing for a missing or unparseable date', () => {
    expect(dayMonthYear(null)).toBe('');
    expect(dayMonthYear(undefined)).toBe('');
    expect(dayMonthYear('')).toBe('');
    expect(dayMonthYear('not a date')).toBe('');
  });
});

describe('dayMonthYearTime', () => {
  it('prints the clock on 24 hours', () => {
    expect(dayMonthYearTime(on(8, 5, 14, 3))).toBe('5 Sep 2026, 14:03');
    expect(dayMonthYearTime(on(8, 5, 23, 59))).toBe('5 Sep 2026, 23:59');
  });

  it('pads both the hour and the minute to two digits', () => {
    expect(dayMonthYearTime(on(8, 5, 0, 0))).toBe('5 Sep 2026, 00:00');
    expect(dayMonthYearTime(on(8, 5, 9, 7))).toBe('5 Sep 2026, 09:07');
  });

  it('renders nothing for a missing or unparseable date', () => {
    expect(dayMonthYearTime(null)).toBe('');
    expect(dayMonthYearTime(undefined)).toBe('');
    expect(dayMonthYearTime('')).toBe('');
    expect(dayMonthYearTime('not a date')).toBe('');
  });
});

// `new Date('2014-10-14')` is UTC midnight, which is the 13th anywhere west of Greenwich. Angular's
// date pipe reads a date-only string as local midnight, and these dates are days, not instants: a
// decision dated the 14th must read as the 14th in BC.
describe('a date-only string', () => {
  it('is the day it says, not the day before', () => {
    expect(dayMonth('2014-10-14')).toBe('14 Oct');
    expect(dayMonthYear('2014-10-14')).toBe('14 Oct 2014');
    expect(dayMonthYear('2014-01-01')).toBe('1 Jan 2014');
    expect(isoDay('2014-10-14')).toBe('2014-10-14');
  });

  it('sits at local midnight, so it prints no borrowed clock', () => {
    expect(dayMonthYearTime('2014-10-14')).toBe('14 Oct 2014, 00:00');
  });

  it('is still refused when the numbers are not a date', () => {
    expect(dayMonthYear('2014-13-40')).toBe('');
  });
});

describe('isoDay', () => {
  it('prints the calendar day of an instant', () => {
    expect(isoDay(on(2, 4))).toBe('2026-03-04');
    expect(isoDay(on(0, 1, 23, 30))).toBe('2026-01-01');
  });

  it('renders nothing for a missing or unparseable date', () => {
    expect(isoDay(null)).toBe('');
    expect(isoDay('not a date')).toBe('');
  });
});

describe('cad', () => {
  it('prints the CAD symbol the app’s en-US locale uses, to four decimals', () => {
    expect(cad(0.0123)).toBe('CA$0.0123');
    expect(cad(12.5)).toBe('CA$12.5000');
    expect(cad(0)).toBe('CA$0.0000');
  });

  it('groups thousands', () => {
    expect(cad(1234.5)).toBe('CA$1,234.5000');
  });
});
