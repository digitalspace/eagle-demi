import type { Undated, WorkplanPhase, WorkplanRow } from '../api/sheet-works';
import type { Project } from '../api/types';

export type WorkStatus = 'overdue' | 'next-30' | 'on-track' | 'not-started' | 'closed';

export const STATUS_LABEL: Record<WorkStatus, string> = {
  overdue: 'Overdue',
  'next-30': 'Next ≤ 30 d',
  'on-track': 'On track',
  'not-started': 'Not started',
  closed: 'Closed',
};

/** Progress bar colour state: overdue, above 80 % of planned days, or neither. */
export type BarState = 'overdue' | 'near-limit' | 'normal';

export const PIPELINE_COLUMNS = ['Intake', 'Planning', 'Proponent time', 'Review', 'Decision'] as const;
export type PipelineColumn = (typeof PIPELINE_COLUMNS)[number];

/** One phase on the lifecycle strip. `offset` and `share` are fractions of the work's span. */
export interface Segment {
  name: string | null;
  state: 'past' | 'current' | 'upcoming';
  start: string;
  end: string;
  offset: number;
  share: number;
}

export interface WorkRow {
  work: WorkplanRow;
  /** `Project.region` joined by `projectId`; null when the project is not in the list. */
  region: string | null;
  /** Phases sorted by `order`. */
  phases: WorkplanPhase[];
  closed: boolean;
  notStarted: boolean;
  /** First open phase that has started; always null on a closed work. */
  current: WorkplanPhase | null;
  /** Null when the current phase start is not known. */
  daysInPhase: number | null;
  plannedDays: number | null;
  percentUsed: number | null;
  bar: BarState | null;
  overdue: boolean;
  daysOver: number;
  /** Planned end to today, the hatched part of an overdue phase. */
  overrun: { start: string; end: string } | null;
  suspended: boolean;
  /** Legal section of the interruption covering today, as "s.30(1)". */
  suspendedUnder: string | null;
  /** Next phase start after today, else the decision; null on a closed work. */
  next: { name: string; date: string; inDays: number } | null;
  /** `decisionDate`, else `anticipatedDecisionDate`. */
  decisionDate: string | null;
  decisionExpected: boolean;
  status: WorkStatus;
  /** Null on a closed work. */
  column: PipelineColumn | null;
  segments: Segment[];
  /** Today as a fraction of the segments' span, clamped to 0..1; null with no segments. */
  todayAt: number | null;
}

const DAY_MS = 86_400_000;
const NEAR_LIMIT_PERCENT = 80;
const SOON_DAYS = 30;

/** The calendar day of a date-only or ISO timestamp string. */
const dayOf = (iso: string | null | undefined): string | null => (iso ? iso.slice(0, 10) : null);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

/** The start, or the latest day an undated start can be. */
const startBound = (startDate: string | null, undated: Undated): string | null =>
  dayOf(startDate) ?? dayOf(undated?.['startDate']?.notAfter);

/** A copy sorted by `order`; a phase with none goes last. */
export function phasesInOrder<T extends { order: number | null }>(phases: T[]): T[] {
  return [...phases].sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
}

const fold = (text: string | null) => (text ?? '').trim().toLowerCase();

const COLUMN_BY_NAME = new Map<string, PipelineColumn>(
  (
    [
      ['Intake', ['Initial Contact', 'Pre-EA', 'Project Designation']],
      ['Planning', ['Procedures Development', 'Early Engagement', 'Readiness Decision', 'Process Planning', 'Pre-Application']],
      ['Proponent time', ['Application Development']],
      [
        'Review',
        [
          'Completeness Review',
          'Amendment Review',
          'Application Review',
          'Effects Assessment',
          'Evaluation',
          'SubStart Assessment',
          'Further Assessment',
        ],
      ],
      ['Decision', ['Recommendation', 'Referral']],
    ] as const
  ).flatMap(([column, names]) => names.map((name) => [fold(name), column] as const)),
);

const COLUMN_BY_STAGE = new Map<string, PipelineColumn>(
  (
    [
      ['Intake', ['Pre-EA']],
      ['Planning', ['Pre-Application', 'Early Engagement', 'Readiness Decision', 'Process Planning']],
      [
        'Review',
        [
          'Application Review',
          'Evaluation',
          'Application Development and Review',
          'Effects Assessment and Recommendation',
          'Post Decision',
        ],
      ],
      ['Decision', ['Referral', 'Referral and Decision']],
    ] as const
  ).flatMap(([column, stages]) => stages.map((stage) => [fold(stage), column] as const)),
);

/** Pipeline column of a phase: by name, then by `stage`, then Review. */
export function columnOf(phase: Pick<WorkplanPhase, 'name' | 'stage'>): PipelineColumn {
  const name = fold(phase.name);
  const named = COLUMN_BY_NAME.get(name);
  if (named) return named;
  if (name.includes('proponent')) return 'Proponent time';
  if (name.endsWith('decision')) return 'Decision';
  return COLUMN_BY_STAGE.get(fold(phase.stage)) ?? 'Review';
}

/** Fill and edge pair of the current phase, by its pipeline column; readiness has its own pair. */
export function toneOf(row: WorkRow): string {
  if (!row.current) return 'review';
  if ((row.current.name ?? '').toLowerCase().includes('readiness')) return 'readiness';
  const column = columnOf(row.current);
  if (column === 'Proponent time') return 'proponent';
  if (column === 'Decision') return 'decision';
  return column === 'Review' ? 'review' : 'planning';
}

function isClosed(work: WorkplanRow, today: string): boolean {
  const decided = dayOf(work.decisionDate);
  return work.isActive === false || (decided !== null && decided <= today) || Boolean(work.transitionOut);
}

const hasStarted = (phase: WorkplanPhase, today: string) => {
  const start = startBound(phase.startDate, phase.undated);
  return start !== null && start <= today;
};

/** Planned length: `numberOfDays`, else end minus start. */
function plannedOf(phase: WorkplanPhase): number | null {
  if (typeof phase.numberOfDays === 'number') return phase.numberOfDays;
  const start = dayOf(phase.startDate);
  const end = dayOf(phase.endDate);
  return start && end ? daysBetween(start, end) : null;
}

function progressOf(current: WorkplanPhase | null, today: string) {
  const start = dayOf(current?.startDate);
  const end = dayOf(current?.endDate);
  const daysInPhase = start ? daysBetween(start, today) : null;
  const plannedDays = current ? plannedOf(current) : null;
  const overdue = end !== null && end < today;
  const percentUsed =
    daysInPhase !== null && plannedDays ? Math.min(100, Math.round((daysInPhase / plannedDays) * 100)) : null;
  let bar: BarState | null = null;
  if (overdue) bar = 'overdue';
  else if (percentUsed !== null) bar = percentUsed > NEAR_LIMIT_PERCENT ? 'near-limit' : 'normal';
  return {
    daysInPhase,
    plannedDays,
    percentUsed,
    bar,
    overdue,
    daysOver: overdue ? daysBetween(end, today) : 0,
    overrun: overdue ? { start: end, end: today } : null,
  };
}

/** Track's own flag on an open phase, or an interruption whose dates cover today. */
function suspensionOf(phases: WorkplanPhase[], today: string) {
  const covering = phases
    .flatMap((phase) => phase.interruptions)
    .find((stop) => {
      const start = dayOf(stop.startDate);
      const end = dayOf(stop.endDate);
      return start !== null && start <= today && (end === null || end >= today);
    });
  const flagged = phases.some((phase) => phase.isSuspended === true && !phase.isCompleted);
  return { suspended: flagged || covering !== undefined, suspendedUnder: covering?.legalSection ?? null };
}

function nextOf(phases: WorkplanPhase[], today: string, decisionDate: string | null) {
  const phase = phases.find((p) => {
    const start = dayOf(p.startDate);
    return start !== null && start > today;
  });
  const date = phase ? dayOf(phase.startDate) : decisionDate;
  if (!date || date <= today) return null;
  return { name: phase ? phase.name || 'Unnamed phase' : 'Decision', date, inDays: daysBetween(today, date) };
}

function statusOf(row: Pick<WorkRow, 'closed' | 'overdue' | 'notStarted' | 'next'>): WorkStatus {
  if (row.closed) return 'closed';
  if (row.overdue) return 'overdue';
  if (row.notStarted) return 'not-started';
  return row.next && row.next.inDays <= SOON_DAYS ? 'next-30' : 'on-track';
}

function stateOf(phase: WorkplanPhase, current: WorkplanPhase | null, today: string): Segment['state'] {
  if (phase === current) return 'current';
  return phase.isCompleted || hasStarted(phase, today) ? 'past' : 'upcoming';
}

/** Dated phases on one strip, each sized by its share of the work's span; the open current phase runs to today. */
function lifecycleOf(phases: WorkplanPhase[], current: WorkplanPhase | null, overrunEnd: string | null, today: string) {
  const dated = phases.flatMap((phase) => {
    const start = dayOf(phase.startDate);
    const end = dayOf(phase.endDate) ?? (phase === current ? today : null);
    return start && end ? [{ phase, start, end }] : [];
  });
  if (!dated.length) return { segments: [], todayAt: null };
  const first = dated.reduce((min, d) => (d.start < min ? d.start : min), dated[0].start);
  const last = dated.reduce((max, d) => (d.end > max ? d.end : max), overrunEnd ?? dated[0].end);
  const span = Math.max(1, daysBetween(first, last));
  const segments = dated.map(({ phase, start, end }) => ({
    name: phase.name,
    state: stateOf(phase, current, today),
    start,
    end,
    offset: daysBetween(first, start) / span,
    share: daysBetween(start, end) / span,
  }));
  return { segments, todayAt: Math.min(1, Math.max(0, daysBetween(first, today) / span)) };
}

function columnOfWork(row: Pick<WorkRow, 'closed' | 'notStarted' | 'current' | 'phases'>): PipelineColumn | null {
  if (row.closed) return null;
  if (row.notStarted) return 'Intake';
  const at = row.current ?? row.phases.find((phase) => !phase.isCompleted);
  return at ? columnOf(at) : 'Review';
}

function rowOf(work: WorkplanRow, project: Project | undefined, today: string): WorkRow {
  const phases = phasesInOrder(work.phases);
  const closed = isClosed(work, today);
  const current = closed ? null : (phases.find((phase) => !phase.isCompleted && hasStarted(phase, today)) ?? null);
  const starts = [startBound(work.startDate, work.undated), ...phases.map((p) => startBound(p.startDate, p.undated))];
  const notStarted = !closed && starts.every((start) => start === null || start > today);
  const progress = progressOf(current, today);
  const decisionDate = dayOf(work.decisionDate ?? work.anticipatedDecisionDate);
  const next = closed ? null : nextOf(phases, today, decisionDate);
  const state = { closed, notStarted, current, phases, next, overdue: progress.overdue };
  return {
    work,
    region: project?.region ?? null,
    ...state,
    ...progress,
    ...(closed ? { suspended: false, suspendedUnder: null } : suspensionOf(phases, today)),
    decisionDate,
    decisionExpected: !work.decisionDate && decisionDate !== null,
    status: statusOf(state),
    column: columnOfWork(state),
    ...lifecycleOf(phases, current, progress.overrun?.end ?? null, today),
  };
}

/** Each work's state on `today` (an ISO day, `YYYY-MM-DD`), with region from its project. */
export function rowsOf(works: WorkplanRow[], projects: Project[], today: string): WorkRow[] {
  const byId = new Map(projects.map((project) => [String(project.id), project]));
  return works.map((work) => rowOf(work, byId.get(String(work.projectId)), today));
}

const TIER: Record<WorkStatus, number> = { overdue: 0, 'next-30': 1, 'on-track': 1, 'not-started': 2, closed: 3 };

/** Attention order: overdue, most days over first; then soonest next milestone; then not started; closed last. */
export function byAttention(a: WorkRow, b: WorkRow): number {
  const weight = (row: WorkRow) => (row.overdue ? -row.daysOver : (row.next?.inDays ?? Infinity));
  return (
    TIER[a.status] - TIER[b.status] ||
    weight(a) - weight(b) ||
    (a.work.title ?? '').localeCompare(b.work.title ?? '')
  );
}
