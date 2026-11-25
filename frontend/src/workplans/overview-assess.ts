import type { WorkplanRow } from '../api/sheet-works';
import type { Mark, MarkNotes, TipRowInput } from './chart-types';
import { colourOf } from './chart-colours';
import { phaseDays, workEndOf } from './chart-facts';
import { lengthText, plainWords } from './chart-words';
import { plural } from './format';
import {
  ROW_Y,
  arrowMark,
  barMarks,
  conflictMark,
  decidedMark,
  eventMark,
  isProponentTime,
  isSuspendedWork,
  mark,
  phaseSegs,
  phaseTipFacts,
  plannedMark,
  splitPlan,
  type BarPiece,
  type MarkAxis,
  type MarkScene,
  type PhaseSeg,
  type PhaseSegs,
} from './overview-marks';
import { dayOf } from './phase-bounds';

/** The 1996 and 2002 phases a sheet assessment always has; one with no dates gets a missing-date marker. */
const SHEET_PHASES = ['Pre-EA', 'Pre-Application', 'Evaluation', 'Application Review', 'Referral'];

/** A stretch of a phase drawn as a bar variant: past its time limit, or with its time limit on hold. */
interface Cut {
  s: string;
  e: string;
  tag: 'over' | 'sus';
  rows: readonly TipRowInput[];
}

/** Splits the done pieces at every cut's ends and tags each part with the cuts covering it. */
function cutPieces(pieces: BarPiece[], cuts: readonly Cut[]): BarPiece[] {
  if (!cuts.length) return pieces;
  return pieces.flatMap((piece) => {
    if (piece.plan) return [piece];
    const days = [...new Set([piece.s, piece.e, ...cuts.flatMap((cut) => [cut.s, cut.e])])].filter((d) => d >= piece.s && d <= piece.e).sort();
    if (days.length < 2) return [piece];
    return days.slice(1).map((e, k) => {
      const part: BarPiece = { s: days[k], e, plan: false };
      for (const cut of cuts) if (cut.s <= part.s && cut.e >= e) part[cut.tag] = cut.rows;
      return part;
    });
  });
}

/** The phase's stretch past its time limit, when a legislated limit was passed before the phase ended. */
function overCut(scene: MarkScene, seg: PhaseSeg): Cut | null {
  const days = phaseDays(seg.phase, scene.work, scene.today);
  const limitDay = days?.legal && days.over > 0 && days.limitDate && days.limitDate < days.end ? days.limitDate : null;
  if (!days || !limitDay) return null;
  const rows: TipRowInput[] = [
    ['Phase', seg.phase.name],
    ['Over limit', `by ${plural(days.over, 'day')}`],
    ['Days counted', `${days.counted}, time limit ${days.limit}`],
    ['Limit reached', limitDay],
  ];
  return { s: limitDay, e: days.end, tag: 'over', rows };
}

/** Suspensions become cuts; extensions and changes that run past the phase end become markers. */
function interruptionMarks(scene: MarkScene, seg: PhaseSeg, cuts: Cut[], out: Mark[]) {
  const name = seg.phase.name;
  for (const stop of seg.phase.interruptions) {
    const s = dayOf(stop.startDate);
    const e = dayOf(stop.endDate);
    const length = stop.days != null ? plural(stop.days, 'day') : s && e ? lengthText(s, e) : '';
    const section = stop.legalSection ? plainWords(stop.legalSection) : '';
    if (stop.kind === 'suspension') {
      const rows: TipRowInput[] = [['On hold', `Time limit${section ? `, ${section}` : ''}`], ['Phase', name], ['Dates', `${s} to ${e}`], ['Length', length]];
      if (s && e && s < e) cuts.push({ s, e: e > seg.e ? seg.e : e, tag: 'sus', rows });
    } else if (s) {
      const rows: TipRowInput[] = [['Phase', name], ['Period', s + (e ? ` to ${e}` : '')], ['Length', length], ['Section', section]];
      out.push(eventMark(scene, 'tl', s, { type: 'Time limit extension', docKind: 'extension order', rows, span: { start: s } }));
    }
    if (e && e > seg.e) {
      const rows: TipRowInput[] = [['Dates', `${s ?? 'No recorded date'} to ${e}`], ['Phase end', seg.e], ['Phase', name]];
      out.push(conflictMark(scene, seg.e, 'A time limit change runs past its phase end', rows));
    }
    scene.notes.intr += 1;
  }
}

/** One assessment phase at a lane top: lead-in, pieces with over-limit and suspended parts, extension and conflict markers. */
function assessPhaseMarks(scene: MarkScene, seg: PhaseSeg, top: number): Mark[] {
  const { work, axis, notes, today } = scene;
  const out: Mark[] = [];
  const sheet = work.source === 'sheet';
  const name = seg.phase.name;
  const facts = phaseTipFacts(work, seg, sheet, today);
  const phaseRows = (plan: boolean): TipRowInput[] => [
    ['Phase', name],
    ['Dates', `${facts.start} to ${facts.end}`],
    ['Length', facts.length],
    plan ? ['State', `planned from ${today}`] : (facts.limit ?? ['State', facts.state]),
  ];
  if (seg.lead) {
    const place = { x0: 0, x1: axis.px(seg.s), top, h: ROW_Y.barH, extra: { '--pc': colourOf(name, work.workTypeCode) } };
    out.push(mark(scene, 'lead jr', place, { type: 'No recorded start date', docKind: 'phase document', rows: phaseRows(false) }));
    notes.undated += 1;
  }
  const over = overCut(scene, seg);
  const cuts: Cut[] = over ? [over] : [];
  interruptionMarks(scene, seg, cuts, out);
  const current = !sheet && Boolean(seg.phase.isCurrent) && !seg.phase.isCompleted;
  const held = isSuspendedWork(work) && seg.open;
  const pt = isProponentTime(seg.phase);
  const pieces = cutPieces(splitPlan(seg, sheet, today), cuts);
  out.push(
    ...barMarks(scene, seg, pieces, top, seg.lead, (piece) => ({
      flags: { plan: piece.plan, cur: current, pt, over: Boolean(piece.over), sus: Boolean(piece.sus) || (held && !piece.plan) },
      rows: piece.over ?? piece.sus ?? phaseRows(piece.plan),
    })),
  );
  // Suspended work gets no arrow: the dots already say it is on hold.
  if (seg.open && !isSuspendedWork(work)) out.push(arrowMark(scene, seg.e, top, phaseRows(false)));
  return out;
}

/** Days that get a missing-date marker, each with the phases that have no recorded date. */
function noDateDays(scene: MarkScene, found: PhaseSegs, firstStart: string | null, workEnd: string | null) {
  const { work, axis, notes } = scene;
  const days = new Map<string, string[]>();
  const add = (day: string | null | undefined, name: string | null) => {
    const at = day || firstStart || axis.start;
    days.set(at, [...(days.get(at) ?? []), name ?? '']);
    notes.undated += 1;
  };
  if (work.source !== 'sheet') {
    found.undated.forEach((phase) => add(firstStart, phase.name));
    return days;
  }
  // A missing sheet phase sits at the next dated one's start, or at the work's end when none follows.
  const dated = (name: string) => found.segs.find((seg) => seg.phase.name === name);
  const lastDated = SHEET_PHASES.reduce((last, name, i) => (dated(name) ? i : last), -1);
  SHEET_PHASES.forEach((name, i) => {
    if (dated(name)) return;
    add(i > lastDated ? workEnd : SHEET_PHASES.slice(i + 1).map(dated).find(Boolean)?.s, name);
  });
  for (const phase of found.undated.filter((p) => !SHEET_PHASES.includes(p.name ?? ''))) {
    const before = found.segs.filter((seg) => (seg.phase.order ?? 0) < (phase.order ?? 0));
    add(before.map((seg) => seg.e).sort().at(-1) || workEnd, phase.name);
  }
  return days;
}

/** An assessment under another Act, clipped to this axis: `s`/`e` drawn, `s0`/`e0` its own dates. */
export interface ContextSpan {
  w: WorkplanRow;
  s: string;
  e: string;
  s0: string;
  e0: string;
}

const actName = (year: number | null | undefined) => `${year ?? ''} Act`;

interface ActMove {
  day: string;
  planned: boolean;
  acts: string;
}

/** The move as the same assessment's record under the other Act has it. */
function moveFromContext(work: WorkplanRow, ctx: readonly ContextSpan[]): ActMove | null {
  for (const { w: other } of ctx) {
    const into = other.transitionOut?.toActYear === work.actYear ? dayOf(other.transitionOut?.date) : null;
    if (into) return { day: into, planned: false, acts: `${actName(other.actYear)} to ${actName(work.actYear)}` };
    const from = other.transitionIn?.fromActYear === work.actYear ? dayOf(other.transitionIn?.date) : null;
    if (from) return { day: from, planned: false, acts: `${actName(work.actYear)} to ${actName(other.actYear)}` };
  }
  return null;
}

/** The day this assessment moved Act: its own record first, else the same assessment's record under the other Act. */
function actMove(work: WorkplanRow, ctx: readonly ContextSpan[]): ActMove | null {
  let acts = '';
  if (work.transitionIn) acts = `${actName(work.transitionIn.fromActYear)} to ${actName(work.actYear)}`;
  else if (work.transitionOut) acts = `${actName(work.actYear)} to ${actName(work.transitionOut.toActYear)}`;
  const milestone = (work.milestones ?? []).find((m) => m.kind === 'act-transition' && (m.actualDate || m.anticipatedDate));
  const own = dayOf(milestone?.actualDate) ?? dayOf(milestone?.anticipatedDate);
  if (own) return { day: own, planned: !milestone?.actualDate, acts };
  const day = dayOf(work.transitionIn?.date) ?? dayOf(work.transitionOut?.date);
  if (day) return { day, planned: false, acts };
  return moveFromContext(work, ctx);
}

function eventMarks(scene: MarkScene, ctx: readonly ContextSpan[]): Mark[] {
  const { work, notes } = scene;
  const out: Mark[] = [];
  const extensionDays = new Set<string>();
  for (const milestone of work.milestones ?? []) {
    const day = dayOf(milestone.actualDate) ?? dayOf(milestone.anticipatedDate);
    if (milestone.kind !== 'extension' || !day || extensionDays.has(day)) continue;
    extensionDays.add(day);
    const planned = !milestone.actualDate;
    const rows: TipRowInput[] = [
      ['Name', milestone.name],
      ['Date', day + (planned ? ', planned' : '')],
      ['Length', milestone.numberOfDays ? plural(milestone.numberOfDays, 'day') : ''],
    ];
    const type = planned ? 'Planned time limit extension' : 'Time limit extension';
    out.push(eventMark(scene, `tl${planned ? ' plan' : ''}`, day, { type, docKind: 'extension order', rows, span: { start: day } }));
    notes.intr += 1;
  }
  const move = actMove(work, ctx);
  if (move) {
    const type = move.planned ? 'Planned move to another Act' : 'Moved to another Act';
    const rows: TipRowInput[] = [['Date', move.day + (move.planned ? ', planned' : '')], ['Acts', move.acts]];
    out.push(eventMark(scene, `mv${move.planned ? ' plan' : ''}`, move.day, { type, docKind: 'transition document', rows }));
    notes.moved = true;
  }
  return out;
}

/**
 * The assessment's markers; its phases go into `notes.units` for `laterMarks`, which places every bar of the row.
 * `ctx` is the project's assessments under other Acts, read only for the day the assessment moved Act.
 */
export function assessMarks(work: WorkplanRow, axis: MarkAxis, ctx: readonly ContextSpan[], notes: MarkNotes, today: string): Mark[] {
  const scene: MarkScene = { work, axis, notes, today };
  const workEnd = workEndOf(work);
  const found = phaseSegs(work, axis, workEnd);
  const firstStart = found.segs.map((seg) => seg.s).sort()[0] ?? dayOf(work.startDate);
  const units = (notes.units ??= []);
  const order = (a: PhaseSeg, b: PhaseSeg) => (a.s < b.s ? -1 : a.s > b.s ? 1 : (a.phase.order ?? 0) - (b.phase.order ?? 0));
  for (const seg of [...found.segs].sort(order)) {
    units.push({ pri: 0, s: seg.lead ? '' : seg.s, x0: seg.lead ? 0 : axis.px(seg.s), x1: axis.px(seg.e), draw: (top) => assessPhaseMarks(scene, seg, top) });
  }
  const out = found.faults.map((fault) =>
    conflictMark(scene, fault.s, 'Ends before it starts', [['Phase', fault.phase.name], ['Dates', `${fault.s} to ${fault.e}`]]));
  for (const [day, names] of noDateDays(scene, found, firstStart, workEnd)) {
    const one = names.length === 1;
    const rows: TipRowInput[] = [[one ? 'Phase' : 'Phases', names.join(', ')], ['Dates', 'No recorded date']];
    out.push(eventMark(scene, 'note', day, { type: 'Missing date', docKind: 'source record', rows }));
  }
  out.push(...eventMarks(scene, ctx));
  const decided = dayOf(work.decisionDate);
  const planned = dayOf(work.decisionEventDate);
  if (decided) out.push(decidedMark(scene, decided));
  else if (planned) out.push(plannedMark(scene, planned));
  const workStart = dayOf(work.startDate);
  if (workStart && firstStart && firstStart < workStart) {
    out.push(conflictMark(scene, workStart, 'Work start recorded after its first phase', [['Date', workStart], ['First phase', firstStart]]));
  }
  return out;
}
