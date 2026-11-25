import type { ActYear } from './chart-facts';
import type { Mark, MarkNotes } from './chart-types';
import { AXIS_W } from './overview-axis';
import { ROW_Y } from './overview-marks';
import { EDGE_PX } from './overview-plot';

/** Marker line geometry in px: the top line's centre and the step between lines, which is also how far bars move per extra line. */
const EV = { mid: 9, step: 16 } as const;
/** Jump link size and its gap to the bar beside it, in px. */
const JUMP = { w: 72, pad: 4 } as const;
/** Marks render at a 3-decimal percent of the plot, so a bar's drawn end can sit up to this many units past its x1. */
const ROUND_U = AXIS_W * 1e-5;

/** A link to the same project's row under the Act before or after this one; `left` is a percent of the plot. */
export interface Jump {
  dir: 'prev' | 'next';
  year: ActYear;
  left: number;
  top: number;
}

const isEvent = (m: Mark) => /^ev\b/.test(m.cls);
const isDecision = (m: Mark) => /\bdk\b/.test(m.cls);
const topOf = (m: Mark) => (typeof m.style.top === 'number' ? m.style.top : null);

/**
 * Markers by date onto the first marker line where they keep 0.5px clear of the one before (decision circles 12px wide,
 * icons 14px); bars, lead-ins and arrows move down 16px per extra line. Returns the marks and that shift.
 */
function lineMarkers(marks: readonly Mark[], kpx: number): { marks: Mark[]; shift: number } {
  const lines: { px: number; r: number }[] = [];
  const lineOf = new Map<Mark, number>();
  for (const m of marks.filter((x) => isEvent(x) && x.x0 !== null).sort((a, b) => (a.x0 ?? 0) - (b.x0 ?? 0))) {
    const px = (m.x0 ?? 0) * kpx;
    const r = isDecision(m) ? 6 : 7;
    let line = lines.findIndex((l) => px - l.px >= l.r + r + 0.5);
    if (line < 0) line = lines.push({ px, r }) - 1;
    else lines[line] = { px, r };
    lineOf.set(m, line);
  }
  const shift = (Math.max(1, lines.length) - 1) * EV.step;
  const out = marks.map((m) => {
    const line = lineOf.get(m);
    const top = topOf(m);
    if (line !== undefined) return { ...m, style: { ...m.style, top: EV.mid + line * EV.step - (isDecision(m) ? 6 : 5) } };
    return shift && top !== null ? { ...m, style: { ...m.style, top: top + shift } } : m;
  });
  return { marks: out, shift };
}

/** "‹ earlier Act" just before the first bar on the main track, "later Act ›" just after the last; kept inside the plot's end room. */
function jumpsOf(marks: readonly Mark[], years: readonly ActYear[], year: ActYear, kpx: number, top0: number): Jump[] {
  const i = years.indexOf(year);
  if (years.length < 2 || i < 0) return [];
  const minU = 4 / kpx;
  const main = marks.flatMap((m): [number, number][] => {
    const top = topOf(m);
    if (m.x0 === null || isEvent(m) || top === null) return [];
    const arrow = /^arrow\b/.test(m.cls);
    if ((arrow ? top - (ROW_Y.barH / 2 - 6) : top) !== top0) return [];
    if (arrow) return [[m.x0, m.x0 + 8 / kpx]];
    const a = m.x0;
    const b = m.x1 ?? a;
    return [b - a < minU ? [a - (minU - (b - a)) / 2, a + (b - a + minU) / 2] : [a, b]];
  });
  const first = main.length ? Math.min(...main.map(([a]) => a)) : 0;
  const last = main.length ? Math.max(...main.map(([, b]) => b)) : 0;
  const wU = JUMP.w / kpx;
  // The whole end room: an 8px no-end arrow on the last day, the 4px gap and the link fill it exactly.
  const room = EDGE_PX / kpx;
  const at = (a: number) => (Math.max(-room, Math.min(AXIS_W + room - wU, a)) / AXIS_W) * 100;
  const jumps: Jump[] = [];
  const padU = JUMP.pad / kpx + ROUND_U;
  if (i > 0) jumps.push({ dir: 'prev', year: years[i - 1], left: at(first - padU - wU), top: top0 });
  if (i < years.length - 1) jumps.push({ dir: 'next', year: years[i + 1], left: at(last + padU), top: top0 });
  return jumps;
}

/**
 * The row pass after the marks are built at `notes.kpx`: marker lines, the bar shift they cause, the track height in
 * `notes.h`, and jump links to the project's rows under its other Acts (`years`, oldest first, this row's `year` among them).
 */
export function layoutRow(built: readonly Mark[], notes: MarkNotes, years: readonly ActYear[], year: ActYear): { marks: Mark[]; jumps: Jump[] } {
  const kpx = notes.kpx ?? 1;
  const { marks, shift } = lineMarkers(built, kpx);
  notes.h = (notes.h ?? ROW_Y.bar + ROW_Y.barH + ROW_Y.foot) + shift;
  return { marks, jumps: jumpsOf(marks, years, year, kpx, ROW_Y.bar + shift) };
}
