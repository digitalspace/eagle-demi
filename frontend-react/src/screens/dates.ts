/**
 * Angular's `date:'dd MMM'`: "05 Sep", in its own English month names rather than the browser's
 * ICU data, which spells the same month "Sept." under en-CA. Empty for a date that will not parse,
 * as the pipe renders nothing.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function dayMonth(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  return isNaN(date.getTime()) ? '' : `${String(date.getDate()).padStart(2, '0')} ${MONTHS[date.getMonth()]}`;
}
