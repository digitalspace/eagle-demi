import type { WorkRow } from './derive';
import { dayNumber } from './timeline-scale';

export type LookaheadWindow = '30d' | '90d' | '6m';

export const WINDOWS: { value: LookaheadWindow; label: string }[] = [
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '6m', label: '6 months' },
];

/** How captions and empty states name each window. */
export const WINDOW_PHRASE: Record<LookaheadWindow, string> = {
  '30d': 'the next 30 days',
  '90d': 'the next 90 days',
  '6m': 'the next 6 months',
};

export interface Milestone {
  key: string;
  row: WorkRow;
  date: string;
  inDays: number;
  kind: 'phase' | 'decision';
  /** "Effects Assessment starts", "Decision due" or "Decision expected". */
  what: string;
}

/** One Monday-to-Sunday week of the window. */
export interface Week {
  start: string;
  end: string;
  /** The week holding today, always the first. */
  current: boolean;
  milestones: Milestone[];
  decisions: number;
}

const DAY_MS = 86_400_000;
const isoOf = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);
/** Day 0, 1 Jan 1970, was a Thursday. */
const mondayOf = (day: number) => day - ((day + 3) % 7);

/** Last day in the window, inclusive: today plus 30 or 90 days, or the same date six months on. */
export function windowEnd(today: string, window: LookaheadWindow): string {
  if (window !== '6m') return isoOf(dayNumber(today) + (window === '30d' ? 30 : 90));
  const date = new Date(`${today}T00:00:00Z`);
  const day = date.getUTCDate();
  date.setUTCMonth(date.getUTCMonth() + 6);
  // 31 Aug plus six months rolls into March; step back to the last day of February.
  if (date.getUTCDate() !== day) date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}

/** Phase starts of open phases and decision dates from today to `end`, both inclusive, in date order. Closed works have none. */
export function milestonesIn(rows: WorkRow[], today: string, end: string): Milestone[] {
  const from = dayNumber(today);
  const inWindow = (date: string | null): date is string => date !== null && date >= today && date <= end;
  const milestones = rows.flatMap((row) => {
    if (row.closed) return [];
    const id = `${row.work.source}:${row.work.workId}`;
    const make = (kind: Milestone['kind'], date: string, what: string, index: number): Milestone => ({
      key: `${id}:${kind}:${index}`,
      row,
      date,
      inDays: dayNumber(date) - from,
      kind,
      what,
    });
    const starts = row.phases.flatMap((phase, index) => {
      const date = phase.startDate ? phase.startDate.slice(0, 10) : null;
      return !phase.isCompleted && inWindow(date) ? [make('phase', date, `${phase.name || 'Unnamed phase'} starts`, index)] : [];
    });
    const decision = row.decisionDate;
    if (!inWindow(decision)) return starts;
    return [...starts, make('decision', decision, row.decisionExpected ? 'Decision expected' : 'Decision due', 0)];
  });
  return milestones.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.row.work.title ?? '').localeCompare(b.row.work.title ?? ''),
  );
}

/** Every week from the one holding today to the one holding `end`, each with its milestones. */
export function weeksOf(milestones: Milestone[], today: string, end: string): Week[] {
  const first = mondayOf(dayNumber(today));
  const weeks: Week[] = [];
  for (let day = first; day <= mondayOf(dayNumber(end)); day += 7) {
    weeks.push({ start: isoOf(day), end: isoOf(day + 6), current: day === first, milestones: [], decisions: 0 });
  }
  for (const milestone of milestones) {
    const week = weeks[(mondayOf(dayNumber(milestone.date)) - first) / 7];
    week.milestones.push(milestone);
    if (milestone.kind === 'decision') week.decisions += 1;
  }
  return weeks;
}

/** Overdue works, most days over first. */
export function overdueNow(rows: WorkRow[]): WorkRow[] {
  return rows
    .filter((row) => row.overdue)
    .sort((a, b) => b.daysOver - a.daysOver || (a.work.title ?? '').localeCompare(b.work.title ?? ''));
}
