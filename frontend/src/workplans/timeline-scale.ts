import type { WorkRow } from './derive';

export type Zoom = 'month' | 'quarter' | 'year' | 'fit';

export const ZOOMS: { value: Zoom; label: string }[] = [
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'year', label: 'Year' },
  { value: 'fit', label: 'Fit all' },
];

const DAY_MS = 86_400_000;
const YEAR_DAYS = 365.25;
/** Days one viewport shows at each fixed zoom; Fit all fits the whole extent instead. */
const VISIBLE_DAYS: Record<Exclude<Zoom, 'fit'>, number> = {
  month: YEAR_DAYS,
  quarter: 3 * YEAR_DAYS,
  year: 10 * YEAR_DAYS,
};
/** Narrowest axis cell that still holds a label such as "2026" or "Sep". */
const MIN_TICK_PX = 40;
/** Widest axis character (bold 12px digit) and a tick's side padding, to tell whether a label fits its cell. */
const LABEL_CHAR_PX = 7;
const TICK_PAD_PX = 8;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** UTC day count of an ISO day or timestamp. */
export const dayNumber = (iso: string) => Math.floor(Date.parse(iso.slice(0, 10)) / DAY_MS);

export type SpanKind = 'past' | 'current' | 'incomplete' | 'upcoming' | 'overrun' | 'suspended';
export interface Span {
  kind: SpanKind;
  start: string;
  end: string;
  name: string | null;
}

/** Every bar a row draws: its dated phases, the overdue overrun, and suspensions (an open one runs to today). */
export function spansOf(row: WorkRow, today: string): Span[] {
  const spans: Span[] = row.segments.map((segment) => ({
    kind: segment.state,
    start: segment.start,
    end: segment.end,
    name: segment.name,
  }));
  if (row.overrun) spans.push({ kind: 'overrun', ...row.overrun, name: null });
  const stops = row.phases.flatMap((phase) => phase.interruptions).filter((stop) => stop.kind === 'suspension');
  for (const stop of stops) {
    const start = stop.startDate?.slice(0, 10);
    const end = stop.endDate?.slice(0, 10) ?? (row.closed ? null : today);
    if (start && end && end >= start) spans.push({ kind: 'suspended', start, end, name: stop.legalSection });
  }
  return spans;
}

/** True when some row draws a dated suspension; a flag with no interruption dates draws only its tag. */
export const drawsSuspension = (rows: WorkRow[], today: string) =>
  rows.some((row) => spansOf(row, today).some((span) => span.kind === 'suspended'));

const TAG_AFTER = new Set<SpanKind>(['current', 'overrun', 'suspended']);

/** Day the suspended tag starts at: after the current phase, its overrun or a suspension, so it covers no label. */
export function tagDayOf(spans: Span[], today: string): number {
  const ends = spans.filter((span) => TAG_AFTER.has(span.kind)).map((span) => dayNumber(span.end));
  return ends.length ? Math.max(...ends) : dayNumber(today);
}

export interface Extent {
  start: number;
  end: number;
}

/** Earliest start to latest end over every row's bars, as day numbers; null when no row has a dated bar. */
export function extentOf(rows: WorkRow[], today: string): Extent | null {
  let extent: Extent | null = null;
  for (const span of rows.flatMap((row) => spansOf(row, today))) {
    const start = dayNumber(span.start);
    const end = dayNumber(span.end);
    extent = extent ? { start: Math.min(extent.start, start), end: Math.max(extent.end, end) } : { start, end };
  }
  return extent;
}

export interface Scale {
  /** First and last day number on the axis. */
  start: number;
  end: number;
  pxPerDay: number;
  /** Full lane width in px; wider than the viewport except at Fit all. */
  width: number;
}

const yearStart = (year: number) => Date.UTC(year, 0, 1) / DAY_MS;
const yearOf = (day: number) => new Date(day * DAY_MS).getUTCFullYear();

/**
 * The axis for a zoom. Fit all spans the extent exactly, in one viewport. Fixed zooms span whole years
 * from the extent (and today) at a fixed density, and scroll.
 */
export function scaleFor(extent: Extent | null, zoom: Zoom, today: string, viewportPx: number): Scale {
  const now = dayNumber(today);
  const first = Math.min(extent?.start ?? now, now);
  const last = Math.max(extent?.end ?? now, now);
  if (zoom === 'fit') {
    const start = extent?.start ?? now - 183;
    const end = Math.max(extent?.end ?? now + 183, start + 30);
    return { start, end, pxPerDay: viewportPx / (end - start), width: viewportPx };
  }
  const visible = VISIBLE_DAYS[zoom];
  const pxPerDay = viewportPx / visible;
  const start = yearStart(yearOf(first));
  const end = Math.max(yearStart(yearOf(last) + 1), start + Math.ceil(visible));
  return { start, end, pxPerDay, width: Math.round((end - start) * pxPerDay) };
}

export const xOf = (scale: Scale, day: number) => (day - scale.start) * scale.pxPerDay;

/** Scroll offset that puts `day` at fraction `at` of the viewport, clamped to the lane. */
export function scrollFor(scale: Scale, day: number, viewportPx: number, at = 0.25): number {
  const max = Math.max(0, scale.width - viewportPx);
  return Math.round(Math.min(max, Math.max(0, xOf(scale, day) - viewportPx * at)));
}

export interface Tick {
  x: number;
  width: number;
  label: string;
}

/** Axis cell sizes in months, finest first. */
const UNITS = [1, 3, 12, 60, 120];

function labelOf(year: number, month: number, unit: number, top: boolean): string {
  if (unit === 1) return MONTHS[month];
  if (unit === 3) return `Q${month / 3 + 1}`;
  return top && unit === 120 ? `${year}s` : String(year);
}

function ticksOf(scale: Scale, unit: number, top: boolean): Tick[] {
  const ticks: Tick[] = [];
  const from = new Date(scale.start * DAY_MS);
  let year = from.getUTCFullYear();
  let month = from.getUTCMonth();
  if (unit >= 12) {
    year -= year % (unit / 12);
    month = 0;
  } else {
    month -= month % unit;
  }
  for (let at = Date.UTC(year, month, 1) / DAY_MS; at < scale.end; ) {
    const label = labelOf(year, month, unit, top);
    month += unit;
    year += Math.floor(month / 12);
    month %= 12;
    const next = Date.UTC(year, month, 1) / DAY_MS;
    const x = Math.max(0, xOf(scale, at));
    const width = Math.min(scale.width, xOf(scale, next)) - x;
    // A cell cut short at either end of the axis drops a label it cannot hold.
    ticks.push({ x, width, label: width < label.length * LABEL_CHAR_PX + TICK_PAD_PX ? '' : label });
    at = next;
  }
  return ticks;
}

/** Two axis tiers: the finest unit wide enough to label, under the next coarser one (none above decades). */
export function ticksFor(scale: Scale): { top: Tick[]; bottom: Tick[] } {
  const dayPx = (months: number) => (months / 12) * YEAR_DAYS * scale.pxPerDay;
  const bottom = UNITS.find((unit) => dayPx(unit) >= MIN_TICK_PX) ?? UNITS[UNITS.length - 1];
  const top = bottom < 12 ? 12 : bottom < 120 ? 120 : null;
  return { top: top ? ticksOf(scale, top, true) : [], bottom: ticksOf(scale, bottom, false) };
}
