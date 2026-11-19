import type { MilestoneKind, WorkplanMilestone } from '../api/sheet-works';
import { dayMonthYear } from '../dates';
import { rowKey, type WorkRow } from './derive';
import { dayOf, endOf, plusDays } from './phase-bounds';

export type PointKind = 'decision' | 'transition-in' | 'transition-out' | 'section-13';
export type RangeKind = 'comment-period' | 'extension' | 'interregnum' | 'suspension';

export interface MarkerPoint {
  kind: PointKind;
  day: string;
  label: string;
}

export interface MarkerRange {
  kind: RangeKind;
  start: string;
  end: string;
  label: string;
  /** Still running: `end` is today. */
  open: boolean;
}

export interface Markers {
  points: MarkerPoint[];
  ranges: MarkerRange[];
}

/** A range whose null end runs on to today. */
type Draft = Omit<MarkerRange, 'end' | 'open'> & { end: string | null };

const milestonesOf = (row: WorkRow, kind: MilestoneKind) =>
  (row.work.milestones ?? []).filter((milestone) => milestone.kind === kind);
const dayOfMilestone = (m: WorkplanMilestone) => dayOf(m.actualDate ?? m.anticipatedDate);

/** The `act-transition` milestone's day stands in when the work's own transition has no date. */
function transitionDayOf(row: WorkRow, date: string | null | undefined): string | null {
  const [milestone] = milestonesOf(row, 'act-transition');
  return dayOf(date) ?? (milestone ? dayOfMilestone(milestone) : null);
}

const outDayOf = (row: WorkRow) => (row.work.transitionOut ? transitionDayOf(row, row.work.transitionOut.date) : null);
const inDayOf = (row: WorkRow) => (row.work.transitionIn ? transitionDayOf(row, row.work.transitionIn.date) : null);

function pointsOf(row: WorkRow): MarkerPoint[] {
  const { transitionOut, transitionIn } = row.work;
  const out = outDayOf(row);
  const into = inDayOf(row);
  const points: MarkerPoint[] = milestonesOf(row, 'section-13').flatMap((m) => {
    const day = dayOfMilestone(m);
    return day ? [{ kind: 'section-13' as const, day, label: 'Section 13 order' }] : [];
  });
  if (row.decisionDate) {
    points.push({ kind: 'decision', day: row.decisionDate, label: row.decisionExpected ? 'Decision expected' : 'Decision' });
  }
  if (out) points.push({ kind: 'transition-out', day: out, label: `To ${transitionOut?.toActYear ?? 'next'} Act` });
  if (into) points.push({ kind: 'transition-in', day: into, label: `From ${transitionIn?.fromActYear ?? 'earlier'} Act` });
  return points;
}

/** From the milestone's day to its end date, else for its number of days; none when neither is known. */
function milestoneRange(m: WorkplanMilestone, kind: RangeKind, label: string): Draft[] {
  const start = dayOfMilestone(m);
  const end = dayOf(m.endDate) ?? (start && m.numberOfDays ? plusDays(start, m.numberOfDays) : null);
  return start && end ? [{ kind, start, end, label: m.name ?? label }] : [];
}

function interruptionRanges(row: WorkRow): Draft[] {
  return row.phases
    .flatMap((phase) => phase.interruptions)
    .flatMap((stop) => {
      const start = dayOf(stop.startDate);
      const end = dayOf(stop.endDate);
      if (!start || !end || (stop.kind !== 'extension' && stop.kind !== 'interregnum')) return [];
      const name = stop.kind === 'extension' ? 'Extension' : 'Interregnum';
      return [{ kind: stop.kind, start, end, label: [name, stop.legalSection].filter(Boolean).join(' ') }];
    });
}

/** A suspension with no resumption runs to the end of the phase it began in, else to today while the work is open. */
function unresumed(row: WorkRow, start: string): Draft[] {
  const holding = row.phases.filter((phase) => (dayOf(phase.startDate) ?? '') <= start).at(-1);
  const end = holding ? endOf(holding) : null;
  if (end && end >= start) return [{ kind: 'suspension', start, end, label: 'Suspension' }];
  return row.closed ? [] : [{ kind: 'suspension', start, end: null, label: 'Suspension' }];
}

/** Each `suspension` milestone to the next `resumption`; Track's own open suspension runs from `suspendedSince`. */
function suspensionRanges(row: WorkRow): Draft[] {
  const events = [...milestonesOf(row, 'suspension'), ...milestonesOf(row, 'resumption')]
    .map((m) => ({ kind: m.kind, day: dayOf(m.actualDate) }))
    .filter((e): e is { kind: MilestoneKind; day: string } => e.day !== null)
    .sort((a, b) => a.day.localeCompare(b.day) || (a.kind === 'suspension' ? -1 : 1));
  const ranges: Draft[] = [];
  let pending: string | null = null;
  for (const event of events) {
    if (event.kind === 'suspension') pending ??= event.day;
    else if (pending) {
      ranges.push({ kind: 'suspension', start: pending, end: event.day, label: 'Suspension' });
      pending = null;
    }
  }
  const openSince = row.work.source === 'track' ? row.suspendedSince : null;
  if (openSince) return [...ranges, { kind: 'suspension', start: openSince, end: null, label: 'Suspension' }];
  return pending ? [...ranges, ...unresumed(row, pending)] : ranges;
}

function draftsOf(row: WorkRow): Draft[] {
  return [
    ...milestonesOf(row, 'comment-period').flatMap((m) => milestoneRange(m, 'comment-period', 'Comment period')),
    ...milestonesOf(row, 'extension').flatMap((m) => milestoneRange(m, 'extension', 'Extension')),
    ...milestonesOf(row, 'interregnum').flatMap((m) => milestoneRange(m, 'interregnum', 'Interregnum')),
    ...interruptionRanges(row),
    ...suspensionRanges(row),
  ];
}

/** Dated events and periods of one work, drawn over or under its phases; a range still running ends today. */
export function markersOf(row: WorkRow, today: string): Markers {
  const ranges = draftsOf(row)
    .map((draft) => ({ ...draft, end: draft.end ?? today, open: draft.end === null }))
    .filter((range) => range.end >= range.start);
  return { points: pointsOf(row), ranges };
}

/** The markers as plain sentences in date order, for screen readers; empty when there are none. */
export function markerSummaryOf(row: WorkRow): string {
  const items = [
    ...pointsOf(row).map((p) => ({ day: p.day, text: `${p.label} ${dayMonthYear(p.day)}.` })),
    ...draftsOf(row).map((r) => ({
      day: r.start,
      text: r.end
        ? `${r.label} ${dayMonthYear(r.start)} to ${dayMonthYear(r.end)}.`
        : `${r.label} since ${dayMonthYear(r.start)}.`,
    })),
  ];
  return items
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((item) => item.text)
    .join(' ');
}

/**
 * Both parts of each work that switched Act, keyed both ways by `rowKey`: same project, the out part's
 * `toActYear` is the in part's Act and back, and both name the same day.
 */
export function transitionPairsOf(rows: WorkRow[]): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const out of rows) {
    const day = outDayOf(out);
    if (!day) continue;
    const into = rows.find(
      (row) =>
        !pairs.has(rowKey(row)) &&
        row.work.projectId === out.work.projectId &&
        row.work.actYear === out.work.transitionOut?.toActYear &&
        row.work.transitionIn?.fromActYear === out.work.actYear &&
        inDayOf(row) === day,
    );
    if (into) {
      pairs.set(rowKey(out), rowKey(into));
      pairs.set(rowKey(into), rowKey(out));
    }
  }
  return pairs;
}
