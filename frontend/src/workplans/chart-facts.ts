import type { SheetInterruption, WorkplanPhase, WorkplanRow } from '../api/sheet-works';
import { dayOf, daysBetween, plusDays } from './phase-bounds';

/** Days over a time limit before a phase counts as over; 0 flags it from the first day over. */
export const OVER_LIMIT_GRACE_DAYS = 0;

/** The Overview State filter: all rows, works in progress, or finished works. */
export type RowState = 'any' | 'open' | 'done';
export const DEFAULT_ROW_STATE: RowState = 'any';

export type ActYear = 1996 | 2002 | 2018;
export const ACT_YEARS: readonly ActYear[] = [2018, 2002, 1996];

/** The day each Act came into force; the Overview draws a line there. */
export const ACT_START: Record<ActYear, string> = { 1996: '1995-06-30', 2002: '2002-12-30', 2018: '2019-12-16' };

export type WorkKind = 'assessment' | 'amendment' | 'eac-extension' | 'substantial-start' | 'other';

const NAMED_KINDS = new Set<string>(['assessment', 'amendment', 'eac-extension', 'substantial-start']);

/** The work type toggle a work falls under; every other type is `other`. */
export const kindOf = (work: Pick<WorkplanRow, 'workTypeCode'>): WorkKind =>
  work.workTypeCode && NAMED_KINDS.has(work.workTypeCode) ? (work.workTypeCode as WorkKind) : 'other';

/** Track states arrive upper case with underscores, sheet states lower case with dashes. */
export const isOpenWork = (work: Pick<WorkplanRow, 'workState'>) =>
  /^(in-progress|IN_PROGRESS|suspended|SUSPENDED)$/.test(work.workState ?? '');

type ClockWork = Pick<WorkplanRow, 'workState' | 'isActive' | 'source' | 'actYear'> & { phases?: readonly WorkplanPhase[] };

/**
 * Proposed rules, Nov 2026, "Counting days": a non-legislated phase counts from Day One, as does a legislated phase
 * that follows a legislated one; a legislated phase after a non-legislated one, or first in its work, counts from Day Zero.
 */
export function countsFromDayOne(phase: WorkplanPhase, phases: readonly WorkplanPhase[] | undefined): boolean {
  if (!phase.legislated) return true;
  const start = dayOf(phase.startDate);
  const before = (phases ?? [])
    .filter((p) => p !== phase && start && (dayOf(p.startDate) ?? '9999') < start)
    .sort((a, b) => ((dayOf(a.startDate) ?? '') < (dayOf(b.startDate) ?? '') ? -1 : 1))
    .at(-1);
  return !!before?.legislated;
}

/** A work in progress that Track switched off: still open, but no phase of it runs to today. */
export const isInactiveWork = (work: ClockWork) => work.source === 'track' && work.isActive === false && isOpenWork(work);

/** The phase Track names as current, or a sheet phase not yet finished; it runs to today only while its work does. */
export const isOpenPhase = (phase: WorkplanPhase) => !phase.isCompleted && phase.isCurrent !== false;

// The import sets this phase's limit but never reads its real end, so the phase runs until the next one starts.
const overUnknown = (phase: WorkplanPhase, work: ClockWork) =>
  work.source === 'sheet' && work.actYear === 2002 && phase.name === 'Evaluation';

const notAfterOf = (holder: { undated: WorkplanRow['undated'] }) => dayOf(holder.undated?.['startDate']?.notAfter);

/** Every day a work names, sorted: its own dates, its phases' and its milestones'. */
export function workDates(work: WorkplanRow): string[] {
  const days = [
    work.startDate,
    work.decisionDate,
    work.decisionEventDate,
    work.transitionOut?.date,
    notAfterOf(work),
    ...work.phases.flatMap((phase) => [phase.startDate, phase.endDate, notAfterOf(phase)]),
    ...(work.milestones ?? []).flatMap((m) => [m.actualDate, m.anticipatedDate, m.endDate]),
  ];
  return days.flatMap((day) => dayOf(day) ?? []).sort();
}

/** The work's start, else its first phase start, else the latest day its undated start can be. */
export function workStartOf(work: WorkplanRow): string | null {
  const phaseStarts = work.phases.flatMap((phase) => dayOf(phase.startDate) ?? []).sort();
  return dayOf(work.startDate) ?? phaseStarts[0] ?? notAfterOf(work);
}

/** The decision day, else the day it moved Act, else its last phase end. */
export function workEndOf(work: WorkplanRow): string | null {
  const phaseEnds = work.phases.flatMap((phase) => dayOf(phase.endDate) ?? []).sort();
  return dayOf(work.decisionDate) ?? dayOf(work.transitionOut?.date) ?? phaseEnds.at(-1) ?? null;
}

/** Day facts of one started phase that is finished or running. */
export interface PhaseDays {
  start: string;
  /** Today while the phase runs. */
  end: string;
  /** Days taken before suspended days come off: start to end, counted the Day Zero or Day One way. */
  length: number;
  /** True when the start day is day 1. */
  dayOne: boolean;
  suspended: number;
  extended: number;
  /** Calendar days less suspended days. */
  counted: number;
  /** True when the limit is set in law; a planned length is never a red mark. */
  legal: boolean;
  /** `numberOfDays`, plus extension days when it is legal; null when the phase has no length. */
  limit: number | null;
  /** Counted days past the limit, 0 when within it, within `OVER_LIMIT_GRACE_DAYS`, or when the data cannot tell. */
  over: number;
  current: boolean;
  /** The day the limit runs out, pushed back by suspended days. */
  limitDate: string | null;
}

// JSON drops an undefined `days`, so a missing key counts the date span; null stays "no days".
function stopDays(stop: SheetInterruption): number {
  if (stop.days !== undefined) return stop.days ?? 0;
  const start = dayOf(stop.startDate);
  const end = dayOf(stop.endDate);
  return start && end ? daysBetween(start, end) : 0;
}

function interruptionDays(stops: SheetInterruption[], suspension: boolean): number {
  return stops
    .filter((stop) => (stop.kind === 'suspension') === suspension)
    .reduce((sum, stop) => sum + stopDays(stop), 0);
}

/** The days a phase counts between, under the same null rules as `phaseDays`. */
function phaseSpan(phase: WorkplanPhase, work: ClockWork, today: string): Pick<PhaseDays, 'start' | 'end' | 'current'> | null {
  const start = dayOf(phase.startDate);
  if (!start || start > today) return null;
  const current = isOpenWork(work) && !isInactiveWork(work) && isOpenPhase(phase);
  if (!current && !phase.isCompleted) return null;
  const end = current ? today : dayOf(phase.endDate);
  if (!end || end < start) return null;
  return { start, end, current };
}

/** Null when the phase has not started by `today`, is neither finished nor running, or ends before it starts. */
export function phaseDays(phase: WorkplanPhase, work: ClockWork, today: string): PhaseDays | null {
  const span = phaseSpan(phase, work, today);
  if (!span) return null;
  const { start, end, current } = span;
  const dayOne = countsFromDayOne(phase, work.phases);
  const length = daysBetween(start, end) + (dayOne ? 1 : 0);
  const suspended = phase.suspendedDays || interruptionDays(phase.interruptions, true);
  const extended = phase.extensionDays || interruptionDays(phase.interruptions, false);
  const counted = length - suspended;
  const legal = Boolean(phase.legislated && phase.numberOfDays);
  const limit = phase.numberOfDays ? phase.numberOfDays + (legal ? extended : 0) : null;
  const past = limit === null ? 0 : counted - limit;
  return {
    start,
    end,
    length,
    dayOne,
    suspended,
    extended,
    counted,
    legal,
    limit,
    // An overage is counted on legislated phases only; a planned length is a forecast, not a limit.
    over: legal && past > OVER_LIMIT_GRACE_DAYS && !overUnknown(phase, work) ? past : 0,
    current,
    // The deadline: start + time allowed + suspended days, minus 1 for a Day One phase.
    limitDate: limit === null ? null : plusDays(start, limit + suspended - (dayOne ? 1 : 0)),
  };
}
