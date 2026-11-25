import type { WorkplanRow } from '../api/sheet-works';
import type { Mark, MarkNotes, MarkUnit, TipRowInput } from './chart-types';
import { workEndOf, workStartOf } from './chart-facts';
import { stateText } from './chart-words';
import { dayOf } from './phase-bounds';
import {
  ROW_Y,
  arrowMark,
  barMarks,
  conflictMark,
  decidedMark,
  decisionTone,
  eventMark,
  isAfterCertificate,
  isProponentTime,
  isSuspendedWork,
  laneTop,
  phaseSegs,
  phaseTipFacts,
  plannedMark,
  splitPlan,
  type MarkAxis,
  type MarkScene,
  type PhaseSeg,
} from './overview-marks';

// The bar ends at the decision, so a circle is drawn only when it says more: refused, withdrawn, overdue, or no bar.
function decisionMarks(scene: MarkScene, oneDay: boolean): Mark[] {
  const { work, today } = scene;
  const decided = dayOf(work.decisionDate);
  const planned = dayOf(work.decisionEventDate);
  if (decided) return oneDay || ['no', 'term', 'wd'].includes(decisionTone(work.outcome)) ? [decidedMark(scene, decided)] : [];
  return planned && (planned < today || oneDay) ? [plannedMark(scene, planned)] : [];
}

/** A later work's phases as units for placement, plus its markers: one-day work, conflicts, and a decision that says more than the bar end. */
function laterWorkMarks(scene: MarkScene, units: MarkUnit[]): Mark[] {
  const { work, axis, notes, today } = scene;
  const out: Mark[] = [];
  const sheet = work.source === 'sheet';
  const start = workStartOf(work);
  const end = workEndOf(work);
  const { segs, faults } = phaseSegs(work, axis, end);
  const open = segs.some((seg) => seg.open) || !end;
  const drawnEnd = open ? axis.end : end;
  const oneDay = !open && start === drawnEnd;
  const workState = stateText(work);
  const held = isSuspendedWork(work);
  if (oneDay && !work.decisionDate) {
    const rows: TipRowInput[] = [['Work', work.workType], ['Date', start], ['Length', 'one day'], ['State', workState]];
    if (start) out.push(eventMark(scene, 'day', start, { type: 'One-day work', docKind: 'work document', rows }));
    notes.oneDay += 1;
  } else if (!oneDay) {
    const segRows = (seg: PhaseSeg, plan: boolean): TipRowInput[] => {
      const facts = phaseTipFacts(work, seg, sheet, today);
      return [
        ['Work', segs.length > 1 ? [work.workType, seg.phase.name].filter(Boolean).join(', ') : work.workType],
        ['Dates', `${facts.start} to ${facts.end}`],
        ['Length', facts.length],
        ['State', plan ? `planned from ${today}` : workState],
      ];
    };
    const lastOpen = segs.filter((seg) => seg.open).at(-1);
    const draw = (seg: PhaseSeg, top: number) => {
      const pt = isProponentTime(seg.phase);
      const after = isAfterCertificate(work, seg.phase);
      const bars = barMarks(scene, seg, splitPlan(seg, sheet, today), top, false, (piece) => ({
        flags: { plan: piece.plan, pt, sus: held && seg.open && !piece.plan, after },
        rows: segRows(seg, piece.plan),
      }));
      // Suspended work gets no arrow: the dots already say it is on hold.
      return seg === lastOpen && !held ? [...bars, arrowMark(scene, seg.e, top, segRows(seg, false))] : bars;
    };
    for (const seg of segs) units.push({ pri: 1, s: seg.s, x0: axis.px(seg.s), x1: axis.px(seg.e), draw: (top) => draw(seg, top) });
    if (open && !lastOpen && !held) {
      const rows: TipRowInput[] = [['Work', work.workType], ['Dates', `${start ?? 'No recorded date'} to No recorded date`], ['State', workState]];
      const x = axis.px(drawnEnd);
      units.push({ pri: 1, s: start ?? '', x0: x, x1: x, draw: (top) => [arrowMark(scene, drawnEnd, top, rows)] });
    }
  }
  for (const fault of faults) {
    out.push(conflictMark(scene, fault.s, 'Ends before it starts', [['Phase', fault.phase.name], ['Dates', `${fault.s} to ${fault.e}`]]));
  }
  out.push(...decisionMarks(scene, oneDay));
  return out;
}

/**
 * Bars in lanes: each unit takes the first lane, from the main track down, where its drawn size (at least 4px) overlaps
 * nothing already placed; bars touching within 0.5px share a lane.
 */
function placeUnits(units: MarkUnit[], notes: MarkNotes): Mark[] {
  const kpx = notes.kpx ?? 1;
  const tol = 0.5 / kpx;
  const drawn = (a: number, b: number): [number, number] => {
    const min = 4 / kpx;
    return b - a >= min ? [a, b] : [a - (min - (b - a)) / 2, a - (min - (b - a)) / 2 + min];
  };
  const lanes: [number, number][][] = [];
  const out: Mark[] = [];
  const order = (a: MarkUnit, b: MarkUnit) => a.pri - b.pri || (a.s < b.s ? -1 : a.s > b.s ? 1 : 0);
  for (const unit of [...units].sort(order)) {
    const [p, q] = drawn(unit.x0, unit.x1);
    let lane = lanes.findIndex((spans) => spans.every(([a, b]) => q <= a + tol || p >= b - tol));
    if (lane < 0) lane = lanes.push([]) - 1;
    lanes[lane].push([p, q]);
    out.push(...unit.draw(laneTop(lane)));
  }
  notes.h = laneTop(Math.max(0, lanes.length - 1)) + ROW_Y.barH + ROW_Y.foot;
  return out;
}

/** Marks of a row's works other than the assessment, then every bar of the row (the assessment's first) placed in lanes. */
export function laterMarks(works: readonly WorkplanRow[], axis: MarkAxis, notes: MarkNotes, today: string): Mark[] {
  const units = notes.units ?? [];
  notes.units = [];
  const markers = [...works]
    .sort((a, b) => ((workStartOf(a) ?? '') < (workStartOf(b) ?? '') ? -1 : 1))
    .flatMap((work) => laterWorkMarks({ work, axis, notes, today }, units));
  return [...markers, ...placeUnits(units, notes)];
}
