import type { WorkplanRow } from '../api/sheet-works';
import { ACT_START, ACT_YEARS, type ActYear, workDates } from './chart-facts';

/** Axis width in units; marks and ticks sit at a percent of it. */
export const AXIS_W = 1000;

/** Axis units as a CSS percent number with 3 decimals, e.g. "12.345". */
export const pct = (units: number) => ((units / AXIS_W) * 100).toFixed(3);

/** One Act's time axis: whole years around every date of its works. */
export interface Axis {
  start: string;
  end: string;
  /** First year on the axis. */
  y0: number;
  years: number;
  /** Axis start and end in epoch ms. */
  a0: number;
  a1: number;
  /** Acts that come into force inside the axis, with that day. */
  acts: { year: ActYear; day: string }[];
  todayIn: boolean;
  /** Axis units of a day, clamped to 0 to `AXIS_W`. */
  px: (day: string) => number;
}

/** Null when the Act's works name no date. */
export function axisOf(rows: readonly WorkplanRow[], year: ActYear, today: string): Axis | null {
  const works = rows.filter((work) => work.actYear === year);
  const dates = works.flatMap(workDates).sort();
  const first = dates[0];
  const last = dates.at(-1);
  if (!first || !last) return null;
  // An undated start may fall before every recorded date, so the axis opens a year early.
  const y0 = Number(first.slice(0, 4)) - (works.some((work) => work.undated) ? 1 : 0);
  const y1 = Number(last.slice(0, 4)) + 1;
  const a0 = Date.UTC(y0, 0, 1);
  const a1 = Date.UTC(y1, 0, 1);
  const inside = (day: string) => Date.parse(day) > a0 && Date.parse(day) < a1;
  const now = Date.parse(today);
  return {
    start: `${y0}-01-01`,
    end: `${y1}-01-01`,
    y0,
    years: y1 - y0,
    a0,
    a1,
    acts: ACT_YEARS.flatMap((act) => (inside(ACT_START[act]) ? [{ year: act, day: ACT_START[act] }] : [])),
    todayIn: now >= a0 && now <= a1,
    px: (day) => Math.max(0, Math.min(AXIS_W, ((Date.parse(day) - a0) / (a1 - a0)) * AXIS_W)),
  };
}

/** `x` is a `pct` string. */
export interface AxisLine {
  cls: '' | 'minor' | 'q' | 'actin' | 'today';
  x: string;
}

export interface AxisLabel {
  cls: '' | 'yr' | 'mo' | 'upper' | 'today';
  x: string;
  text: string;
  /** The label in full, on hover, when only a shorter form fits. */
  title?: string;
}

export interface AxisTicks {
  ticks: AxisLine[];
  tlabels: AxisLabel[];
  grid: AxisLine[];
  /** Lines drawn over the rows: today. */
  gridHi: AxisLine[];
}

interface Candidate {
  cls: AxisLabel['cls'];
  x: string;
  /** Pixels from the track start. */
  xp: number;
  /** Lower places first. */
  pri: number;
  /** Longest first; the first that fits is printed. */
  texts: string[];
  bold: boolean;
  title?: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ALL_MONTHS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const QUARTERS = [4, 7, 10];

/** Estimated label width in px at 14 px BC Sans: digits and hyphens are wider than the average letter, so they count apart. */
const labelWidth = (text: string, bold: boolean) => {
  const figures = text.replace(/[^0-9-]/g, '').length;
  return Math.ceil((figures * 8 + (text.length - figures) * 7.2) * (bold ? 1.05 : 1)) + 3;
};

/**
 * Greedy by priority, then position, so no two labels on one line overlap and none crosses a line at `walls` px;
 * a label that fits nowhere is dropped.
 */
function place(cands: Candidate[], trackPx: number, out: AxisLabel[], walls: readonly number[] = []) {
  // A wall ends 1 px left of its line, where a label hung on that line starts, so it blocks only the labels to its left.
  const taken: [number, number][] = walls.map((xp) => [xp - 4, xp - 1]);
  [...cands]
    .sort((p, q) => p.pri - q.pri || p.xp - q.xp)
    .forEach((c) => {
      for (const text of c.texts) {
        const l = c.xp - 1;
        const r = c.xp + labelWidth(text, c.bold) + 8;
        if (r - 8 > trackPx) continue;
        if (taken.some(([a, b]) => l < b && r > a)) continue;
        taken.push([l, r]);
        out.push({ cls: c.cls, x: c.x, text, title: c.title });
        return;
      }
    });
}

/** Ticks, grid lines and labels at `ppy` pixels per year: quarters with their month labels where they fit from 80, every month from 360. */
export function axisTicks(ax: Axis, ppy: number, today: string): AxisTicks {
  const out: AxisTicks = { ticks: [], tlabels: [], grid: [], gridHi: [] };
  const trackPx = ppy * ax.years;
  const months = ppy >= 360;
  const quarters = ppy >= 80;
  const low: Candidate[] = [];
  const up: Candidate[] = [];
  const at = (day: string) => ({ x: pct(ax.px(day)), xp: (ax.px(day) / AXIS_W) * trackPx });
  for (let y = ax.y0; y < ax.y0 + ax.years; y++) {
    const p0 = at(`${y}-01-01`);
    out.ticks.push({ cls: '', x: p0.x });
    out.grid.push({ cls: '', x: p0.x });
    low.push({ ...p0, pri: 0, texts: [String(y)], cls: months ? 'yr' : '', bold: months });
    const sub = months ? ALL_MONTHS : quarters ? QUARTERS : [];
    sub.forEach((mo) => {
      const pm = at(`${y}-${String(mo).padStart(2, '0')}-01`);
      out.ticks.push({ cls: 'minor', x: pm.x });
      const q = mo % 3 === 1;
      const name = MONTHS[mo - 1] ?? '';
      low.push({ ...pm, pri: q ? 1 : 2, texts: months && q ? [`${name} ${y}`, name] : [name], cls: 'mo', bold: false });
      if (ppy >= 200 && (!months || q)) out.grid.push({ cls: 'q', x: pm.x });
    });
  }
  ax.acts.forEach(({ year, day }) => {
    const p = at(day);
    const title = `${year} Act took effect ${day}`;
    out.grid.push({ cls: 'actin', x: p.x });
    out.ticks.push({ cls: 'actin', x: p.x });
    up.push({ ...p, pri: 1, texts: [title, `${year} Act took effect`, `${year} Act`, String(year)], cls: 'upper', bold: true, title });
  });
  if (ax.todayIn) {
    out.gridHi.push({ cls: 'today', x: pct(ax.px(today)) });
    up.push({ ...at(today), pri: 0, texts: [`Today ${today}`, 'Today'], cls: 'today', bold: true });
  }
  place(low, trackPx, out.tlabels);
  // An Act label stops short of the next Act line, so each line keeps its own label.
  place(up, trackPx, out.tlabels, ax.acts.map(({ day }) => at(day).xp));
  return out;
}
