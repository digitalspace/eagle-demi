import type { WorkplanMilestone, WorkplanRow } from '../api/sheet-works';
import { type MarkStyle, type Tip, tipOf } from './chart-types';
import { isOpenWork } from './chart-facts';
import { DAY_MS, dayNumber } from './phase-bounds';
import { ZOOMS } from './time-scale';

const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });

/** UTC day number of a date, null when there is none. */
export const dayNo = (iso: string | null | undefined): number | null => (iso ? dayNumber(iso) : null);
export const isoOf = (day: number) => new Date(Math.round(day) * DAY_MS).toISOString().slice(0, 10);
export const yearOf = (day: number) => new Date(day * DAY_MS).getUTCFullYear();

/** A milestone's actual day, else its anticipated day. */
export const milestoneDay = (m: WorkplanMilestone) => dayNo(m.actualDate || m.anticipatedDate);

/** A milestone's end day; a comment period without one ends `numberOfDays` after its start. */
export function milestoneEnd(m: WorkplanMilestone): number | null {
  if (m.endDate) return dayNo(m.endDate);
  const start = milestoneDay(m);
  return m.kind === 'comment-period' && start != null && m.numberOfDays ? start + m.numberOfDays : null;
}

/** In progress or suspended, with no decision, planned decision or move, and a phase started with no end. */
export const isOpenEnded = (w: WorkplanRow) =>
  !w.decisionDate &&
  !w.decisionEventDate &&
  !w.transitionOut &&
  isOpenWork(w) &&
  w.phases.some((ph) => ph.startDate && !ph.endDate);

/** Every day the Record page draws for a work; an open-ended work also reaches `today` when it is given. */
export function recordDays(w: WorkplanRow, today: string | null): number[] {
  const days = [
    dayNo(w.startDate),
    dayNo(w.decisionDate),
    dayNo(w.decisionEventDate),
    ...w.phases.flatMap((ph) => [
      dayNo(ph.startDate),
      dayNo(ph.endDate),
      ...ph.interruptions.flatMap((i) => [dayNo(i.startDate), dayNo(i.endDate)]),
    ]),
    ...(w.milestones ?? []).flatMap((m) => [milestoneDay(m), milestoneEnd(m)]),
  ].filter((day): day is number => day != null);
  if (today && isOpenEnded(w)) days.push(dayNumber(today));
  return days;
}

/** The work's start, else the first day it draws. */
export function recordStart(w: WorkplanRow, today: string): number | null {
  const start = dayNo(w.startDate);
  if (start != null) return start;
  const days = recordDays(w, today);
  return days.length ? Math.min(...days) : null;
}

export function recordEnd(w: WorkplanRow, today: string): number | null {
  const days = recordDays(w, today);
  return days.length ? Math.max(...days) : null;
}

/** The anticipated decision day of a work with no decision yet. */
export const plannedDecision = (w: WorkplanRow) => (!w.decisionDate && w.decisionEventDate ? dayNo(w.decisionEventDate) : null);

/** What one Record page shows on its single time axis. */
export interface AxisInput {
  assessment: WorkplanRow | null;
  /** The next Act's assessment, drawn as ghost bars after a move. */
  nextAssessment: WorkplanRow | null;
  later: readonly WorkplanRow[];
  certDay: number | null;
}

/** First and last day of the axis; the end is fractional. */
export interface RecordAxis {
  start: number;
  end: number;
}

export function recordAxis(input: AxisInput, today: string): RecordAxis {
  const now = dayNumber(today);
  const { assessment, nextAssessment } = input;
  const days: number[] = [];
  if (assessment) {
    days.push(...recordDays(assessment, today));
    const next = nextAssessment ? dayNo(nextAssessment.startDate) : null;
    if (next != null) days.push(next);
  }
  for (const w of input.later) {
    days.push(...recordDays(w, today));
    const planned = plannedDecision(w);
    if (planned != null) days.push(planned);
    if (isOpenWork(w)) days.push(now);
  }
  if (input.certDay != null) days.push(input.certDay);
  if (!days.length) days.push(now);
  let a = Math.min(...days);
  let b = Math.max(...days);
  if (b - a < 40) {
    const mid = (a + b) / 2;
    a = mid - 20;
    b = mid + 20;
  }
  const span = b - a;
  // An open start gets more room on the left for the bar's faded lead-in.
  const openStart = Boolean(assessment?.phases.some((ph) => !ph.startDate && ph.endDate));
  const d0 = new Date((a - span * (openStart ? 0.09 : 0.03)) * DAY_MS);
  const snap = span > 3 * 365 ? Date.UTC(d0.getUTCFullYear(), 0, 1) : Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), 1);
  return { start: Math.floor(snap / DAY_MS), end: b + span * 0.03 };
}

/** Index into `ZOOMS`; an unknown id is the whole range. */
export const zoomIndex = (zoom: string | null | undefined) => Math.max(0, ZOOMS.findIndex((z) => z.value === zoom));

/** The axis at one time scale; it also serves as a `RecordScale`. */
export interface RecordGeometry extends RecordAxis {
  /** Index into `ZOOMS`. */
  zoom: number;
  /** Width of the visible chart in pixels. */
  viewPx: number;
  pxPerYear: number;
  /** Width of the whole chart in pixels. */
  width: number;
  pct: (day: number) => number;
  px: (pct: number) => number;
}

/** `viewPx` falls back to 940 before the chart is measured. */
export function recordGeometry(axis: RecordAxis, zoom: number, viewPx = 940): RecordGeometry {
  const years = (axis.end - axis.start) / 365.25;
  const zoomYears = ZOOMS[zoom].years;
  const pxPerYear = zoomYears ? Math.max(viewPx / years, viewPx / zoomYears) : viewPx / years;
  const width = Math.round(pxPerYear * years);
  const pct = (day: number) => ((day - axis.start) / (axis.end - axis.start)) * 100;
  const px = (share: number) => (share / 100) * width;
  return { start: axis.start, end: axis.end, zoom, viewPx, pxPerYear, width, pct, px };
}

/** Pixels from the chart's left edge of a day. */
export const pxAt = (geo: RecordGeometry, day: number) => geo.px(geo.pct(day));

export interface AxisTick {
  /** `yr` year, `mo` month with a label, `q` unlabelled quarter. */
  kind: 'yr' | 'mo' | 'q';
  /** Percent across the chart. */
  left: number;
  /** Empty near the right edge, where it would be cut off. */
  label: string;
}

const monthStart = (year: number, month: number) => Date.UTC(year, month, 1) / DAY_MS;

/** Year ticks every 1, 2 or 5 years by density; quarters from 80 px a year, month labels from 300, months from 600. */
export function recordTicks(geo: RecordGeometry): { ticks: AxisTick[]; grid: number[] } {
  const { start, end, pxPerYear: ppy, width } = geo;
  const ticks: AxisTick[] = [];
  const grid = [geo.pct(start)];
  const push = (day: number, label: string, kind: AxisTick['kind']) => {
    if (day < start || day > end) return;
    ticks.push({ kind, left: geo.pct(day), label: pxAt(geo, day) > width - 36 ? '' : label });
  };
  const monthTick = (year: number, month: number, labelled: boolean) => {
    const day = monthStart(year, month);
    push(day, labelled ? MONTH.format(day * DAY_MS) : '', labelled ? 'mo' : 'q');
  };
  const step = ppy < 22 ? 5 : ppy < 45 ? 2 : 1;
  for (let year = yearOf(start); year <= yearOf(end); year++) {
    const jan = monthStart(year, 0);
    if (year % step === 0 || jan === start) {
      push(jan, String(year), 'yr');
      if (jan >= start && jan <= end) grid.push(geo.pct(jan));
    }
    if (ppy >= 600) for (let month = 1; month < 12; month++) monthTick(year, month, true);
    else if (ppy >= 80) for (const month of [3, 6, 9]) monthTick(year, month, ppy >= 300);
  }
  return { ticks, grid };
}

/** Sorts axis marks by position; a label flips left of its line near the right edge or when it crowds the one before. */
export function flipAxisMarks<T extends { at: number; cls: string }>(marks: readonly T[], width: number): T[] {
  const sorted = [...marks].sort((x, y) => x.at - y.at);
  const flipped = (m: T) => /\bflip\b/.test(m.cls);
  return sorted.reduce<T[]>((out, m, i) => {
    const prev = i > 0 ? out[i - 1] : null;
    const crowd = prev != null && m.at - prev.at < 90 && !flipped(prev);
    out.push(m.at > width - 110 || crowd ? { ...m, cls: `${m.cls} flip` } : m);
    return out;
  }, []);
}

export const todayIn = (axis: RecordAxis, today: string) => {
  const now = dayNumber(today);
  return now >= axis.start && now <= axis.end;
};

/** The today line and its axis mark, shaped as a `VLine` and an `AxisMark`; null when today is off the axis. */
export function todayMark(geo: RecordGeometry, today: string) {
  if (!todayIn(geo, today)) return null;
  const left = geo.pct(dayNumber(today));
  const tip: Tip = tipOf('Today', [['Date', today.slice(0, 10)]]);
  const style: MarkStyle = { left: `${left.toFixed(3)}%` };
  return {
    vline: { cls: 'vline', left },
    mark: { cls: 'mk tick mark today', style, tip, id: '', left, backAt: null, label: 'Today', at: geo.px(left) },
  };
}

/** Where a zoom change keeps the view: the day at the centre when zoomed in, else the left edge. */
export type ZoomAnchor = { mode: 'centre'; day: number } | { mode: 'left' };

export function zoomAnchor(geo: RecordGeometry, scrollLeft: number | null): ZoomAnchor {
  if (geo.zoom === 0 || scrollLeft == null) return { mode: 'left' };
  return { mode: 'centre', day: geo.start + ((scrollLeft + geo.viewPx / 2) / geo.width) * (geo.end - geo.start) };
}

const dayText = (day: number, months: boolean) => {
  const date = new Date(Math.round(day) * DAY_MS);
  return months ? `${MONTH.format(date)} ${date.getUTCFullYear()}` : String(date.getUTCFullYear());
};

/** Range text for the live region: years for the whole range, months when zoomed in so a month of scroll changes it. */
export function rangeAt(geo: RecordGeometry, scrollLeft: number): string {
  const { start, end, width, viewPx } = geo;
  if (geo.zoom === 0) return `Showing the whole range, ${dayText(start, false)} to ${dayText(end, false)}`;
  const d0 = start + (Math.max(0, scrollLeft) / width) * (end - start);
  const d1 = start + (Math.min(width, scrollLeft + viewPx) / width) * (end - start);
  return `Showing ${dayText(d0, true)} to ${dayText(d1, true)}`;
}

/** Scroll that centres today; null on the whole range or when today is off the axis. */
export function todayScroll(geo: RecordGeometry, today: string): number | null {
  if (geo.zoom === 0 || !todayIn(geo, today)) return null;
  return Math.max(0, Math.round(pxAt(geo, dayNumber(today)) - geo.viewPx / 2));
}

/** The first drawn day: the earliest step bar, else the earliest later work, else the axis start. */
export function firstDay(
  steps: readonly { s: number | null; e: number | null }[],
  later: readonly WorkplanRow[],
  axis: RecordAxis,
  today: string,
): number {
  const fromSteps = steps.flatMap((r) => (r.s == null ? [] : [Math.min(r.s, r.e ?? r.s)]));
  if (fromSteps.length) return Math.min(...fromSteps);
  const fromLater = later.flatMap((w) => recordStart(w, today) ?? []);
  return fromLater.length ? Math.min(...fromLater) : axis.start;
}
