/**
 * `date:'dd MMM'` as the Angular app (0038d3e) rendered it: "05 Sep", in the pipe's own English
 * month names rather than the browser's ICU data, which spells the same month "Sept." under en-CA.
 * Empty for a date that will not parse, as the pipe rendered nothing.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * `new Date` reads a date-only string as UTC midnight, which is the day before in any negative
 * offset, so BC would see "13 Oct" for a decision dated the 14th. The Angular app's date pipe
 * (0038d3e) read it as local midnight; this does the same. Null for anything that will not parse,
 * so callers render nothing, as the pipe did.
 */
function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const parts = DATE_ONLY.exec(iso);
  if (!parts) {
    const instant = new Date(iso);
    return isNaN(instant.getTime()) ? null : instant;
  }
  const [, year, month, day] = parts.map(Number);
  const date = new Date(year, month - 1, day);
  // `new Date(2014, 12, 40)` rolls over into 2015 rather than failing, so the roll-over is the check.
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

export function dayMonth(iso: string | null | undefined): string {
  const date = parse(iso);
  return date ? `${pad(date.getDate())} ${MONTHS[date.getMonth()]}` : '';
}

/** `date:'d MMM y'` as the Angular app (0038d3e) rendered it: "5 Sep 2024", the day unpadded. */
export function dayMonthYear(iso: string | null | undefined): string {
  const date = parse(iso);
  return date ? `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}` : '';
}

/** `date:'d MMM y, HH:mm'` as the Angular app (0038d3e) rendered it: "5 Sep 2024, 14:03", 24-hour clock. */
export function dayMonthYearTime(iso: string | null | undefined): string {
  const date = parse(iso);
  if (!date) return '';
  return `${dayMonthYear(iso)}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The registry subline's `toLocaleDateString('en-CA')`: "2026-03-04". */
export function isoDay(iso: string | null | undefined): string {
  const date = parse(iso);
  return date ? date.toLocaleDateString('en-CA') : '';
}

/**
 * `currency:'CAD':'symbol':'1.4-4'` as the Angular app (0038d3e) rendered it under its default
 * en-US locale, where the CAD symbol is "CA$". Four decimals because a single answer costs a fraction of a cent.
 */
export function cad(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'CAD',
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(amount);
}
