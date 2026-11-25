import type { WorkplanPhase, WorkplanRow } from '../api/sheet-works';
import { tipOf, type DocKind, type Mark, type MarkNotes, type MarkStyle, type TipRowInput } from './chart-types';
import { colourKeyOf, colourOf } from './chart-colours';
import { humanState, lengthText, outcomeText } from './chart-words';
import { plural } from './format';
import { docHref, eagleAdminBase } from './overview-links';
import { dayOf } from './phase-bounds';

/** What the marks need from one Act's axis: `px` places a day in 0..`units`, clamped to the axis. */
export interface MarkAxis {
  start: string;
  end: string;
  units: number;
  px: (day: string) => number;
}

/** One row's work being drawn, with the axis, today and the notes its marks add to. */
export interface MarkScene {
  work: WorkplanRow;
  axis: MarkAxis;
  notes: MarkNotes;
  today: string;
}

/** Where a mark sits: x in axis units; `min` width, `off` left shift, `top` and `h` in px from the row top. */
export interface MarkPlace {
  x0: number;
  x1?: number;
  min?: number;
  off?: number;
  top?: number;
  h?: number;
  extra?: MarkStyle;
}

/** Row geometry, px from the track top: markers at `evTop`, the main track at `bar`, lanes `barH` high with `gap` between. */
export const ROW_Y = { evTop: 4, bar: 24, barH: 20, gap: 8, foot: 6 } as const;

export const laneTop = (lane: number) => ROW_Y.bar + lane * (ROW_Y.barH + ROW_Y.gap);

const percent = (x: number, units: number) => `${((x / units) * 100).toFixed(3)}%`;

export function markStyle(place: MarkPlace, units: number): MarkStyle {
  const left = percent(place.x0, units);
  const width = place.x1 === undefined ? null : percent(Math.max(0, place.x1 - place.x0), units);
  const min = place.min ?? 0;
  const style: MarkStyle = { left };
  if (place.off) style.left = `calc(${left} - ${place.off}px)`;
  // A mark widened to its minimum grows around its centre, so it stays on its dates.
  else if (width !== null && min) style.left = `calc(${left} - max(0px, (${min}px - ${width}) / 2))`;
  if (width !== null) style.width = `max(${min}px, ${width})`;
  if (place.top !== undefined) style.top = place.top;
  if (place.h !== undefined) style.height = place.h;
  return { ...style, ...place.extra };
}

/** What a mark's popup says besides its title: the type line, the detail rows and the kind of record behind it. */
export interface MarkEntry {
  type: string;
  docKind: DocKind;
  rows: readonly TipRowInput[];
  /** The entry's dates its document link searches; no span, no document link. */
  span?: { start: string; end?: string | null };
}

/** The work's title without the project name in front, as the row already names the project. */
export function workTitle(work: WorkplanRow): string {
  const title = work.title ?? '';
  const prefix = work.projectName ? `${work.projectName} - ` : null;
  return (prefix && title.startsWith(prefix) ? title.slice(prefix.length) : title) || work.workType || '';
}

export function mark(scene: MarkScene, cls: string, place: MarkPlace, entry: MarkEntry): Mark {
  return {
    cls,
    style: markStyle(place, scene.axis.units),
    tip: tipOf(workTitle(scene.work), entry.rows),
    type: entry.type,
    docKind: entry.docKind,
    doc: docHref({
      kind: entry.docKind,
      start: entry.span?.start,
      end: entry.span?.end,
      act: scene.work.actYear,
      projectId: scene.work.projectId,
      eagleId: scene.work.eagleId,
      adminBase: eagleAdminBase(),
      today: scene.today,
    }),
    x0: place.x0,
    x1: place.x1 ?? place.x0,
  };
}

/** A single-date marker on the top marker line; decision circles are 12px, other icons 14px. */
export function eventMark(scene: MarkScene, kind: string, day: string, entry: MarkEntry): Mark {
  const off = /^dk\b/.test(kind) ? 6 : 5;
  return mark(scene, `ev ${kind}`, { x0: scene.axis.px(day), off, top: ROW_Y.evTop }, entry);
}

export function conflictMark(scene: MarkScene, day: string, issue: string, rows: readonly TipRowInput[]): Mark {
  scene.notes.faults += 1;
  return eventMark(scene, 'conf', day, { type: 'Dates conflict', docKind: 'source record', rows: [['Issue', issue], ...rows] });
}

/** A phase drawn: `lead` when it has no recorded start (`na` the latest it can be), `open` when it has no recorded end. */
export interface PhaseSeg {
  phase: WorkplanPhase;
  s: string;
  e: string;
  lead: boolean;
  na: string | null;
  open: boolean;
}

/** A phase whose recorded end is before its start. */
export interface DateFault {
  phase: WorkplanPhase;
  s: string;
  e: string;
}

export interface PhaseSegs {
  segs: PhaseSeg[];
  undated: WorkplanPhase[];
  faults: DateFault[];
}

/** Phases in order; an open phase runs to `workEnd` when that is later, else to the axis end. */
export function phaseSegs(work: WorkplanRow, axis: MarkAxis, workEnd: string | null): PhaseSegs {
  const segs: PhaseSeg[] = [];
  const undated: WorkplanPhase[] = [];
  const faults: DateFault[] = [];
  for (const phase of [...work.phases].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    const s = dayOf(phase.startDate);
    const e = dayOf(phase.endDate);
    const na = dayOf(phase.undated?.['startDate']?.notAfter);
    if (s && e && e < s) faults.push({ phase, s, e });
    else if (s) segs.push({ phase, s, e: e ?? (workEnd && workEnd > s ? workEnd : axis.end), lead: false, na, open: !e });
    else if (e) segs.push({ phase, s: na ?? e, e, lead: true, na, open: false });
    else undated.push(phase);
  }
  return { segs, undated, faults };
}

/** A stretch of a phase bar: `plan` after today, `over` past its time limit, `sus` with its time limit on hold. */
export interface BarPiece {
  s: string;
  e: string;
  plan: boolean;
  over?: readonly TipRowInput[];
  sus?: readonly TipRowInput[];
}

/** A running Track phase splits at today into its done part and its planned part; sheet phases never do. */
export function splitPlan(seg: PhaseSeg, sheet: boolean, today: string): BarPiece[] {
  if (sheet || seg.phase.isCompleted || seg.e <= today) return [{ s: seg.s, e: seg.e, plan: false }];
  if (seg.s >= today) return [{ s: seg.s, e: seg.e, plan: true }];
  return [
    { s: seg.s, e: today, plan: false },
    { s: today, e: seg.e, plan: true },
  ];
}

export interface PhaseTipFacts {
  start: string;
  end: string;
  length: string;
  limit: TipRowInput;
  state: string;
}

/** The words a phase popup shows: start and end text, length, time limit or planned length, and state. */
export function phaseTipFacts(work: WorkplanRow, seg: PhaseSeg, sheet: boolean, today: string): PhaseTipFacts {
  const { phase } = seg;
  const planned = (day: string) => !sheet && !phase.isCompleted && day > today;
  const notAfter = seg.na ? `No recorded date, not after ${seg.na}` : 'No recorded date';
  const start = seg.lead ? notAfter : seg.s + (planned(seg.s) ? ', planned' : '');
  const end = seg.open ? 'No recorded date' : seg.e + (planned(seg.e) ? ', planned' : '');
  const length = !seg.lead && !seg.open ? lengthText(seg.s, seg.e) : '';
  const days = phase.numberOfDays;
  const limit: TipRowInput = days ? [phase.legislated ? 'Time limit' : 'Planned', plural(days, 'day')] : null;
  let state = humanState(work.workState);
  if (phase.isCompleted) state = 'completed';
  else if (phase.isCurrent) state = 'in progress';
  else if (planned(seg.s)) state = 'planned';
  return { start, end, length, limit, state };
}

/** Bar variants of one piece; `after` is a later work in the after-certificate colour. */
export interface BarFlags {
  plan: boolean;
  cur?: boolean;
  pt: boolean;
  over?: boolean;
  sus: boolean;
  after?: boolean;
}

/** Variant classes and the popup type line of a bar piece. */
export function barLook(f: BarFlags): { cls: string; type: string } {
  const cls = (f.plan ? ' plan' : f.cur ? ' cur' : '') + (f.pt ? ' pt' : '') + (f.over ? ' over' : '') + (f.sus ? ' sus' : '');
  let type = f.over ? 'Over its time limit' : f.sus ? 'Suspended' : f.pt ? 'Proponent Time' : f.cur ? 'Current phase' : f.after ? 'After certificate' : 'Phase';
  if (f.plan) type = f.pt ? `${type}, planned` : `Planned${f.after ? ', after certificate' : ''}`;
  return { cls, type };
}

export const isProponentTime = (phase: WorkplanPhase) => /Proponent Time/.test(phase.name ?? '');
export const isSuspendedWork = (work: WorkplanRow) => /suspended/i.test(work.workState ?? '');
/** A later work's bar reads "after certificate" only when it is drawn in that colour. */
export const isAfterCertificate = (work: WorkplanRow, phase: WorkplanPhase) => colourKeyOf(phase.name, work.workTypeCode) === 'amd';

/**
 * A phase's pieces as joined bars. A phase too narrow at this time scale to show its parts is one bar in its most telling
 * variant; a single bar is at least 4px, unless a lead-in already gives the phase its width.
 */
export function barMarks(
  scene: MarkScene,
  seg: PhaseSeg,
  pieces: BarPiece[],
  top: number,
  lead: boolean,
  describe: (piece: BarPiece) => { flags: BarFlags; rows: readonly TipRowInput[] },
): Mark[] {
  const { work, axis, notes } = scene;
  const kpx = notes.kpx ?? 1;
  const narrow = pieces.length > 1 && (axis.px(seg.e) - axis.px(seg.s)) * kpx < 4.5;
  const keep = narrow ? (pieces.find((p) => p.over) ?? pieces.find((p) => p.sus) ?? pieces.find((p) => !p.plan) ?? pieces[0]) : null;
  const shown = keep ? [{ ...keep, s: seg.s, e: seg.e }] : pieces;
  const min = shown.length === 1 && !lead ? 4 : 0;
  const colour = colourOf(seg.phase.name, work.workTypeCode);
  const span = seg.lead ? undefined : { start: seg.s, end: seg.open ? null : seg.e };
  return shown.map((piece, i) => {
    const { flags, rows } = describe(piece);
    const look = barLook(flags);
    const join = (i > 0 || lead ? ' jl' : '') + (i < shown.length - 1 ? ' jr' : '');
    if (piece.plan) notes.planned = true;
    const place = { x0: axis.px(piece.s), x1: axis.px(piece.e), min, top, h: ROW_Y.barH, extra: { '--pc': colour } };
    return mark(scene, `ph${look.cls}${join}`, place, { type: look.type, docKind: 'phase document', rows, span });
  });
}

export function arrowMark(scene: MarkScene, day: string, top: number, rows: readonly TipRowInput[]): Mark {
  scene.notes.open += 1;
  const place = { x0: scene.axis.px(day), top: top + ROW_Y.barH / 2 - 6 };
  return mark(scene, 'arrow', place, { type: 'No recorded end date', docKind: 'phase document', rows });
}

/** Look of a decision outcome. The refused test runs first, so "not approved" or a refused amendment stays refused. */
const DECISION = {
  no: { cls: ' no', type: 'Decision, refused' },
  term: { cls: ' no', type: 'Decision, terminated' },
  go: { cls: ' go', type: 'Decision, go' },
  wd: { cls: ' wd', type: 'Decision, withdrawn' },
  other: { cls: '', type: 'Decision' },
} as const;

export type DecisionTone = keyof typeof DECISION;

/** Matches the outcome text until the API sends a coded outcome; no outcome, or one not matched, is `other`. */
export function decisionTone(outcome: string | null | undefined): DecisionTone {
  const text = outcome ?? '';
  if (/refus|reject|denied|not (issued|approved|granted)/i.test(text)) return 'no';
  if (/terminat/i.test(text)) return 'term';
  if (/issued|granted|approved|extends|amends/i.test(text)) return 'go';
  if (/withdr/i.test(text)) return 'wd';
  return 'other';
}

export function decidedMark(scene: MarkScene, day: string): Mark {
  const { work } = scene;
  const look = DECISION[decisionTone(work.outcome)];
  const rows: TipRowInput[] = [['Date', day], ['Outcome', outcomeText(work) ?? 'not recorded']];
  return eventMark(scene, `dk${look.cls}`, day, { type: look.type, docKind: 'decision document', rows, span: { start: day } });
}

/** A planned decision, red once its day has passed with no decision recorded. */
export function plannedMark(scene: MarkScene, day: string): Mark {
  const { work, notes, today } = scene;
  const state = humanState(work.workState);
  if (day < today) {
    notes.passed += 1;
    const rows: TipRowInput[] = [['Date', `${day}, planned`], ['State', `no decision recorded, ${state}`]];
    return eventMark(scene, 'dk warn', day, { type: 'Overdue decision', docKind: 'workplan', rows });
  }
  return eventMark(scene, 'dk plan', day, { type: 'Planned decision', docKind: 'workplan', rows: [['Date', `${day}, planned`], ['State', state]] });
}
