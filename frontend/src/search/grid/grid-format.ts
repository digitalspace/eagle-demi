import type { FilterValue } from '../grid-types';

/** A filter value as one string; a multi-select holds a list, a year holds one. */
export function asText(value: FilterValue | undefined): string {
  if (value == null) return '';
  return Array.isArray(value) ? value.join(',') : value;
}

/** Page buttons with gaps: first, last, and two either side of the current page. */
export function pageNumbers(total: number, current: number): (number | 'ellipsis')[] {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const pages: (number | 'ellipsis')[] = [1];
  let startPage = Math.max(2, current - 2);
  let endPage = Math.min(total - 1, current + 2);
  if (current <= 4) endPage = Math.min(5, total - 1);
  if (current >= total - 3) startPage = Math.max(2, total - 4);
  if (startPage > 2) pages.push('ellipsis');
  for (let page = startPage; page <= endPage; page += 1) pages.push(page);
  if (endPage < total - 1) pages.push('ellipsis');
  if (total > 1) pages.push(total);
  return pages;
}

export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

const n = (value: number) => value.toLocaleString('en-CA');

/** "1–25 of 240 documents matching", or nothing while the first answer is out. */
export function countText(options: {
  loading: boolean;
  total: number;
  page: number;
  pageSize: number;
  noun: string;
  narrowed: boolean;
}): string {
  const { loading, total, page, pageSize, noun, narrowed } = options;
  if (loading) return '';
  if (total === 0) return `No ${noun}`;
  const last = Math.min(page * pageSize, total);
  const first = Math.min((page - 1) * pageSize + 1, last);
  const range = `${n(first)}–${n(last)} of ${n(total)} ${noun}`;
  return narrowed ? `${range} matching` : range;
}
