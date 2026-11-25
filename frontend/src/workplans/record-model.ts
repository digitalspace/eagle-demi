import { flipAxisMarks, todayMark, type RecordGeometry } from './record-axis';
import { afterRows } from './record-after';
import type { RecordEvents } from './record-event-list';
import { assessmentEvents, nextActRow, type RecordEvent } from './record-events';
import { type LimitTotals, type RecordParts, type RecordProject, headerNotes, noteList } from './record-header';
import type { KindItem } from './chart-kinds';
import { recordLegend } from './record-kinds';
import { assessmentParts } from './record-limits';
import { assessmentRows } from './record-steps';
import type { AxisMark, ChartRow, KindId, LimitPartView, RecordCtx, RecordNote, StepRow, VLine } from './record-types';

export interface RecordModelInput {
  project: RecordProject;
  act: number;
  parts: RecordParts;
  /** ISO day. */
  today: string;
  /** The axis at the chosen time scale and measured width. */
  geo: RecordGeometry;
  /** Disclosure state per later work id; missing reads as closed. */
  open?: Readonly<Record<string, boolean>>;
}

/** Everything the chart, the Time limit changes block, the Events block and the notes need for one record. */
export interface RecordModel {
  rows: ChartRow[];
  steps: StepRow[];
  /** Mark kinds drawn, and the legend of them in legend order. */
  used: ReadonlySet<KindId>;
  legend: KindItem[];
  vlines: VLine[];
  /** Sorted, with crowded or edge labels flipped. */
  axisMarks: AxisMark[];
  limits: LimitPartView[];
  /** For `recordSummary`. */
  totals: LimitTotals;
  events: RecordEvents;
  /** The chart's notes, then the header's, through `noteList`. */
  notes: RecordNote[];
}

export function recordModel({ project, act, parts, today, geo, open }: RecordModelInput): RecordModel {
  const ctx: RecordCtx = { scale: geo, today, used: new Set(), notes: [], vlines: [], axisMarks: [] };
  const as = parts.assessment;
  const { rows, steps } = assessmentRows(as, ctx, { projectId: project.projectId, act, firstCert: parts.certs[0] ?? null });
  let items: RecordEvent[] = [];
  const limits: LimitPartView[] = [];
  if (as) {
    const ev = assessmentEvents(as, steps, ctx);
    items = ev.items;
    rows.push(ev.cpRow);
    if (parts.nextAssessment) rows.push(nextActRow(as, parts.nextAssessment, ctx));
    limits.push(...assessmentParts(steps, as));
  }
  const after = afterRows(project, act, parts, ctx, open ?? {});
  rows.push(...after.rows);
  limits.push(...after.limits);
  const now = todayMark(geo, today);
  if (now) {
    ctx.used.add('today');
    ctx.vlines.push(now.vline);
    ctx.axisMarks.push(now.mark);
  }
  for (const r of rows) if (r.type === 'row') r.marks.sort((x, y) => x.left - y.left);
  const totals = steps.reduce((t, r) => ({ extended: t.extended + r.sumE, suspended: t.suspended + r.sumS }), { extended: 0, suspended: 0 });
  return {
    rows,
    steps,
    used: ctx.used,
    legend: recordLegend(ctx.used),
    vlines: ctx.vlines,
    axisMarks: flipAxisMarks(ctx.axisMarks, geo.width),
    limits,
    totals,
    events: { items, later: after.events, hasAssessment: !!as, laterWorks: parts.later.length, hasCert: !!parts.cert },
    notes: noteList([...ctx.notes, ...headerNotes(parts, act)]),
  };
}
