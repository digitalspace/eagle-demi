import { describe, expect, it } from 'vitest';
import { shortDate, weekdayDate, weekOf } from './format';

describe('date formats', () => {
  it('leaves the year off a date in the current year only', () => {
    expect(shortDate('2026-11-01', '2026-11-18')).toBe('Nov 1');
    expect(shortDate('2027-11-01', '2026-11-18')).toBe('Nov 1, 2027');
  });

  it('keeps the calendar day of a date-only string', () => {
    expect(weekdayDate('2026-10-22')).toBe('Thu, Oct 22');
    expect(weekOf('2026-10-19')).toBe('Week of Oct 19');
  });
});
