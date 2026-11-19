import type { WorkRow } from './derive';
import { dayOf, drawnPhasesOf, type PhaseState } from './phase-bounds';
import { markersOf } from './timeline-markers';

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

export type SpanKind =
  | PhaseState
  | 'overrun'
  | 'suspended'
  | 'extension'
  | 'interregnum'
  | 'comment-period'
  | 'decision'
  | 'section-13'
  | 'transition-in'
  | 'transition-out';

/** `phase`: phase bars, overrun and sheet suspensions; `overlay`: periods from `markersOf`; `marker`: one-day events. */
export type SpanLayer = 'phase' | 'overlay' | 'marker';

export interface Span {
  kind: SpanKind;
  layer: SpanLayer;
  start: string;
  /** Same day as `start` on a marker. */
  end: string;
  name: string | null;
  /** A bound that is a latest-possible day or a neighbour phase's bound, not a real date. */
  approx: { start: boolean; end: boolean };
}

/** Which layers to build; `phase` unless asked for `all`. */
export interface SpanOptions {
  layers?: 'phase' | 'all';
}

const EXACT = { start: false, end: false };

function phaseSpansOf(row: WorkRow, today: string): Span[] {
  const spans: Span[] = drawnPhasesOf(row, today).map((drawn) => ({
    kind: drawn.state,
    layer: 'phase',
    start: drawn.start,
    end: drawn.end,
    name: drawn.phase.name,
    approx: { start: drawn.approxStart, end: drawn.approxEnd },
  }));
  if (row.overrun) spans.push({ kind: 'overrun', layer: 'phase', ...row.overrun, name: null, approx: EXACT });
  const stops = row.phases.flatMap((phase) => phase.interruptions).filter((stop) => stop.kind === 'suspension');
  for (const stop of stops) {
    const start = dayOf(stop.startDate);
    const end = dayOf(stop.endDate) ?? (row.closed ? null : today);
    if (start && end && end >= start) {
      spans.push({ kind: 'suspended', layer: 'phase', start, end, name: stop.legalSection, approx: EXACT });
    }
  }
  return spans;
}

function markerSpansOf(row: WorkRow, today: string): Span[] {
  const { points, ranges } = markersOf(row, today);
  return [
    ...ranges.map((range): Span => ({
      kind: range.kind === 'suspension' ? 'suspended' : range.kind,
      layer: 'overlay',
      start: range.start,
      end: range.end,
      name: range.label,
      approx: EXACT,
    })),
    ...points.map((point): Span => ({
      kind: point.kind,
      layer: 'marker',
      start: point.day,
      end: point.day,
      name: point.label,
      approx: EXACT,
    })),
  ];
}

/**
 * A row's bars. Phase layer: drawn phases (approximate bounds flagged), the overdue overrun, and sheet suspensions
 * (an open one runs to today). `{ layers: 'all' }` adds overlay periods and markers from `markersOf`.
 */
export function spansOf(row: WorkRow, today: string, options: SpanOptions = {}): Span[] {
  const phases = phaseSpansOf(row, today);
  return options.layers === 'all' ? [...phases, ...markerSpansOf(row, today)] : phases;
}

/** Every bar kind some row draws; a suspended flag with no interruption dates draws only its tag. */
export const drawnKinds = (rows: WorkRow[], today: string, options?: SpanOptions): Set<SpanKind> =>
  new Set(rows.flatMap((row) => spansOf(row, today, options).map((span) => span.kind)));

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
export function extentOf(rows: WorkRow[], today: string, options?: SpanOptions): Extent | null {
  let extent: Extent | null = null;
  for (const span of rows.flatMap((row) => spansOf(row, today, options))) {
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
 * from the extent, and today unless `includeToday` is false, at a fixed density, and scroll.
 */
export function scaleFor(
  extent: Extent | null,
  zoom: Zoom,
  today: string,
  viewportPx: number,
  { includeToday = true }: { includeToday?: boolean } = {},
): Scale {
  const now = dayNumber(today);
  const dated = extent ?? { start: now, end: now };
  const first = includeToday ? Math.min(dated.start, now) : dated.start;
  const last = includeToday ? Math.max(dated.end, now) : dated.end;
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

/** Whether the axis reaches `day`; a closed group's axis can end before today. */
export const holdsDay = (scale: Scale, day: number) => day >= scale.start && day <= scale.end;

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
