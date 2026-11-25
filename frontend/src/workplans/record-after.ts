import type { WorkplanPhase, WorkplanRow } from '../api/sheet-works';
import type { TipRowInput } from './chart-types';
import { colourOf } from './chart-colours';
import { duration, outcomeText } from './chart-words';
import { count, plural } from './format';
import { dayNo, isOpenEnded, isoOf, plannedDecision, recordEnd, recordStart } from './record-axis';
import type { RecordEvent } from './record-events';
import { type RecordParts, type RecordProject, isCert, stateTag } from './record-header';
import { addExt, addPart, extPlan, linkTo, olimMark } from './record-limits';
import { axisMarkOf, headOf, isTrack, laneify, noteOf, phaseInfo, rowOf, segsFor } from './record-steps';
import {
  type ChartRow,
  type LimitPart,
  type LimitPartView,
  type RecordCtx,
  type RecordMark,
  type RecordRow,
  type Tag,
  addNote,
  extOf,
  f3,
  markOf,
} from './record-types';
import { dayNumber } from './phase-bounds';

const WORK_KIND: Record<string, string> = {
  assessment: 'assessment',
  amendment: 'amendment',
  'eac-extension': 'EAC extension',
  'substantial-start': 'substantial start',
  'minister-designation': "Minister's designation",
  'ceao-designation': "CEAO's designation",
  'project-notification': 'project notification',
  'exemption-order': 'exemption order',
  transfer: 'transfer',
  'material-alteration': 'material alteration',
};

const kindName = (w: WorkplanRow) => WORK_KIND[w.workTypeCode ?? ''] ?? w.workTypeCode ?? 'work';

/** "Amendment", "EAC extension": the kind word that starts a later work's event entry. */
const kindWord = (w: WorkplanRow) => {
  const name = kindName(w);
  return name[0].toUpperCase() + name.slice(1);
};

/** The work's title without the project name in front. */
export const shortTitle = (w: WorkplanRow, projectName: string) =>
  String(w.title || kindName(w)).replace(`${projectName} - `, '').replace(/ - /g, ' ');

const byOrder = (x: WorkplanPhase, y: WorkplanPhase) => (x.order || 0) - (y.order || 0);

function noLaterRow(project: RecordProject, act: number, parts: RecordParts): RecordRow {
  const as = parts.assessment;
  let text = 'No amendments, extensions or substantial starts recorded.';
  if (as?.transitionOut) {
    text = `The assessment moved to the ${as.transitionOut.toActYear} Act before a decision, so no certificate was issued under the ${act} Act.`;
  } else if (as && !isCert(as)) {
    text = `No certificate was issued${as.outcome ? ` (${outcomeText(as)})` : ''}, so there are no later works.`;
  }
  const other = parts.certs.find((c) => c.act !== act);
  const jump =
    other && as && !isCert(as)
      ? { text: `Open the ${other.act} Act part, where the certificate was issued`, projectId: project.projectId, act: other.act }
      : null;
  return rowOf({ cls: 'empty', name: 'No later works', isEmpty: true, emptyText: text, jump });
}

function line2Of(s: number | null, e: number | null, pd: number | null): string {
  if (s == null) return 'No recorded dates';
  if (e != null && s === e) return `${isoOf(s)}, one day`;
  if (e != null) return `${isoOf(s)} to ${isoOf(e)}, ${duration(e - s)}`;
  if (pd != null) return `From ${isoOf(s)}, decision planned ${isoOf(pd)}`;
  return `${isoOf(s)} to no recorded date`;
}

const reversed = (ph: WorkplanPhase) => {
  const s = dayNo(ph.startDate);
  const e = dayNo(ph.endDate);
  return s != null && e != null && e < s;
};

/** The tag beside the work's state tag, and the work's notes; the state tag itself always shows. */
function workTag(w: WorkplanRow, title: string, s: number | null, as: WorkplanRow | null, ctx: RecordCtx): Tag {
  const stg = stateTag(w);
  const pd = plannedDecision(w);
  let tag: Tag = stg;
  if (w.replaces.length) tag = { text: 'Also recorded in Track', tone: 'grey' };
  if (w.phases.some(reversed)) {
    tag = { text: 'Dates conflict', tone: 'red' };
    addNote(ctx, 'warn', `Dates conflict: ${title}, a phase ends before it starts`);
  }
  if (pd != null && pd < dayNumber(ctx.today)) {
    tag = { text: 'Planned date passed', tone: 'yellow' };
    addNote(ctx, 'pass', `Planned date passed: decision planned ${isoOf(pd)} (${title})`);
  }
  if (w.untilTrack) addNote(ctx, 'info', `${title}: shown only until Track has its own record`);
  if (isOpenEnded(w) && s != null) {
    addNote(ctx, 'info', `${title}: ${stg.text.toLowerCase()} since ${isoOf(s)}, no recorded end date; drawn to today`);
  }
  const end = recordEnd(w, ctx.today);
  const asStart = dayNo(as?.startDate);
  if (asStart != null && end != null && end <= asStart) addNote(ctx, 'info', `${title}: ran before the assessment started`);
  return tag;
}

/** A Track later work's parts of the Time limit changes block; its extension marks go on `marks`. */
function workLimitParts(w: WorkplanRow, wi: number, marks: RecordMark[], ctx: RecordCtx): LimitPart[] {
  const hasExt = (w.milestones ?? []).some((m) => m.kind === 'extension') || w.phases.some((ph) => extOf(ph) > 0);
  if (!isTrack(w) || !hasExt) return [];
  const plan = extPlan(w);
  const parts: LimitPart[] = plan.phs.map((ph, pi) => ({
    id: `lw${wi}p${pi}`,
    name: ph.name ?? '',
    ph,
    o: phaseInfo(ph, w, ctx.today),
    lrows: [],
    sumE: 0,
    sumS: 0,
    noDates: plan.noDates[pi],
    marks,
    limText: '',
  }));
  plan.evs.forEach((x, k) => addExt(parts.find((q) => q.ph === x.ph), x, `lx${wi}-${k}`, ctx, { marks }));
  return parts;
}

/** The disclosure's rows: the phases of a Track work that has more than one. */
function subRows(w: WorkplanRow, title: string, ctx: RecordCtx): ChartRow[] {
  const rows = w.phases
    .slice()
    .sort(byOrder)
    .map((ph) => {
      const t = phaseInfo(ph, w, ctx.today);
      const tip: TipRowInput[] = [
        ['Kind', `Phase of ${title}`],
        ['Dates', t.line2],
        [ph.legislated ? 'Time limit' : 'Planned', ph.numberOfDays ? plural(ph.numberOfDays, 'day') : ''],
      ];
      const marks = segsFor(ph, w, { title: ph.name ?? '', rows: tip, who: title, label: ph.name ?? '', later: true }, ctx);
      if (t.olim) marks.push(olimMark(t, ph, ctx));
      const { line2, limText, flag, warn, pass, tag } = t;
      return rowOf({ cls: 'sub', name: ph.name ?? '', sw: { background: colourOf(ph.name, w.workTypeCode) }, line2, limText, flag, warn, pass, tag, marks });
    });
  return [noteOf('Phases of this work'), ...rows];
}

interface WorkInput {
  w: WorkplanRow;
  wi: number;
  title: string;
  as: WorkplanRow | null;
  open: boolean;
}

interface WorkOut {
  rows: ChartRow[];
  events: RecordEvent[];
  limits: LimitPartView[];
}

function workEvents(w: WorkplanRow, title: string, ids: [string, string], hasMark: boolean, ctx: RecordCtx): RecordEvent[] {
  const today = dayNumber(ctx.today);
  const s = recordStart(w, ctx.today);
  const e = dayNo(w.decisionDate);
  const pd = plannedDecision(w);
  const out: RecordEvent[] = [];
  if (s != null) {
    const to = e != null && e > s ? ` to ${isoOf(e)}` : e == null && pd == null ? ' to no recorded date' : '';
    const name = title + (w.outcome ? `: ${outcomeText(w)}` : '');
    const len = e != null && e > s ? plural(e - s, 'day') : '';
    out.push({ d: s, e, c: 'aw', kind: kindWord(w), name, date: isoOf(s) + to, count: 1, id: ids[0], g: 'g bar thin', hasMark, step: null, len });
  }
  if (pd != null) {
    const passed = pd < today;
    const date = isoOf(pd) + (passed ? ', planned, date passed' : ', planned');
    const g = `g ${passed ? 'dflag due' : 'dflag plan'}`;
    out.push({ d: pd, e: null, c: 'aw', kind: 'Planned decision', name: `Decision planned: ${title}`, date, count: 1, id: ids[1], g, hasMark: true, step: null, len: '' });
  }
  return out;
}

function plannedMark(pd: number, title: string, tag: Tag, id: string, ctx: RecordCtx): RecordMark {
  const passed = pd < dayNumber(ctx.today);
  ctx.used.add(passed ? 'msPassed' : 'decPlan');
  const rows: TipRowInput[] = [['Date', isoOf(pd)], ['State', passed ? 'Planned date passed' : tag.text], ['Work', title]];
  return markOf(passed ? 'dflag due' : 'dflag plan', { left: `${f3(ctx.scale.pct(pd))}%` }, 'Planned decision', rows, id);
}

function expandOf(w: WorkplanRow, title: string, open: boolean) {
  return { workId: w.workId, open, text: `${open ? 'Hide' : 'Show'} the ${plural(w.phases.length, 'phase')} of ${title}` };
}

/** One later work: its row with bars and planned decision, its disclosure rows, list entries and limit parts. */
function laterWork({ w, wi, title, as, open }: WorkInput, ctx: RecordCtx): WorkOut {
  const s = recordStart(w, ctx.today);
  const pd = plannedDecision(w);
  const line2 = line2Of(s, dayNo(w.decisionDate), pd);
  const stg = stateTag(w);
  const tag = workTag(w, title, s, as, ctx);
  const multi = w.phases.length > 1;
  const marks = w.phases.flatMap((ph) => {
    const rows: TipRowInput[] = [['Dates', line2], ['State', tag.text], ['Phase', multi ? ph.name : '']];
    return segsFor(ph, w, { title, rows, who: title, label: multi ? (ph.name ?? '') : title, later: true }, ctx);
  });
  const ids: [string, string] = [`lw${wi}`, `lp${wi}`];
  if (pd != null) marks.push(plannedMark(pd, title, tag, ids[1], ctx));
  marks.sort((x, y) => x.left - y.left);
  const firstBar = marks.find((m) => m.geo);
  if (firstBar) Object.assign(firstBar, { id: ids[0], backAt: firstBar.geo?.r ?? null });
  const parts = workLimitParts(w, wi, marks, ctx);
  const rowStyle = laneify(marks, ctx) ?? {};
  const expands = isTrack(w) && multi;
  const isOpen = expands && open;
  const row = rowOf({
    name: title,
    sw: { background: colourOf(w.phases[0]?.name ?? '', w.workTypeCode) },
    line2,
    tag: stg,
    tags2: tag.text !== stg.text ? [tag] : [],
    marks,
    rowStyle,
    expand: expands ? expandOf(w, title, isOpen) : null,
  });
  const limits = parts
    .filter((q) => q.lrows.length || q.noDates)
    .flatMap((q) => addPart(q, { type: w.workTypeCode, label: `${title}: ${q.name}`, work: w.workId }) ?? []);
  if (limits.length) linkTo(row, limits[0].id, parts.reduce((n, q) => n + q.lrows.length, 0), title);
  const rows: ChartRow[] = [row, ...(isOpen ? subRows(w, title, ctx) : [])];
  return { rows, events: workEvents(w, title, ids, !!firstBar, ctx), limits };
}

export interface AfterRows extends WorkOut {
  /** The head's second line: the certificate the works change and how many are filed under each Act. */
  lead: string;
}

/** The "After the certificate" head and the later works under it; `open` holds each work's disclosure state. */
export function afterRows(project: RecordProject, act: number, parts: RecordParts, ctx: RecordCtx, open: Readonly<Record<string, boolean>>): AfterRows {
  const { later, cert, assessment: as } = parts;
  if (!later.length) return { rows: [headOf('After the certificate'), noLaterRow(project, act, parts)], lead: '', events: [], limits: [] };
  const byAct = new Map<number | null, number>();
  for (const w of later) byAct.set(w.actYear, (byAct.get(w.actYear) ?? 0) + 1);
  const filed = [...byAct]
    .sort(([x], [y]) => (x ?? 0) - (y ?? 0))
    .map(([year, n]) => `${count(n)} filed under the ${year} Act`)
    .join(', ');
  const lead = `${cert ? `Works that change the ${cert.kind} issued ${isoOf(cert.day)}. ` : ''}${filed}.`;
  if (cert && cert.work !== as) {
    ctx.used.add('dec');
    ctx.vlines.push({ cls: 'vline dec', left: ctx.scale.pct(cert.day) });
    ctx.axisMarks.push(axisMarkOf(ctx, 'dec', cert.day, 'Certificate', 'Certificate', [['Kind', cert.kind], ['Date', isoOf(cert.day)]]));
  }
  const outs = later.map((w, wi) =>
    laterWork({ w, wi, title: shortTitle(w, project.projectName), as, open: !!open[w.workId] }, ctx),
  );
  return {
    rows: [headOf('After the certificate', lead), ...outs.flatMap((o) => o.rows)],
    lead,
    events: outs.flatMap((o) => o.events),
    limits: outs.flatMap((o) => o.limits),
  };
}
