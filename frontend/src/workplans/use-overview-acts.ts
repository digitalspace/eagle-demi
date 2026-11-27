import { useDeferredValue, useMemo } from 'react';
import type { WorkplanRow } from '../api/sheet-works';
import type { Mark, MarkNotes } from './chart-types';
import { ACT_YEARS, type ActYear, type WorkKind, workStartOf } from './chart-facts';
import { AXIS_W, axisOf, axisTicks, type Axis, type AxisTicks } from './overview-axis';
import { rowActs } from './overview-chips';
import { layoutRow, type Jump } from './overview-layout';
import { laterMarks } from './overview-later';
import { plotWidth } from './overview-plot';
import { assessMarks } from './overview-assess';
import type { MarkAxis } from './overview-marks';
import {
  actRows,
  rowFacts,
  type RowFacts,
  candidatesOf,
  filterCounts,
  passes,
  projectsOf,
  sortRows,
  type ActRow,
  type Candidate,
  type FilterCounts,
  WORK_KINDS,
} from './overview-rows';
import type { OverviewParams } from './use-overview-params';
import { ZOOMS } from './time-scale';

/** One row's marks at the px per unit `kpx` they were placed for; `hi` is where its own marks end, as a fraction of the axis. */
export interface RowDrawing {
  marks: Mark[];
  notes: MarkNotes;
  jumps: Jump[];
  hi: number | null;
  kpx: number;
}

/** One work of a row, drawn on its own line with its name on the left. */
export interface WorkLine {
  work: WorkplanRow;
  facts: RowFacts;
  drawing: RowDrawing;
}

export interface OverviewRowData {
  cand: Candidate;
  /** The whole project's drawing, never shown: its jump links with no assessment, its end for the opening scroll, its aria-label counts. */
  drawing: RowDrawing;
  /** Each work on its own line: the assessment first, then by start date. */
  works: WorkLine[];
}

/** Everything one Act section draws. */
export interface OverviewActData {
  year: ActYear;
  /** Null when the Act's works name no date. */
  axis: Axis | null;
  /** Rows that pass every filter, sorted. */
  rows: OverviewRowData[];
  emptyText: string;
  /** Track width over the visible width: 1 at the whole range. */
  span: number;
  /** Measured visible track width in px. */
  trackPx: number;
  /** Px per axis unit at this zoom, for label fit and near or far placement. */
  pxPerUnit: number;
  ticks: AxisTicks | null;
  /** Some shown row has work in progress. */
  live: boolean;
  /** Today as a fraction of the axis, null when today is outside it. */
  todayAt: number | null;
}

interface ActBase {
  year: ActYear;
  axis: Axis | null;
  markAxis: MarkAxis | null;
  rows: ActRow[];
  /** Each row's latest drawing by work types and project, redrawn in place when the px per unit changes. */
  drawings: Map<string, RowDrawing>;
}

function baseOf(works: readonly WorkplanRow[], today: string): ActBase[] {
  const projects = projectsOf(works);
  return ACT_YEARS.map((year) => {
    const axis = axisOf(works, year, today);
    const markAxis = axis && { start: axis.start, end: axis.end, units: AXIS_W, px: axis.px };
    return { year, axis, markAxis, rows: actRows(projects, year, axis), drawings: new Map() };
  });
}

function drawRow(cand: Candidate, axis: MarkAxis | null, today: string, kpx: number): RowDrawing {
  const notes: MarkNotes = { undated: 0, open: 0, intr: 0, faults: 0, passed: 0, hidden: 0, oneDay: 0, planned: false, moved: false, kpx };
  const assess = cand.works.find((work) => work.workTypeCode === 'assessment');
  const later = cand.works.filter((work) => work !== assess);
  const built = axis
    ? [...(assess ? assessMarks(assess, axis, cand.row.ctx, notes, today) : []), ...laterMarks(later, axis, notes, today)]
    : [];
  const years = rowActs(cand.row, cand.name)?.acts.map((act) => act.year) ?? [cand.row.year];
  const { marks, jumps } = layoutRow(built, notes, years, cand.row.year);
  // Lead hatches are not the row's own dates, so they do not count for its end.
  const ends = marks.flatMap((m) => (m.x0 !== null && !/\blead\b/.test(m.cls) ? [(m.x1 ?? m.x0) / AXIS_W] : []));
  return { marks, notes, jumps, hi: ends.length ? Math.max(...ends) : null, kpx };
}

interface ActRowsResult {
  year: ActYear;
  rows: OverviewRowData[];
}

/** Years of the zoom level, 0 for the whole range. */
const zoomYears = (zoom: OverviewParams['zoom']) => ZOOMS.find((level) => level.value === zoom)?.years ?? 0;

/**
 * The per-Act pipeline, memoised in layers so each change redoes only its part: base, candidates, rows, ticks, marks.
 * Scrolling changes none of these.
 */
export function useOverviewActs(works: readonly WorkplanRow[], today: string, params: OverviewParams, trackPx: number) {
  const base = useMemo(() => baseOf(works, today), [works, today]);
  // Typing stays responsive: the rows re-filter on the deferred copy.
  const query = useDeferredValue(params.q);
  // A string key, so a URL change that leaves the work types alone keeps every memo below.
  const offKey = WORK_KINDS.flatMap(([kind]) => (params.off.has(kind) ? [kind] : [])).join(',');
  const off = useMemo(() => new Set<WorkKind>(WORK_KINDS.flatMap(([kind]) => (offKey.split(',').includes(kind) ? [kind] : []))), [offKey]);

  const { who, team } = params;
  const cands = useMemo(() => base.map((act) => candidatesOf(act.rows, query, off, today, who, team)), [base, query, off, today, who, team]);

  const { state, phase, over, sort } = params;
  const counts: FilterCounts = useMemo(() => filterCounts(cands.flat(), { state, phase, overOnly: over }), [cands, state, phase, over]);

  const passing = useMemo(
    () => cands.map((list) => sortRows(list.filter((c) => passes(c, { state, phase, overOnly: over })), sort)),
    [cands, state, phase, over, sort],
  );

  const years = zoomYears(params.zoom);
  const scales = useMemo(
    () =>
      base.map((act) => {
        const span = years && act.axis ? Math.max(1, act.axis.years / years) : 1;
        const plot = plotWidth(trackPx * span);
        const ticks = act.axis ? axisTicks(act.axis, plot / act.axis.years, today) : null;
        return { span, ticks, pxPerUnit: plot / AXIS_W };
      }),
    [base, years, trackPx, today],
  );

  const shown = useMemo(
    () =>
      base.map((act, i): ActRowsResult => {
        const kpx = scales[i].pxPerUnit;
        const rows = passing[i].map((cand) => {
          const id = `${offKey}|${who}|${team}|${cand.row.project.projectId}`;
          let drawing = act.drawings.get(id);
          if (drawing?.kpx !== kpx) {
            drawing = drawRow(cand, act.markAxis, today, kpx);
            act.drawings.set(id, drawing);
          }
          const order = (w: WorkplanRow) => (w.workTypeCode === 'assessment' ? '' : (workStartOf(w) ?? '9999'));
          const works = [...cand.works]
            .sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0))
            .map((work): WorkLine => {
              const wid = `${id}|${work.workId}`;
              let line = act.drawings.get(wid);
              if (line?.kpx !== kpx) {
                // The assessment shares the project's line, so it keeps the links to the project under its other Acts.
                const own = drawRow({ ...cand, works: [work] }, act.markAxis, today, kpx);
                line = work.workTypeCode === 'assessment' ? own : { ...own, jumps: [] };
                act.drawings.set(wid, line);
              }
              return { work, facts: rowFacts([work], today), drawing: line };
            });
          return { cand, drawing, works };
        });
        return { year: act.year, rows };
      }),
    [base, passing, scales, offKey, who, team, today],
  );

  const acts = useMemo(
    () =>
      base.map((act, i): OverviewActData => {
        const { rows } = shown[i];
        const { axis } = act;
        const q = query.trim();
        return {
          year: act.year,
          axis,
          rows,
          emptyText: q ? `No project under this Act matches "${q}".` : 'No rows under this Act match the filters.',
          ...scales[i],
          trackPx,
          live: rows.some((r) => r.cand.facts.open),
          todayAt: axis?.todayIn ? (Date.parse(today) - axis.a0) / (axis.a1 - axis.a0) : null,
        };
      }),
    [base, shown, scales, trackPx, query, today],
  );

  return { acts, counts };
}
