import type { Undated, WorkplanPhase, WorkplanRow } from '../api/sheet-works';
import type { Project } from '../api/types';
import { phaseToneOf, type PhaseTone } from './phase-tone';

export type WorkStatus = 'overdue' | 'next-30' | 'on-track' | 'not-started' | 'unknown' | 'inactive' | 'closed';

export const STATUS_LABEL: Record<WorkStatus, string> = {
  overdue: 'Overdue',
  'next-30': 'Next ≤ 30 d',
  'on-track': 'On track',
  'not-started': 'Not started',
  unknown: 'Status unknown',
  inactive: 'Inactive',
  closed: 'Closed',
};

/** Progress bar colour state: overdue, above 80 % of planned days, or neither. */
export type BarState = 'overdue' | 'near-limit' | 'normal';

export const PIPELINE_COLUMNS = ['Intake', 'Planning', 'Proponent time', 'Review', 'Decision'] as const;
export type PipelineColumn = (typeof PIPELINE_COLUMNS)[number];

/** One phase on the lifecycle strip. `offset` and `share` are fractions of the strip, phases packed end to end. */
export interface Segment {
  name: string | null;
  /** `incomplete`: started, not completed, and not the current phase. */
  state: 'past' | 'current' | 'incomplete' | 'upcoming';
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
  /** No phase under way yet, or the phase Track marks current has not started. */
  notStarted: boolean;
  /** Open started phase Track marks current, else the first open phase that has started; always null on a closed work. */
  current: WorkplanPhase | null;
  /** Current phase start to today, or to `suspendedSince`; null when the start is not known. */
  daysInPhase: number | null;
  /** Current phase `endDate` minus its start; null with no end or an end before the start. */
  plannedDays: number | null;
  /** Not capped: above 100 once past the end. */
  percentUsed: number | null;
  bar: BarState | null;
  /** Past the current phase end and not suspended now; never on an inactive work. */
  overdue: boolean;
  daysOver: number;
  /** Planned end to today, the hatched part of an overdue phase. */
  overrun: { start: string; end: string } | null;
  suspended: boolean;
  /** Day the current phase's open suspension began, or the phase start if later; null when not suspended now. */
  suspendedSince: string | null;
  /** Legal section of the suspension covering today, as "s.30(1)". */
  suspendedUnder: string | null;
  /** Earliest phase start or decision after today; null on a closed, inactive or unknown work. */
  next: { name: string; date: string; inDays: number } | null;
  /** `decisionDate`, else `anticipatedDecisionDate`, else `decisionEventDate`, else the start of the open decision phase; a closed work takes only the first two. */
  decisionDate: string | null;
  decisionExpected: boolean;
  status: WorkStatus;
  /** Null on a closed work. */
  column: PipelineColumn | null;
  segments: Segment[];
  /** Today's place on the strip, 0..1, inside the current phase when there is one; null with no segments. */
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
      ['Intake', ['Initial Contact', 'Project Designation']],
      ['Planning', ['Early Engagement', 'Readiness Decision']],
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

/** Pipeline column of a phase: by name, then by words in the name, then by `stage`, then Review. */
export function columnOf(phase: Pick<WorkplanPhase, 'name' | 'stage'>): PipelineColumn {
  const name = fold(phase.name);
  const named = COLUMN_BY_NAME.get(name);
  if (named) return named;
  if (name.includes('proponent')) return 'Proponent time';
  if (name.endsWith('decision')) return 'Decision';
  if (name.startsWith('pre-ea') || name.includes('intake')) return 'Intake';
  if (/pre-|planning|procedures/.test(name)) return 'Planning';
  return COLUMN_BY_STAGE.get(fold(phase.stage)) ?? 'Review';
}

/** Fill and edge pair of the current phase. */
export const toneOf = (row: WorkRow): PhaseTone => (row.current ? phaseToneOf(row.current) : 'review');

const OPEN_TRACK_STATES = new Set(['IN_PROGRESS', 'SUSPENDED']);
const ENDED_TRACK_STATES = new Set(['COMPLETED', 'CLOSED', 'WITHDRAWN', 'TERMINATED']);

/** Inactive: a Track work switched off while still in progress, kept apart from closed works. */
function closureOf(work: WorkplanRow, today: string) {
  const decided = dayOf(work.decisionDate);
  const ended =
    (decided !== null && decided <= today) ||
    Boolean(work.transitionOut) ||
    ENDED_TRACK_STATES.has(work.workState ?? '');
  const inactive = !ended && work.isActive === false && OPEN_TRACK_STATES.has(work.workState ?? '');
  return { closed: !inactive && (ended || work.isActive === false), inactive };
}

const hasStarted = (phase: WorkplanPhase, today: string) => {
  const start = startBound(phase.startDate, phase.undated);
  return start !== null && start <= today;
};

const endsBeforeStart = (phase: WorkplanPhase) => {
  const start = dayOf(phase.startDate);
  const end = dayOf(phase.endDate);
  return start !== null && end !== null && end < start;
};

/** The end day, or null when it falls before the start. */
const endOf = (phase: WorkplanPhase) => (endsBeforeStart(phase) ? null : dayOf(phase.endDate));

/** Track's flag on the current phase (from `suspendedDate`), or a `suspension` interruption on it covering today. */
function suspensionOf(current: WorkplanPhase | null, today: string) {
  const covering = current?.interruptions.find((stop) => {
    const start = dayOf(stop.startDate);
    const end = dayOf(stop.endDate);
    return stop.kind === 'suspension' && start !== null && start <= today && (end === null || end >= today);
  });
  const began = current?.isSuspended === true ? (dayOf(current.suspendedDate) ?? today) : dayOf(covering?.startDate);
  const start = dayOf(current?.startDate);
  const since = began !== null && start !== null && start > began ? start : began;
  return { suspended: since !== null, suspendedSince: since, suspendedUnder: covering?.legalSection ?? null };
}

/** Planned days, percent and overdue all measure against the current phase `endDate`; a suspension stops the day count. */
function progressOf(current: WorkplanPhase | null, today: string, suspendedSince: string | null) {
  const start = dayOf(current?.startDate);
  const end = current ? endOf(current) : null;
  const daysInPhase = start ? daysBetween(start, suspendedSince ?? today) : null;
  const plannedDays = start && end ? daysBetween(start, end) : null;
  const overdue = end !== null && end < today && suspendedSince === null;
  const percentUsed = daysInPhase !== null && plannedDays ? Math.round((daysInPhase / plannedDays) * 100) : null;
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

/** A sheet work with a current phase that has no end date, and no decision date. */
const hasNoEnd = (work: WorkplanRow, current: WorkplanPhase) =>
  work.source === 'sheet' &&
  !work.decisionDate &&
  !current.endDate &&
  !current.undated?.['endDate']?.notAfter;

/** Falls back to the start of the last open phase named "... Decision" in the Decision column, so not Readiness Decision. */
function decisionOf(work: WorkplanRow, phases: WorkplanPhase[], closed: boolean): string | null {
  if (closed) return dayOf(work.decisionDate ?? work.anticipatedDecisionDate);
  const decisions = phases.filter(
    (phase) => !phase.isCompleted && fold(phase.name).endsWith('decision') && columnOf(phase) === 'Decision',
  );
  return dayOf(
    work.decisionDate ?? work.anticipatedDecisionDate ?? work.decisionEventDate ?? decisions.at(-1)?.startDate,
  );
}

function nextOf(phases: WorkplanPhase[], today: string, decisionDate: string | null) {
  const ahead = [
    ...phases.map((phase) => ({ name: phase.name || 'Unnamed phase', date: dayOf(phase.startDate) })),
    { name: 'Decision', date: decisionDate },
  ].filter((item): item is { name: string; date: string } => item.date !== null && item.date > today);
  if (!ahead.length) return null;
  const { name, date } = ahead.reduce((soonest, item) => (item.date < soonest.date ? item : soonest));
  return { name, date, inDays: daysBetween(today, date) };
}

function statusOf(
  row: Pick<WorkRow, 'closed' | 'overdue' | 'notStarted' | 'next'> & { inactive: boolean; unknown: boolean },
): WorkStatus {
  if (row.closed) return 'closed';
  if (row.inactive) return 'inactive';
  if (row.unknown) return 'unknown';
  if (row.overdue) return 'overdue';
  if (row.notStarted) return 'not-started';
  return row.next && row.next.inDays <= SOON_DAYS ? 'next-30' : 'on-track';
}

function stateOf(phase: WorkplanPhase, current: WorkplanPhase | null, today: string): Segment['state'] {
  if (phase === current) return 'current';
  if (phase.isCompleted) return 'past';
  return hasStarted(phase, today) ? 'incomplete' : 'upcoming';
}

/** Where today falls: inside the current phase, else in the phase holding it, else at the start of the next one. */
function todayOn(segments: Segment[], current: Segment | undefined, today: string, total: number): number {
  const at = (segment: Segment) =>
    segment.offset + Math.min(segment.share, Math.max(0, daysBetween(segment.start, today) / total));
  if (current) return at(current);
  const holding = segments.find((segment) => today <= segment.end);
  if (!holding) return 1;
  return today < holding.start ? holding.offset : at(holding);
}

/**
 * Dated phases end to end in phase order, each sized by its days; the current phase with no valid end runs to today.
 * An overdue current phase runs to `overrunEnd`, pushing later phases right; `start` and `end` stay the real dates.
 */
function lifecycleOf(phases: WorkplanPhase[], current: WorkplanPhase | null, overrunEnd: string | null, today: string) {
  const dated = phases.flatMap((phase) => {
    const start = dayOf(phase.startDate);
    const end = endOf(phase) ?? (phase === current ? today : null);
    const until = phase === current && overrunEnd && end && overrunEnd > end ? overrunEnd : end;
    return start && end && until ? [{ phase, start, end, days: Math.max(1, daysBetween(start, until)) }] : [];
  });
  if (!dated.length) return { segments: [], todayAt: null };
  const total = dated.reduce((sum, d) => sum + d.days, 0);
  let offset = 0;
  const segments: Segment[] = dated.map(({ phase, start, end, days }) => {
    const segment = { name: phase.name, state: stateOf(phase, current, today), start, end, offset, share: days / total };
    offset += segment.share;
    return segment;
  });
  const now = segments.find((segment) => segment.state === 'current');
  return { segments, todayAt: todayOn(segments, now, today, total) };
}

/** A work waiting on its marked phase stays in that phase's column; only a work with nothing begun is in Intake. */
function columnOfWork(closed: boolean, intake: boolean, at: WorkplanPhase | undefined): PipelineColumn | null {
  if (closed) return null;
  if (intake) return 'Intake';
  return at ? columnOf(at) : 'Review';
}

/** The open phase Track marks current once it has started, else the first open started phase; `marked` either way. */
function currentOf(open: WorkplanPhase[], today: string) {
  const marked = open.find((phase) => phase.isCurrent === true);
  // Track moves its current phase id when the previous phase completes, before the next one starts.
  const current = (marked && hasStarted(marked, today) ? marked : open.find((p) => hasStarted(p, today))) ?? null;
  return { marked, current };
}

function rowOf(work: WorkplanRow, project: Project | undefined, today: string): WorkRow {
  const phases = phasesInOrder(work.phases);
  const { closed, inactive } = closureOf(work, today);
  const open = closed ? [] : phases.filter((phase) => !phase.isCompleted);
  const { marked, current } = currentOf(open, today);
  const starts = [startBound(work.startDate, work.undated), ...phases.map((p) => startBound(p.startDate, p.undated))];
  const nothingBegun = !closed && starts.every((start) => start === null || start > today);
  const notStarted = nothingBegun || (!closed && current === null && marked !== undefined);
  const unknown = !closed && current !== null && (hasNoEnd(work, current) || endsBeforeStart(current));
  const suspension = suspensionOf(current, today);
  const measured = progressOf(current, today, suspension.suspendedSince);
  const progress = inactive ? { ...measured, bar: null, overdue: false, daysOver: 0, overrun: null } : measured;
  const decisionDate = decisionOf(work, phases, closed);
  const next = closed || inactive || unknown ? null : nextOf(phases, today, decisionDate);
  const state = { closed, notStarted, current, phases, next, overdue: progress.overdue };
  return {
    work,
    region: project?.region ?? null,
    ...state,
    ...progress,
    ...suspension,
    decisionDate,
    decisionExpected: !work.decisionDate && decisionDate !== null,
    status: statusOf({ ...state, inactive, unknown }),
    column: columnOfWork(closed, nothingBegun, current ?? marked ?? open[0]),
    ...lifecycleOf(phases, current, progress.overrun?.end ?? null, today),
  };
}

/** Each work's state on `today` (an ISO day, `YYYY-MM-DD`), with region from its project. */
export function rowsOf(works: WorkplanRow[], projects: Project[], today: string): WorkRow[] {
  const byId = new Map(projects.map((project) => [String(project.id), project]));
  return works.map((work) => rowOf(work, byId.get(String(work.projectId)), today));
}

const TIER: Record<WorkStatus, number> = {
  overdue: 0,
  'next-30': 1,
  'on-track': 1,
  'not-started': 2,
  unknown: 3,
  inactive: 3,
  closed: 4,
};

/** Attention order: overdue, most days over first; then soonest next milestone; not started; unknown and inactive; closed last. */
export function byAttention(a: WorkRow, b: WorkRow): number {
  const weight = (row: WorkRow) => (row.overdue ? -row.daysOver : (row.next?.inDays ?? Infinity));
  return (
    TIER[a.status] - TIER[b.status] ||
    weight(a) - weight(b) ||
    (a.work.title ?? '').localeCompare(b.work.title ?? '')
  );
}
