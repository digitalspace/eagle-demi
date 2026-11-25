import type { WorkplanMilestone, WorkplanRow } from '../api/sheet-works';
import type { MarkStyle, TipRowInput } from './chart-types';
import { outcomeText, plainWords } from './chart-words';
import { count, plural } from './format';
import { dayNo, isoOf, milestoneDay, milestoneEnd } from './record-axis';
import { isCert } from './record-header';
import { addExt, placeExtensions } from './record-limits';
import { axisMarkOf, isTrack, phaseInfo, rowOf, segsFor } from './record-steps';
import { type EventCat, type EventItem, type KindId, type RecordCtx, type RecordRow, type StepRow, addNote, f3, markOf, spanStyle } from './record-types';
import { dayNumber } from './phase-bounds';

/** An event list entry with its kind word, which starts the entry's accessible name. */
export interface RecordEvent extends EventItem {
  kind: string;
}

interface Merged {
  key: string;
  m: WorkplanMilestone;
  d: number | null;
  count: number;
  all: WorkplanMilestone[];
}

/** Identical entries on one date merge into one entry with a count; undated ones go last. */
function mergeRepeats(ms: readonly WorkplanMilestone[]): Merged[] {
  const merged: Merged[] = [];
  for (const m of ms) {
    const d = milestoneDay(m);
    const key = [d, m.name, m.outcome ?? '', m.kind, milestoneEnd(m)].join('|');
    const hit = merged.find((x) => x.key === key);
    if (hit) {
      hit.count++;
      hit.all.push(m);
    } else merged.push({ key, m, d, count: 1, all: [m] });
  }
  return merged.sort((x, y) => (x.d ?? 1e9) - (y.d ?? 1e9));
}

/** The dated step a day falls in: inside, then on its end, then inside a step with conflicting dates. */
function stepAt(dated: readonly StepRow[], d: number): StepRow | null {
  const s = (r: StepRow) => r.s ?? 0;
  const e = (r: StepRow) => r.e ?? 0;
  return (
    dated.find((r) => d >= s(r) && d < e(r)) ??
    dated.find((r) => d === e(r)) ??
    dated.find((r) => d >= Math.min(s(r), e(r)) && d <= Math.max(s(r), e(r))) ??
    null
  );
}

function catOf(m: WorkplanMilestone, d: number | null, as: WorkplanRow): EventCat {
  if (m.kind === 'decision') return 'dec';
  if (m.kind === 'comment-period') return 'cp';
  if (m.kind === 'extension' || m.kind === 'section-13') return 'oth';
  if (!isTrack(as)) return 'ms';
  // A Track event within a day of a phase start is that phase's milestone.
  const onStart = as.phases.some((ph) => {
    const s = dayNo(ph.startDate);
    return d != null && s != null && d >= s && d <= s + 1;
  });
  return onStart ? 'ms' : 'oth';
}

function kindWord(c: EventCat, m: WorkplanMilestone, planned: boolean): string {
  if (c === 'dec') return 'Decision';
  if (c === 'cp') return 'Comment period';
  if (c === 'ms') return planned ? 'Planned date' : 'Milestone';
  return m.kind === 'extension' ? 'Time limit extension' : 'Other event';
}

/** The entry's day or range; an anticipated date adds ", planned", and ", date passed" once it is past. */
function dateText(d: number | null, e: number | null, planned: boolean, today: number): string {
  if (d == null) return 'No recorded date';
  const date = isoOf(d) + (e != null && e !== d ? ` to ${isoOf(e)}` : '');
  if (!planned) return date;
  return `${date}, planned${d < today ? ', date passed' : ''}`;
}

const lenText = (d: number | null, e: number | null) => (e != null && d != null && e > d ? plural(e - d, 'day') : '');

interface EventDraw {
  m: WorkplanMilestone;
  d: number;
  e: number | null;
  c: EventCat;
  planned: boolean;
  name: string;
  rows: TipRowInput[];
  id: string;
  r: StepRow | null;
}

/** Draws one dated event on its row or the axis; returns its glyph class and whether it has a mark. */
function drawEvent(x: EventDraw, as: WorkplanRow, ctx: RecordCtx, cpRow: RecordRow, seen: { dec: boolean }) {
  const { pct } = ctx.scale;
  const at: MarkStyle = { left: `${f3(pct(x.d))}%` };
  if (x.c === 'cp') {
    const end = x.e ?? x.d;
    ctx.used.add('cp');
    cpRow.marks.push(markOf('cp', spanStyle(pct(x.d), pct(end) - pct(x.d), 4), x.name, x.rows, x.id, pct(end)));
    return { g: 'g cp', has: true };
  }
  if (x.c === 'dec') {
    // The first decision event on the assessment's decision day is the axis mark itself.
    if (!seen.dec && x.d === dayNo(as.decisionDate)) {
      seen.dec = true;
      const rows: TipRowInput[] = [['Kind', 'Decision'], ['Date', isoOf(x.d)], ['Outcome', outcomeText(as) ?? '']];
      ctx.axisMarks.push(axisMarkOf(ctx, 'dec', x.d, isCert(as) ? 'Certificate' : 'Decision', x.name, rows, x.id));
      return { g: 'g dflag', has: true };
    }
    if (!x.r) return { g: 'g dflag', has: false };
    ctx.used.add('evDec');
    x.r.marks.push(markOf('dflag', at, x.name, x.rows, x.id));
    return { g: 'g dflag', has: true };
  }
  // Track extensions are drawn by `placeExtensions`, under the phase whose total they make up.
  if (x.m.kind === 'extension' && isTrack(as)) return { g: 'g xpt', has: true };
  if (!x.r) return { g: 'g ring', has: false };
  if (x.m.kind === 'extension') {
    addExt(x.r, { m: x.m, d: x.d, n: x.m.numberOfDays || 0, ph: x.r.ph, counted: true }, x.id, ctx);
    return { g: 'g xpt', has: true };
  }
  return dotMark(x, x.r, at, ctx);
}

/** A milestone as a diamond (planned too), a "!" head once its planned date passed, any other event as a ring. */
function dotMark(x: EventDraw, r: StepRow, at: MarkStyle, ctx: RecordCtx) {
  let cls = 'ring';
  let kind: KindId = 'oth';
  if (x.c === 'ms' && !x.planned) [cls, kind] = ['dia', 'ms'];
  else if (x.c === 'ms' && x.d < dayNumber(ctx.today)) [cls, kind] = ['msdue', 'msPassed'];
  else if (x.c === 'ms') [cls, kind] = ['dia planned', 'msPlan'];
  ctx.used.add(kind);
  r.marks.push(markOf(cls, at, x.name, x.rows, x.id));
  return { g: `g ${cls}`, has: true };
}

export interface AssessmentEvents {
  /** The "Public comment periods" row. */
  cpRow: RecordRow;
  items: RecordEvent[];
}

/** The assessment's events: marks on the step rows, the comment periods row, the decision mark, and the list entries. */
export function assessmentEvents(as: WorkplanRow, steps: StepRow[], ctx: RecordCtx): AssessmentEvents {
  const today = dayNumber(ctx.today);
  const dated = steps.filter((r) => r.s != null && r.e != null);
  const cpRow = rowOf({ name: 'Public comment periods', glyph: 'cp' });
  const extId = new Map<WorkplanMilestone, string>();
  const seen = { dec: false };
  let nCp = 0;
  const items = mergeRepeats(as.milestones ?? []).map((x, k): RecordEvent => {
    const { m, d } = x;
    const e = milestoneEnd(m);
    const planned = !m.actualDate && !!m.anticipatedDate;
    const c = catOf(m, d, as);
    const name = plainWords(m.name) + (m.outcome ? `: ${plainWords(m.outcome)}` : '');
    const date = dateText(d, e, planned, today);
    const id = `ev${k}`;
    x.all.forEach((mm, j) => extId.set(mm, j ? `${id}d${j}` : id));
    const r = d != null ? stepAt(dated, d) : null;
    const kind = kindWord(c, m, planned);
    const rows: TipRowInput[] = [['Kind', kind], ['Date', date], ['Phase', r?.name], ['Entries', x.count > 1 ? count(x.count) : '']];
    const drawn = d == null ? { g: 'g ring', has: false } : drawEvent({ m, d, e, c, planned, name, rows, id, r }, as, ctx, cpRow, seen);
    if (c === 'cp' && d != null) nCp++;
    return { d, e, c, kind, name, date, count: x.count, id, g: drawn.g, hasMark: drawn.has, step: c === 'cp' ? null : r, len: lenText(d, e) };
  });
  const decided = dayNo(as.decisionDate);
  if (decided != null && !seen.dec) {
    const rows: TipRowInput[] = [['Date', isoOf(decided)], ['Outcome', outcomeText(as) ?? '']];
    ctx.axisMarks.push(axisMarkOf(ctx, 'dec', decided, isCert(as) ? 'Certificate' : 'Decision', 'Decision', rows));
  }
  if (isTrack(as)) placeExtensions(steps, as, ctx, (m) => extId.get(m));
  if (nCp) cpRow.line2 = plural(nCp, 'period');
  else Object.assign(cpRow, { cls: 'empty', isEmpty: true, emptyText: 'No comment periods recorded' });
  return { cpRow, items };
}

const gapText = (gap: number) => {
  if (gap > 0) return `gap of ${plural(gap, 'day')}`;
  return gap < 0 ? `overlap of ${plural(-gap, 'day')}` : 'same day as the move';
};

/** The next Act's assessment as ghost bars, after a move; its gap or overlap with the move goes in the notes. */
export function nextActRow(as: WorkplanRow, nb: WorkplanRow, ctx: RecordCtx): RecordRow {
  const start = dayNo(nb.startDate);
  const moved = dayNo(as.transitionOut?.date);
  const gap = start != null && moved != null ? start - moved : null;
  const line2 = start == null ? '' : `From ${isoOf(start)}${gap == null ? '' : `, ${gapText(gap)}`}`;
  const r = rowOf({ name: `${nb.actYear} Act assessment`, glyph: 'bar ghostbar', line2 });
  for (const ph of nb.phases) {
    const s = dayNo(ph.startDate);
    if (s == null || s > ctx.scale.end) continue;
    const rows: TipRowInput[] = [['Kind', `Phase under the ${nb.actYear} Act`], ['Dates', phaseInfo(ph, nb, ctx.today).line2]];
    r.marks.push(...segsFor(ph, nb, { title: ph.name ?? '', rows, ghost: true, who: `${nb.actYear} Act assessment`, label: ph.name ?? '' }, ctx));
  }
  moveNotes(nb, gap, moved, ctx);
  return r;
}

function moveNotes(nb: WorkplanRow, gap: number | null, moved: number | null, ctx: RecordCtx) {
  if (gap != null && gap > 0) addNote(ctx, 'info', `Gap of ${plural(gap, 'day')} by start dates before the ${nb.actYear} Act assessment`);
  if (gap != null && gap < 0) addNote(ctx, 'info', `Overlap of ${plural(-gap, 'day')} with the ${nb.actYear} Act assessment`);
  const first = nb.phases
    .flatMap((ph) => {
      const s = dayNo(ph.startDate);
      return s == null ? [] : [{ ph, s }];
    })
    .sort((x, y) => x.s - y.s)[0];
  if (first && moved != null && first.s < moved)
    addNote(ctx, 'info', `${nb.actYear} Act work: ${first.ph.name} starts ${isoOf(first.s)}, before this part ends`);
}
