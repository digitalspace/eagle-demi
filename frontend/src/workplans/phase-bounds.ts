import type { Undated, WorkplanPhase } from '../api/sheet-works';

/** `incomplete`: started, not completed, and not the current phase. */
export type PhaseState = 'past' | 'current' | 'incomplete' | 'upcoming';

/** A phase as the Timeline draws it. An approximate bound is a latest-possible day or a neighbour phase's bound. */
export interface DrawnPhase {
  phase: WorkplanPhase;
  state: PhaseState;
  start: string;
  end: string;
  approxStart: boolean;
  approxEnd: boolean;
}

const DAY_MS = 86_400_000;

export const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
export const plusDays = (day: string, days: number) =>
  new Date(Date.parse(day) + days * DAY_MS).toISOString().slice(0, 10);

/** The calendar day of a date-only or ISO timestamp string. */
export const dayOf = (iso: string | null | undefined): string | null => (iso ? iso.slice(0, 10) : null);

/** The start, or the latest day an undated start can be. */
export const startBound = (startDate: string | null, undated: Undated): string | null =>
  dayOf(startDate) ?? dayOf(undated?.['startDate']?.notAfter);

export const hasStarted = (phase: WorkplanPhase, today: string) => {
  const start = startBound(phase.startDate, phase.undated);
  return start !== null && start <= today;
};

export const endsBeforeStart = (phase: WorkplanPhase) => {
  const start = dayOf(phase.startDate);
  const end = dayOf(phase.endDate);
  return start !== null && end !== null && end < start;
};

/** The end day, or null when it falls before the start. */
export const endOf = (phase: WorkplanPhase) => (endsBeforeStart(phase) ? null : dayOf(phase.endDate));

/** The end, or the latest day an undated end can be. */
const endBound = (phase: WorkplanPhase) => endOf(phase) ?? dayOf(phase.undated?.['endDate']?.notAfter);

export function stateOf(phase: WorkplanPhase, current: WorkplanPhase | null, today: string): PhaseState {
  if (phase === current) return 'current';
  if (phase.isCompleted) return 'past';
  return hasStarted(phase, today) ? 'incomplete' : 'upcoming';
}

/** First known day of `days` and whether it is approximate; every entry after the first is. */
function firstKnown(days: (string | null | undefined)[]): { day: string | null; approx: boolean } {
  const at = days.findIndex((day) => day != null);
  return at < 0 ? { day: null, approx: false } : { day: days[at] ?? null, approx: at > 0 };
}

/**
 * Phases in order with a start and end to draw: a missing start falls back to its latest day, then the previous phase's end;
 * a missing end to today on the current phase (real), its latest day, then the next phase's start. End before start: not drawn.
 */
export function drawnPhasesOf(
  row: { phases: WorkplanPhase[]; current: WorkplanPhase | null },
  today: string,
): DrawnPhase[] {
  const { phases, current } = row;
  return phases.flatMap((phase, i) => {
    const before = phases[i - 1];
    const after = phases[i + 1];
    const start = firstKnown([
      dayOf(phase.startDate),
      dayOf(phase.undated?.['startDate']?.notAfter),
      before && endBound(before),
    ]);
    const realEnd = endOf(phase) ?? (phase === current ? today : null);
    const end = firstKnown([
      realEnd,
      dayOf(phase.undated?.['endDate']?.notAfter),
      after && startBound(after.startDate, after.undated),
    ]);
    if (start.day === null || end.day === null || end.day < start.day) return [];
    return [
      {
        phase,
        state: stateOf(phase, current, today),
        start: start.day,
        end: end.day,
        approxStart: start.approx,
        approxEnd: end.approx,
      },
    ];
  });
}
