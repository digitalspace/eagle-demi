import type { SheetInterruption, WorkplanPhase, WorkplanRow } from '../api/sheet-works';
import type { MarkStyle, TipRowInput } from './chart-types';
import { colourOf } from './chart-colours';
import { phaseDays, type PhaseDays, countsFromDayOne } from './chart-facts';
import { duration, plainWords } from './chart-words';
import { plural } from './format';
import { dayNo, isOpenEnded, isoOf } from './record-axis';
import { olimMark } from './record-limits';
import { chronological, noteGaps } from './record-order';
import {
  type AxisMark,
  type CertFact,
  type ChartRow,
  type HeadRow,
  type KindId,
  type NoteRow,
  type PhaseInfo,
  type RecordCtx,
  type RecordMark,
  type RecordRow,
  type StepRow,
  addNote,
  extOf,
  f3,
  markOf,
  spanStyle,
  susOf,
} from './record-types';
import { dayNumber } from './phase-bounds';

/** The five steps every 2002 sheet assessment shows, in order, before any other phases it has. */
export const OLD_STEPS = ['Pre-EA', 'Pre-Application', 'Evaluation', 'Application Review', 'Referral'];
// Only works with a Start Extra date have Extra Time, so it gets a row after Evaluation only when present.
const OLD_STEPS_EXTRA = ['Pre-EA', 'Pre-Application', 'Evaluation', 'Extra Time', 'Application Review', 'Referral'];

export const isTrack = (w: WorkplanRow) => w.source === 'track';

/** A mark on the axis row: decision or certificate, move, or today. */
export function axisMarkOf(
  ctx: RecordCtx,
  kind: 'dec' | 'move' | 'today',
  day: number,
  label: string,
  title: string,
  rows: readonly TipRowInput[],
  id = '',
): AxisMark {
  const at = ctx.scale.pct(day);
  return { ...markOf(`tick mark ${kind}`, { left: `${f3(at)}%` }, title, rows, id), at: ctx.scale.px(at), label };
}

export interface SegOptions {
  title: string;
  rows: readonly TipRowInput[];
  /** Name printed inside the bar when it fits. */
  label?: string;
  id?: string;
  /** A phase under the next Act, drawn as a ghost bar. */
  ghost?: boolean;
  /** Whose phase it is, at the start of the "continues past the chart edge" note. */
  who?: string;
  /** A later work's phase, drawn thin as on the Overview. */
  later?: boolean;
}

type BarKind = 'solid' | 'planned' | 'openStart' | 'openEnd' | 'point' | 'reversed';
const BAR_KIND: Record<BarKind, KindId> = {
  solid: 'step',
  planned: 'planned',
  openStart: 'openStart',
  openEnd: 'openEnd',
  point: 'point',
  reversed: 'reversed',
};

/** The kind a bar adds to the legend: the next Act's assessment, a later work's thin bar, or the bar's own kind. */
function barKindOf(o: SegOptions, kind: BarKind): KindId {
  if (o.ghost) return 'nextAct';
  if (o.later && kind === 'solid') return 'later';
  if (o.later && kind === 'planned') return 'laterPlan';
  return BAR_KIND[kind];
}

/** The "continues past the chart edge" text of a bar cut at either edge; '' when it is not cut. */
function contOf(x: number, y: number, l0: number, r0: number): string {
  if (r0 > 100) return `to ${isoOf(Math.max(x, y))}, past the chart edge`;
  if (l0 < 0) return `from ${isoOf(Math.min(x, y))}, before the chart edge`;
  return '';
}

function noteCut(ph: WorkplanPhase, o: SegOptions, ctx: RecordCtx, cont: string) {
  ctx.used.add('cut');
  addNote(ctx, 'info', `${o.who ? `${o.who}, ` : ''}${ph.name ?? ''}: continues ${cont}`);
}

/** The bar's look classes: current, a later work's thin bar, the next Act's ghost, Proponent Time. */
function lookOf(ph: WorkplanPhase, o: SegOptions, cur: boolean): string {
  return (cur ? ' cur' : '') + (o.later ? ' thin' : '') + (o.ghost ? ' ghostbar' : '') + (/Proponent Time/i.test(ph.name ?? '') ? ' pt' : '');
}

function barMark(ph: WorkplanPhase, o: SegOptions, ctx: RecordCtx, colour: string, x: number, y: number, kind: BarKind, cur: boolean) {
  const { pct, px } = ctx.scale;
  const l0 = pct(Math.min(x, y));
  const r0 = pct(Math.max(x, y));
  if (r0 < 0 || l0 > 100) return null;
  const l = Math.max(0, l0);
  const r = Math.min(100, r0);
  const cut = (l0 < 0 ? ' cutL' : '') + (r0 > 100 ? ' cutR' : '');
  const cont = contOf(x, y, l0, r0);
  if (cont) noteCut(ph, o, ctx, cont);
  ctx.used.add(barKindOf(o, kind));
  if (cur) ctx.used.add('cur');
  const rows = o.rows.slice();
  if (cont) rows.splice(Math.min(rows.length, 3), 0, ['Continues', cont]);
  // One-day diamonds and conflict lines sit on one date at their drawn width.
  const one = kind === 'point' || kind === 'reversed';
  const minW = kind === 'point' ? 11 : 4;
  const place = one ? { left: `${f3(l)}%` } : spanStyle(l, Math.max(0, r - l), minW);
  const m = markOf(`bar ${kind}${cut}${lookOf(ph, o, cur)}`, { ...place, '--pc': colour }, o.title, rows, o.id ?? '', o.id ? r : null);
  // The phase name goes inside a bar only when it fits at this zoom.
  const name = o.label ?? '';
  if (name && !one && px(r - l) >= name.length * 7.6 + 24) {
    m.label = name;
    m.cls += ' lbl';
  }
  m.geo = { l, r, minW };
  return m;
}

/** The bars of one phase: recorded, planned, open at one end, one day, or with conflicting dates. */
export function segsFor(ph: WorkplanPhase, w: WorkplanRow, o: SegOptions, ctx: RecordCtx): RecordMark[] {
  const colour = colourOf(ph.name, w.workTypeCode);
  const s = dayNo(ph.startDate);
  const e = dayNo(ph.endDate);
  const today = dayNumber(ctx.today);
  const span = ctx.scale.end - ctx.scale.start;
  const out: RecordMark[] = [];
  // As on the Overview: only the assessment's own current phase gets the current border, and not its planned part.
  const current = isTrack(w) && !!ph.isCurrent && !ph.isCompleted && !o.ghost && !o.later;
  const mk = (x: number, y: number, kind: BarKind) => {
    const m = barMark(ph, o, ctx, colour, x, y, kind, current && (kind === 'solid' || kind === 'openEnd'));
    if (m) out.push(m);
  };
  if (s == null) {
    if (e != null) mk(Math.max(ctx.scale.start, e - span * 0.07), e, 'openStart');
  } else if (e == null) mk(s, isOpenEnded(w) ? today : s + span * 0.04, 'openEnd');
  // A red line at the phase start, as on the Overview.
  else if (e < s) mk(s, s, 'reversed');
  else if (e === s) mk(s, s, 'point');
  else if (isTrack(w) && !ph.isCompleted && !ph.isCurrent) mk(s, e, 'planned');
  else if (isTrack(w) && ph.isCurrent && !ph.isCompleted && e > today && s < today) {
    mk(s, today, 'solid');
    mk(today, e, 'planned');
  } else mk(s, e, 'solid');
  return out;
}

function datesOf(s: number | null, e: number | null, one = 0) {
  if (s != null && e != null) {
    const line2 = `${isoOf(s)} to ${isoOf(e)}`;
    if (e < s) return { line2, len: null, warn: `Dates conflict: ends ${plural(s - e, 'day')} before it starts` };
    if (e === s) return { line2: `${line2}, zero length`, len: null, warn: '' };
    // Counted the Day One way, the start day is day 1.
    return { line2: `${line2}, ${duration(e - s + one)}`, len: e - s + one, warn: '' };
  }
  if (s != null) return { line2: `${isoOf(s)} to no recorded date`, len: null, warn: '' };
  if (e != null) return { line2: `No recorded date to ${isoOf(e)}`, len: null, warn: '' };
  return { line2: '', len: null, warn: '' };
}

// Days against a legal limit: suspended days stop the clock, extended days add to the limit.
function legalLimit(ph: WorkplanPhase, n: number, days: PhaseDays | null) {
  const bits: string[] = [];
  if (days) bits.push(`${plural(Math.max(0, days.counted), 'day')} taken`);
  bits.push(`time limit ${plural(n, 'day')}`);
  if (extOf(ph)) bits.push(`${plural(extOf(ph), 'day')} extended`);
  if (susOf(ph)) bits.push(`${plural(susOf(ph), 'day')} suspended`);
  const text = bits.join(', ');
  const over = days?.over ?? 0;
  const res = { limText: text[0].toUpperCase() + text.slice(1), run: days?.length ?? null, over, flag: '', olim: null as PhaseInfo['olim'], deadline: days?.limitDate ?? null };
  if (days && over > 0) {
    // The overrun is the last N days of the phase (to today while it runs).
    const end = dayNumber(days.end);
    res.flag = `, over by ${plural(over, 'day').replace(' ', ' ')}`;
    res.olim = { a: end - over, b: end, counted: days.counted, lim: days.limit ?? n };
  }
  return res;
}

/** A phase's label lines and where it stands against its time limit or planned length. */
export function phaseInfo(ph: WorkplanPhase, w: WorkplanRow, today: string): PhaseInfo {
  const s = dayNo(ph.startDate);
  const e = dayNo(ph.endDate);
  const planned = isTrack(w) && !ph.isCompleted && !ph.isCurrent;
  const current = isTrack(w) && !!ph.isCurrent && !ph.isCompleted;
  const dayOne = countsFromDayOne(ph, w.phases);
  const dates = datesOf(s, e, dayOne ? 1 : 0);
  const o: PhaseInfo = { s, e, ...dates, limText: '', flag: '', pass: '', tag: null, run: null, over: 0, olim: null, deadline: null, dayOne };
  const n = ph.numberOfDays;
  // A phase still running counts to today.
  if (n && ph.legislated) Object.assign(o, legalLimit(ph, n, phaseDays(ph, w, today)));
  else if (n) o.limText = `Planned ${plural(n, 'day')}`;
  // No phase under the 1996 Act has a time limit in the data, so its labels say so.
  else if (w.actYear === 1996)
    o.limText =
      o.len != null ? `${plural(Math.max(0, o.len - susOf(ph)), 'day')} counted, no time limit recorded` : 'No time limit recorded';
  if (planned) o.tag = { text: 'Planned', tone: 'grey' };
  if (current) o.tag = { text: 'Current', tone: 'blue' };
  if (current && e != null && e < dayNumber(today)) o.pass = 'Planned end date passed';
  return o;
}

/** Bars of one work that overlap on screen go into lanes 16 px apart; returns the row's taller style, or null with one lane. */
export function laneify(marks: RecordMark[], ctx: RecordCtx): MarkStyle | null {
  const { px } = ctx.scale;
  const bars = marks.filter((m) => m.geo).sort((x, y) => (x.geo?.l ?? 0) - (y.geo?.l ?? 0));
  const ends: number[] = [];
  bars.forEach((m) => {
    const geo = m.geo ?? { l: 0, r: 0, minW: 0 };
    const true0 = px(geo.r - geo.l);
    const x0 = px(geo.l);
    const w = Math.max(true0, geo.minW);
    const cx = x0 - (w > true0 ? (w - true0) / 2 : 0);
    let ln = ends.findIndex((end) => end <= cx + 0.5);
    if (ln < 0) {
      ln = ends.length;
      ends.push(0);
    }
    ends[ln] = Math.max(cx + w, x0 + w);
    m.lane = ln;
  });
  if (ends.length < 2) return null;
  bars.forEach((m) => {
    const top = 8 + (m.lane ?? 0) * 16;
    // The diamond keeps its own size, centred in the 14 px lane.
    m.style = / point/.test(m.cls) ? { ...m.style, top: `${top + 1.5}px` } : { ...m.style, top: `${top}px`, height: '14px' };
    m.cls = m.cls.replace(' lbl', '');
    m.label = '';
  });
  return { minHeight: `${Math.max(52, 16 + ends.length * 16 + 8)}px` };
}

export const rowOf = (o: Partial<RecordRow>): RecordRow => ({
  type: 'row',
  cls: '',
  rowStyle: {},
  name: '',
  sw: {},
  glyph: '',
  marks: [],
  line2: '',
  limText: '',
  flag: '',
  warn: '',
  pass: '',
  tag: null,
  tags2: [],
  isEmpty: false,
  emptyText: '',
  jump: null,
  expand: null,
  chg: null,
  ...o,
});

export const headOf = (name: string, line2 = '', cls = ''): HeadRow => ({ type: 'head', name, line2, cls });
export const noteOf = (name: string): NoteRow => ({ type: 'note', name });

const swatchOf = (name: string, w: WorkplanRow): MarkStyle => ({ background: colourOf(name, w.workTypeCode) });

const stepOf = (row: RecordRow, part: Omit<StepRow, keyof RecordRow | 'marks' | 'limText'>): StepRow =>
  Object.assign(row, part);

// Interruptions: up to two lanes under the bar; each one is also a row of the Time limit changes block.
function addInterruptions(r: StepRow, ph: WorkplanPhase, o: PhaseInfo, ctx: RecordCtx) {
  const { pct } = ctx.scale;
  const ints = (ph.interruptions || []).slice().sort((x, y) => (dayNo(x.startDate) ?? 0) - (dayNo(y.startDate) ?? 0));
  const laneEnd: number[] = [];
  ints.forEach((i: SheetInterruption, k) => {
    const s = dayNo(i.startDate);
    const e = dayNo(i.endDate);
    const sus = i.kind === 'suspension';
    const kindTxt = sus ? 'Suspension' : 'Extension';
    const section = i.legalSection ? plainWords(i.legalSection) : 'section not recorded';
    const mid = `${r.id}i${k}`;
    if (sus) r.sumS += i.days || 0;
    else r.sumE += i.days || 0;
    let pastTxt = '';
    if (s != null && e != null) {
      let ln = laneEnd.findIndex((end) => end <= s);
      if (ln < 0) {
        ln = laneEnd.length;
        laneEnd.push(0);
      }
      laneEnd[ln] = e;
      const top = `${39 + 7 * Math.min(ln, 1)}px`;
      ctx.used.add(sus ? 'sus' : 'ext');
      const drawTo = Math.min(e, Math.max(o.e ?? s, s));
      const rows: TipRowInput[] = [['Section', section], ['Dates', `${i.startDate} to ${i.endDate}`], ['Length', plural(i.days ?? 0, 'day')], ['Phase', ph.name]];
      r.marks.push(markOf(`int ${i.kind}`, { top, ...spanStyle(pct(s), Math.max(0, pct(drawTo) - pct(s)), 4) }, kindTxt, rows, mid));
      if (o.e != null && e > o.e) {
        const over = e - o.e;
        ctx.used.add('past');
        const pastRows: TipRowInput[] = [['Dates', `${isoOf(o.e)} to ${i.endDate}`], ['Length', `${plural(over, 'day')} past`], ['Phase', ph.name]];
        r.marks.push(markOf('int past', { top, ...spanStyle(pct(o.e), pct(e) - pct(o.e), 4) }, `${kindTxt} past the phase end`, pastRows, `x${mid}`));
        pastTxt = `Dates conflict: runs ${plural(over, 'day')} past the phase end`;
        addNote(ctx, 'warn', `Dates conflict: ${ph.name}, ${kindTxt.toLowerCase()} ${i.startDate} to ${i.endDate} runs ${plural(over, 'day')} past the end of its phase`);
      }
    }
    r.lrows.push({ sort: s ?? 0, e, g: `g ${sus ? 'sus' : 'ext'}`, cls: `int ${i.kind}`, kind: kindTxt, section, from: i.startDate ?? '', to: i.endDate ?? '', n: i.days || 0, mid, pastTxt, note: '', isExt: !sus, counted: true });
  });
}

function datedStep(name: string, si: number, ph: WorkplanPhase, as: WorkplanRow, ctx: RecordCtx): StepRow {
  const o = phaseInfo(ph, as, ctx.today);
  if (o.warn && o.s != null && o.e != null)
    addNote(ctx, 'warn', `Dates conflict: ${ph.name} ends ${plural(o.s - o.e, 'day')} before it starts (${isoOf(o.s)} to ${isoOf(o.e)})`);
  if (o.pass && o.e != null) addNote(ctx, 'pass', `Planned date passed: ${ph.name} was planned to end ${isoOf(o.e)}`);
  const phStart = dayNo(ph.startDate);
  const asStart = dayNo(as.startDate);
  if (isTrack(as) && phStart != null && asStart != null && phStart < asStart - 7)
    addNote(ctx, 'info', `${ph.name} starts ${isoOf(phStart)}, before the work start ${isoOf(asStart)}`);
  const id = `ph${si}`;
  const tipRows: TipRowInput[] = [
    ['Kind', 'Phase'],
    ['Dates', o.line2],
    [ph.legislated ? 'Time limit' : 'Planned', ph.numberOfDays ? plural(ph.numberOfDays, 'day') : ''],
    ['State', o.warn || o.pass || (o.tag ? o.tag.text : '')],
  ];
  const row = rowOf({ name, sw: swatchOf(name, as), line2: o.line2, limText: o.limText, flag: o.flag, warn: o.warn, pass: o.pass, tag: o.tag });
  const r = stepOf(row, { id, ph, o, lrows: [], sumE: 0, sumS: 0, noDates: 0, s: o.s, e: o.e });
  r.marks = segsFor(ph, as, { title: ph.name ?? '', rows: tipRows, label: ph.name ?? '', id }, ctx);
  if (o.olim) r.marks.push(olimMark(o, ph, ctx));
  addInterruptions(r, ph, o, ctx);
  // Suspended time takes the dots of the Timeline's suspended bar, in this phase's colour.
  const pc = colourOf(ph.name, as.workTypeCode);
  for (const m of r.marks) if (/^int suspension\b/.test(m.cls)) m.style = { ...m.style, '--pc': pc };
  return r;
}

export interface AssessmentOptions {
  projectId: string;
  act: number;
  /** The project's first certificate, for the "No assessment" row. */
  firstCert: CertFact | null;
}

/** The "Assessment" head and one row per step, plus the decision and move lines; `steps` are the rows that are steps. */
export function assessmentRows(as: WorkplanRow | null, ctx: RecordCtx, opt: AssessmentOptions): { rows: ChartRow[]; steps: StepRow[] } {
  const rows: ChartRow[] = [headOf('Assessment', '', 'first')];
  if (!as) {
    const c = opt.firstCert;
    const certText = c ? ` The works below change the certificate issued under the ${c.act} Act on ${isoOf(c.day)}.` : '';
    const jump = c && c.act !== opt.act ? { text: `Open the ${c.act} Act assessment`, projectId: opt.projectId, act: c.act } : null;
    rows.push(rowOf({ cls: 'empty', name: 'No assessment', isEmpty: true, emptyText: `No assessment under the ${opt.act} Act.${certText}`, jump }));
    return { rows, steps: [] };
  }
  const decided = dayNo(as.decisionDate);
  if (decided != null) {
    ctx.used.add('dec');
    ctx.vlines.push({ cls: 'vline dec', left: ctx.scale.pct(decided) });
  }
  const moved = dayNo(as.transitionOut?.date);
  if (moved != null) {
    ctx.used.add('move');
    ctx.vlines.push({ cls: 'vline move', left: ctx.scale.pct(moved) });
    ctx.axisMarks.push(axisMarkOf(ctx, 'move', moved, 'Moved', `Move to the ${as.transitionOut?.toActYear} Act`, [['Date', isoOf(moved)]]));
  }
  const phases = as.phases.slice().sort((x, y) => (x.order || 0) - (y.order || 0));
  const known = phases.some((ph) => ph.name === 'Extra Time') ? OLD_STEPS_EXTRA : OLD_STEPS;
  const listed: { name: string; ph: WorkplanPhase | undefined }[] = isTrack(as)
    ? phases.map((ph) => ({ name: ph.name ?? '', ph }))
    : [
        ...known.map((name) => ({ name, ph: phases.find((ph) => ph.name === name) })),
        ...phases.filter((ph) => !known.includes(ph.name ?? '')).map((ph) => ({ name: ph.name ?? '', ph })),
      ];
  const steps = chronological(listed);
  if (isTrack(as)) noteGaps(steps, ctx);
  const firstWithPhase = steps.findIndex((x) => x.ph);
  const stepRows = steps.map((stp, si): StepRow => {
    const ph = stp.ph;
    if (ph && (ph.startDate || ph.endDate)) return datedStep(stp.name, si, ph, as, ctx);
    const before = !ph && !!as.transitionIn && firstWithPhase > si;
    let emptyText = 'Not in this work';
    if (before) emptyText = 'Before the move to this Act';
    else if (ph) emptyText = 'No recorded date';
    const o = ph ? phaseInfo(ph, as, ctx.today) : null;
    const row = rowOf({ cls: 'empty', name: stp.name, sw: swatchOf(stp.name, as), isEmpty: true, emptyText, limText: o?.limText ?? '' });
    return stepOf(row, { id: `ph${si}`, ph: ph ?? null, o, lrows: [], sumE: 0, sumS: 0, noDates: 0, s: null, e: null });
  });
  rows.push(...stepRows);
  return { rows, steps: stepRows };
}
