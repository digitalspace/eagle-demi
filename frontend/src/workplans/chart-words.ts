import type { WorkplanRow } from '../api/sheet-works';
import { count, plural } from './format';
import { dayOf, daysBetween } from './phase-bounds';

/**
 * Plain words for data strings: section numbers spelled out, one name for an issued certificate.
 * "Certificate Not Required" and "Certificate Refused" keep their meaning; an outcome not listed shows as recorded.
 */
export const plainWords = (text: string | null | undefined) =>
  String(text ?? '')
    .replace(/^s\.\s?(\d+(?:\(\d+\))*) Extension of Time Limit$/i, 'Time limit extension, section $1')
    .replace(/Environmental Assessment Certificate GRANTED|Certificate Issued/gi, 'Certificate issued')
    .replace(/Certificate Not Required/gi, 'Certificate not required')
    .replace(/Certificate Refused/gi, 'Certificate refused')
    .replace(/Amendment Granted/gi, 'Amendment approved')
    .replace(/Decision Maker Designates Project as Reviewable/gi, 'Designated as reviewable')
    .replace(/\bGRANTED\b/g, 'granted')
    .replace(/\bs\.\s?(\d)/g, 'section $1');

/** A work or phase state code in words: "IN_PROGRESS" reads "in progress". */
export const humanState = (state: string | null | undefined) =>
  /^transitioned$/i.test(state ?? '') ? 'moved to another Act' : String(state ?? '').toLowerCase().replace(/[_-]+/g, ' ');

/** "EAC" for "Environmental Assessment Certificate", to fit a chip or key. */
export const shortCert = (text: string) => text.replace('Environmental Assessment Certificate', 'EAC');

type Outcome = Pick<WorkplanRow, 'outcome' | 'outcomeFrom'>;
type Decided = Outcome & Pick<WorkplanRow, 'decisionDate' | 'workState'>;

/** The outcome in plain words, marked when it was taken from the work's Track copy; null when none. */
export const outcomeText = (work: Outcome) =>
  work.outcome ? plainWords(work.outcome) + (work.outcomeFrom === 'track' ? ' (from Track)' : '') : null;

/** The outcome with its decision day, or the work state in words when there is no outcome. */
export function stateText(work: Decided): string {
  const outcome = outcomeText(work);
  if (!outcome) return humanState(work.workState);
  const decided = dayOf(work.decisionDate);
  return decided ? `${outcome} ${decided}` : outcome;
}

/** "same day", "1 day", "12 days" from one day to another. */
export function lengthText(start: string, end: string): string {
  const days = daysBetween(start, end);
  return days === 0 ? 'same day' : plural(days, 'day');
}

/** "120 days", or "4,505 days (12.3 years)" from two years on; non-breaking spaces keep it on one line. */
export function duration(days: number): string {
  const text = days >= 730 ? `${count(days)} days (${(days / 365.25).toFixed(1)} years)` : plural(days, 'day');
  return text.replace(/ /g, ' ');
}

/** The gap since the entry before: "Same day", "12 days later", "3 months later", "2 years 1 month later". */
export function ago(days: number): string {
  if (days <= 0) return 'Same day';
  if (days < 60) return `${plural(days, 'day')} later`;
  const months = Math.round(days / 30.44);
  if (months < 12) return `${plural(months, 'month')} later`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return `${plural(years, 'year')}${rest ? ` ${plural(rest, 'month')}` : ''} later`;
}
