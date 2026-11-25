import type { WorkplanMilestone, WorkplanPhase, WorkplanRow } from '../api/sheet-works';
import type { KindId } from './chart-kinds';
import { type MarkStyle, type Tip, type TipRowInput, tipOf } from './chart-types';

export type { KindId };

/** The page's time axis, from the axis slice. Days are UTC day numbers (`dayNumber`). */
export interface RecordScale {
  /** First and last day of the axis. */
  start: number;
  end: number;
  /** Percent across the chart of a day; outside 0 to 100 when the day is off the chart. */
  pct: (day: number) => number;
  /** Pixels of a percent of the chart width at the chosen time scale. */
  px: (pct: number) => number;
}

export type NoteTone = 'warn' | 'info' | 'pass';

/** One line of "Notes on this record"; `warn` and `pass` list before `info`. */
export interface RecordNote {
  text: string;
  tone: NoteTone;
}

/** A line across the chart: decision or certificate (`vline dec`), move (`vline move`) or today (`vline`). */
export interface VLine {
  cls: string;
  /** Percent across the chart. */
  left: number;
}

/** What the builders share while one record is built: the axis, today, and the collectors they add to. */
export interface RecordCtx {
  scale: RecordScale;
  /** ISO day. */
  today: string;
  /** Mark kinds drawn on this record; the legend lists only these. */
  used: Set<KindId>;
  notes: RecordNote[];
  vlines: VLine[];
  axisMarks: AxisMark[];
}

/** A bar's true extent in percent, before the minimum drawn width; lanes are worked out from it. */
export interface BarGeo {
  l: number;
  r: number;
  minW: number;
}

/** One drawn mark on a Record row or the axis row. */
export interface RecordMark {
  /** Classes, starting `mk`. */
  cls: string;
  style: MarkStyle;
  tip: Tip;
  /** Id an event-list entry or limit row highlights; '' for none. */
  id: string;
  /** Left edge in percent, for sorting and for the "Back to the list" button. */
  left: number;
  /** Where the "Back to the list" button sits, in percent; null puts it at `left`. */
  backAt: number | null;
  /** Name printed inside a bar, only when it fits at this time scale. */
  label: string;
  geo?: BarGeo;
  lane?: number;
}

/** A mark on the axis row with its own label; `at` is pixels from the chart's left edge. */
export interface AxisMark extends RecordMark {
  at: number;
}

export type TagTone = 'grey' | 'blue' | 'green' | 'red' | 'yellow';

export interface Tag {
  text: string;
  tone: TagTone;
}

/** A button in an empty row that opens another Act's part of the same project. */
export interface RowJump {
  text: string;
  projectId: string;
  act: number;
}

/** The disclosure on a later work that shows its phases. */
export interface RowExpand {
  workId: string;
  open: boolean;
  text: string;
}

/** The "N changes" link from a row label to its part of the Time limit changes block. */
export interface RowChange {
  text: string;
  /** Accessible name. */
  label: string;
  href: string;
  headId: string;
}

export interface RecordRow {
  type: 'row';
  /** `empty`, `sub`, `hlrow`, or ''. */
  cls: string;
  rowStyle: MarkStyle;
  name: string;
  /** Style of the swatch beside the name. */
  sw: MarkStyle;
  /** Mark classes the swatch draws with, as on the chart; '' for a plain colour swatch. */
  glyph: string;
  marks: RecordMark[];
  line2: string;
  limText: string;
  /** Red tail of `limText`, such as ", over by 12 days". */
  flag: string;
  warn: string;
  pass: string;
  tag: Tag | null;
  /** Tags beside the state tag of a later work. */
  tags2: Tag[];
  isEmpty: boolean;
  emptyText: string;
  jump: RowJump | null;
  expand: RowExpand | null;
  chg: RowChange | null;
}

export interface HeadRow {
  type: 'head';
  name: string;
  line2: string;
  /** `first` on the top head. */
  cls: string;
}

/** A line of text between rows, such as the note above a work's phases. */
export interface NoteRow {
  type: 'note';
  name: string;
}

export type ChartRow = RecordRow | HeadRow | NoteRow;

/** Where a phase stands against its time limit or planned length, and its label lines. */
export interface PhaseInfo {
  /** Start and end day numbers. */
  s: number | null;
  e: number | null;
  line2: string;
  limText: string;
  flag: string;
  warn: string;
  pass: string;
  tag: Tag | null;
  /** Calendar days from start to end; null without both dates or when they conflict. */
  len: number | null;
  /** Days run so far, to today while the phase runs; null when not counted. */
  run: number | null;
  /** Counted days past a legislated limit; 0 otherwise. */
  over: number;
  /** The overrun as the last `over` days of the phase. */
  olim: { a: number; b: number; counted: number; lim: number } | null;
}

/** One row of a phase's table in the Time limit changes block. */
export interface LimitRow {
  sort: number;
  e: number | null;
  /** Glyph classes for the Change cell. */
  g: string;
  cls: string;
  kind: string;
  section: string;
  from: string;
  to: string;
  n: number;
  /** Id of its mark on the chart. */
  mid: string;
  /** "Dates conflict: runs N days past the phase end", or ''. */
  pastTxt: string;
  /** "not counted in the time limit", or ''. */
  note: string;
  isExt: boolean;
  /** False for an extension left over after the phase's total was met. */
  counted: boolean;
}

/** A phase that collects time limit changes: a step row, or one phase of a later work. */
export interface LimitPart {
  id: string;
  name: string;
  ph: WorkplanPhase | null;
  o: PhaseInfo | null;
  lrows: LimitRow[];
  /** Counted extension and suspension days from the rows. */
  sumE: number;
  sumS: number;
  /** The phase's `extensionDays` when no set of events adds up to it; 0 otherwise. */
  noDates: number;
  marks: RecordMark[];
  limText: string;
}

/** One assessment step: a chart row that is also a limit part; `s` and `e` are its start and end days. */
export interface StepRow extends RecordRow, LimitPart {
  s: number | null;
  e: number | null;
}

/** A Track extension event and the phase it is placed under. */
export interface ExtEvent {
  m: WorkplanMilestone;
  d: number | null;
  n: number;
  ph: WorkplanPhase | null;
  /** True when it is one of the events that add up to its phase's `extensionDays`. */
  counted: boolean;
}

export interface ExtPlan {
  evs: ExtEvent[];
  /** Per phase in `phs`: the `extensionDays` no set of events added up to, else 0. */
  noDates: number[];
  /** The work's phases in order. */
  phs: WorkplanPhase[];
}

export interface LimitBarPart {
  /** `sc` counted, `ss` suspended, `se` extended, `sl` the limit line. */
  cls: 'sc' | 'ss' | 'se' | 'sl';
  style: MarkStyle;
}

export interface LimitSum {
  k: string;
  v: string;
  /** `warn` on the over-the-limit line. */
  cls: string;
  /** Key glyph class: `sl`, `sc`, `se`, `ss` or `none`. */
  kg: string;
  kgStyle: MarkStyle;
}

export interface LimitTotal {
  k: string;
  v: string;
  n: number;
  isExt: boolean;
  barCls: 'ext' | 'sus';
  barStyle: MarkStyle;
}

export interface LimitTableRow {
  g: string;
  kind: string;
  warn: string;
  note: string;
  section: string;
  from: string;
  to: string;
  days: string;
  counted: 'true' | 'false';
  barCls: 'ext' | 'sus';
  barStyle: MarkStyle;
  mid: string;
}

/** One phase's part of the Time limit changes block; `extDays` and `total` feed `data-ext` and `data-total`. */
export interface LimitPartView {
  /** Heading id, the "N changes" link target. */
  id: string;
  partId: string;
  name: string;
  sw: MarkStyle;
  bar: LimitBarPart[];
  sum: LimitSum[];
  totals: LimitTotal[];
  work: string;
  phase: string;
  extDays: string;
  total: string;
  /** "N days extended, dates not recorded", or ''. */
  noDatesText: string;
  rows: LimitTableRow[];
}

/** An issued certificate; later works attach to the latest one on or before their start. */
export interface CertFact {
  work: WorkplanRow;
  day: number;
  act: number;
  kind: string;
}

/** Event list category: decision, comment period, milestone, other, or after-the-certificate work. */
export type EventCat = 'dec' | 'cp' | 'ms' | 'oth' | 'aw';

/** One entry of the Events block before it is grouped; identical entries merge into one with a count. */
export interface EventItem {
  d: number | null;
  e: number | null;
  c: EventCat;
  name: string;
  date: string;
  count: number;
  id: string;
  g: string;
  hasMark: boolean;
  /** The step row it falls in; null for comment periods, later works and events outside the phases. */
  step: StepRow | null;
  len: string;
  /** Days since the entry before in its run, set when the groups are built. */
  gapN?: number | null;
}

export const extOf = (ph: WorkplanPhase) => ph.extensionDays || 0;
export const susOf = (ph: WorkplanPhase) => ph.suspendedDays || 0;

export const f3 = (x: number) => x.toFixed(3);

// A span narrower than min px is drawn min px wide, centred on its true dates.
export const spanStyle = (l: number, w: number, min: number): MarkStyle => ({
  left: `${f3(l)}%`,
  width: `max(${min}px, ${f3(w)}%)`,
  marginLeft: `min(0px, calc((${f3(w)}% - ${min}px) / 2))`,
});

/** A mark with its tooltip: the title and up to four rows that have a value. */
export function markOf(
  cls: string,
  style: MarkStyle,
  title: string,
  rows: readonly TipRowInput[],
  id = '',
  backAt: number | null = null,
): RecordMark {
  const left = /^(-?[\d.]+)%$/.exec(String(style.left ?? ''));
  return { cls: `mk ${cls}`, style, tip: tipOf(title, rows), id, left: left ? Number(left[1]) : 0, backAt, label: '' };
}

export const addNote = (ctx: RecordCtx, tone: NoteTone, text: string) => {
  ctx.notes.push({ text, tone });
};
