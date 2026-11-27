// Date-only strings parse as UTC midnight, so formatting in UTC keeps the calendar day in every time zone.
const MONTH_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const MONTH_DAY_YEAR = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const WEEKDAY_DATE = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

const dateOf = (iso: string) => new Date(iso.slice(0, 10));

/** "Nov 1", or "Nov 1, 2027" when the year is not `today`'s. */
export function shortDate(iso: string, today: string): string {
  return (iso.slice(0, 4) === today.slice(0, 4) ? MONTH_DAY : MONTH_DAY_YEAR).format(dateOf(iso));
}

/** "Thu, Oct 22". */
export function weekdayDate(iso: string): string {
  return WEEKDAY_DATE.format(dateOf(iso));
}

/** "Week of Oct 19", for the week's first day. */
export function weekOf(iso: string): string {
  return `Week of ${MONTH_DAY.format(dateOf(iso))}`;
}

// One formatter: toLocaleString builds a new one per call, which shows when every row redraws.
const COUNT = new Intl.NumberFormat('en-CA');
/** "1,234". */
export const count = (n: number) => COUNT.format(n);

/** "1 work", "3 works"; `many` for a word that does not add "s" ("2 entries"). */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}
