import { describe, expect, it } from 'vitest';
import { countText, isValidIsoDate, pageNumbers } from './grid-format';

describe('pageNumbers', () => {
  it('lists every page when there are seven or fewer', () => {
    expect(pageNumbers(7, 4)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('draws the ends, a window around the current page, and gaps between', () => {
    expect(pageNumbers(30, 9)).toEqual([1, 'ellipsis', 7, 8, 9, 10, 11, 'ellipsis', 30]);
  });

  it('runs the first five pages together near the start, with one gap before the last', () => {
    expect(pageNumbers(30, 1)).toEqual([1, 2, 3, 4, 5, 'ellipsis', 30]);
  });

  it('runs the last five pages together near the end, with one gap after the first', () => {
    expect(pageNumbers(30, 30)).toEqual([1, 'ellipsis', 26, 27, 28, 29, 30]);
  });

  it('draws a single page for an empty result set', () => {
    expect(pageNumbers(1, 1)).toEqual([1]);
  });

  it('draws the last page as current once a page past the end is clamped', () => {
    expect(pageNumbers(3, 3)).toEqual([1, 2, 3]);
  });
});

describe('countText', () => {
  const base = { loading: false, total: 240, page: 1, pageSize: 25, noun: 'documents', narrowed: false };

  it('says nothing while the first answer is out', () => {
    expect(countText({ ...base, loading: true })).toBe('');
  });

  it('names the record type when nothing matched', () => {
    expect(countText({ ...base, total: 0 })).toBe('No documents');
  });

  it('gives the range on screen and the total', () => {
    expect(countText(base)).toBe('1–25 of 240 documents');
  });

  it('ends the range at the total on the last, partial page', () => {
    expect(countText({ ...base, page: 10 })).toBe('226–240 of 240 documents');
  });

  it('does not start the range past its end on a page beyond the results', () => {
    expect(countText({ ...base, total: 5, page: 3 })).toBe('5–5 of 5 documents');
  });

  it('adds "matching" when a filter or search has narrowed the results', () => {
    expect(countText({ ...base, narrowed: true })).toBe('1–25 of 240 documents matching');
  });

  it('groups thousands in the range and the total', () => {
    expect(countText({ ...base, total: 12345, page: 100 })).toBe('2,476–2,500 of 12,345 documents');
  });
});

describe('isValidIsoDate', () => {
  it('accepts a real calendar date', () => {
    expect(isValidIsoDate('2024-03-15')).toBe(true);
    expect(isValidIsoDate('2024-12-31')).toBe(true);
    expect(isValidIsoDate('2024-01-01')).toBe(true);
  });

  it('accepts February 29 in a leap year', () => {
    expect(isValidIsoDate('2024-02-29')).toBe(true);
  });

  it('rejects February 29 outside a leap year', () => {
    expect(isValidIsoDate('2023-02-29')).toBe(false);
  });

  it('rejects a day the month does not have', () => {
    expect(isValidIsoDate('2023-02-30')).toBe(false);
    expect(isValidIsoDate('2024-04-31')).toBe(false);
  });

  it('rejects month and day numbers out of range', () => {
    expect(isValidIsoDate('2024-13-01')).toBe(false);
    expect(isValidIsoDate('2024-00-10')).toBe(false);
    expect(isValidIsoDate('2024-05-00')).toBe(false);
  });

  it('rejects strings that are not YYYY-MM-DD', () => {
    expect(isValidIsoDate('')).toBe(false);
    expect(isValidIsoDate('2024-3-5')).toBe(false);
    expect(isValidIsoDate('2024/03/15')).toBe(false);
    expect(isValidIsoDate('15-03-2024')).toBe(false);
    expect(isValidIsoDate('20240315')).toBe(false);
    expect(isValidIsoDate(' 2024-03-15')).toBe(false);
    expect(isValidIsoDate('2024-03-15T00:00:00Z')).toBe(false);
    expect(isValidIsoDate('March 15, 2024')).toBe(false);
  });
});
