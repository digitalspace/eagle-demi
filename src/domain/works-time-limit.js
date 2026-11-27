'use strict';

// Pure: the caller supplies `today` (`YYYY-MM-DD`), so a running phase's count does not hang on the clock.

const { dayOf, daysBetween } = require('./work-model');

const DAY_MS = 86400000;
const OPEN_WORK_STATES = new Set(['in-progress', 'IN_PROGRESS', 'suspended', 'SUSPENDED']);
const EXTRA_TIME = 'Extra Time';

const plusDays = (day, days) => new Date(Date.parse(day) + days * DAY_MS).toISOString().slice(0, 10);

/** A work Track switched off, or one that is closed, runs no phase to today. */
const isRunningWork = (work) =>
  OPEN_WORK_STATES.has(work.workState) && !(work.source === 'track' && work.isActive === false);

// The 2002 sheet import ends Evaluation on the next phase's start, which holds proponent time unless
// an Extra Time phase follows it.
const endKnownOf = (work, phases, i) => !(work.source === 'sheet' && work.actYear === 2002
  && phases[i].name === 'Evaluation' && phases[i + 1]?.name !== EXTRA_TIME);

/** True when phase `i` starts back to back with a legislated phase before it whose end is known. */
function startsOnDayOne(work, phases, i) {
  const before = phases[i - 1];
  const end = dayOf(before?.endDate);
  if (!before?.legislated || !end || !endKnownOf(work, phases, i - 1)) return false;
  const start = dayOf(phases[i].startDate);
  // Sheet phases end on the next start; Track starts the next phase the day after the end.
  return start === end || (work.source === 'track' && start === plusDays(end, 1));
}

/**
 * The open suspension of a running phase, from Track's flag or else a suspension interruption covering today: `since`
 * the day it began, and `days` the sheet interruption's own days, which `suspendedDays` holds. Null when none is open.
 */
function heldOf(work, phase, start, today) {
  const covering = (phase.interruptions || []).find(stop => {
    const from = dayOf(stop.startDate);
    const to = dayOf(stop.endDate);
    return stop.kind === 'suspension' && from !== null && from <= today && (to === null || to >= today);
  });
  const flagged = phase.isSuspended === true;
  const began = flagged ? (dayOf(phase.suspendedDate) ?? today) : dayOf(covering?.startDate);
  if (began === null) return null;
  return { since: start > began ? start : began, days: flagged || work.source === 'track' ? 0 : covering.days ?? 0 };
}

/** Days counted to the end, or while it runs to today or the start of its open suspension; 0 before it starts. */
function countOf(work, phase, start, today, offset) {
  const running = !phase.isCompleted && isRunningWork(work) && phase.isCurrent !== false;
  const held = running ? heldOf(work, phase, start, today) : null;
  if (phase.suspendedDays == null) return { countedDays: null, held };
  if (!phase.isCompleted && start > today) return { countedDays: 0, held };
  const countTo = phase.isCompleted ? dayOf(phase.endDate) : running && (held?.since ?? today);
  if (!countTo || countTo < start) return { countedDays: null, held };
  return { countedDays: daysBetween(start, countTo) - (phase.suspendedDays - (held?.days ?? 0)) + offset, held };
}

const hasExtensionOf = (work, phase) => (work.source === 'track'
  ? phase.extensionDays > 0
  : (phase.interruptions || []).some(entry => entry.kind === 'extension'));

function timeLimitOf(work, phases, i, today) {
  const phase = phases[i];
  const start = dayOf(phase.startDate);
  if (!phase.legislated || phase.numberOfDays == null || !start) return null;
  const one = startsOnDayOne(work, phases, i);
  const offset = one ? 1 : 0;
  const { extensionDays, suspendedDays } = phase;
  const allowedDays = extensionDays == null ? null : phase.numberOfDays + extensionDays;
  const deadline = allowedDays == null || suspendedDays == null ? null : plusDays(start, allowedDays + suspendedDays - offset);
  const { countedDays, held } = countOf(work, phase, start, today, offset);
  const end = dayOf(phase.endDate);
  const endKnown = endKnownOf(work, phases, i);
  const over = countedDays == null || allowedDays == null || !endKnown ? null : countedDays - allowedDays;
  const finished = Boolean(phase.isCompleted && end && end >= start);
  // A recorded extension covers a finished phase even when its day count is unknown.
  const coveredByExtension = finished && endKnown && (allowedDays == null || over > 0) && hasExtensionOf(work, phase);
  // A held phase is never over, as on the Workplans screen.
  const overDays = over == null ? null : held ? 0 : Math.max(0, over);
  return { dayCount: one ? 'one' : 'zero', allowedDays, deadline, countedDays, overDays, endKnown, coveredByExtension };
}

/**
 * The `timeLimit` of each of `phases`, in order: null unless the phase is legislated with a day budget and a start.
 * `work` gives `source`, `actYear`, `workState` and `isActive`; `phases` are the work's Workplans phases in order.
 */
const timeLimitsOf = (work, phases, today) => phases.map((_, i) => timeLimitOf(work, phases, i, today));

module.exports = { timeLimitsOf };
