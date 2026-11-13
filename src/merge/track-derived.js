'use strict';

// Project values built from a project's works, of any source. Pure.

const { isRegistryYear } = require('../domain/project-legislation');
const { dayOf, transitionDateOf } = require('../domain/work-model');
const {
  TRACK_ACT_YEAR, byIdsDesc, isAssessmentWork, isTrackWork, pickAssessmentWork, workActYear
} = require('./assessment-work');

const NO_TRANSITION_OUT = Object.freeze({ dateSource: 'none' });

const worksOf = (view) =>
  (Array.isArray(view.works) ? view.works : []).filter(work => work && typeof work === 'object');

/** `{fromYear, toYear, out}` for a work that hands over to a later Act; null for any other. */
function handOverOf(work) {
  const out = work.transitionOut;
  if (!out || typeof out !== 'object') return null;
  const fromYear = workActYear(work);
  const toYear = Number(out.toActYear);
  return isRegistryYear(fromYear) && isRegistryYear(toYear) && toYear > fromYear ? { fromYear, toYear, out } : null;
}

/**
 * One `{fromYear, toYear, date}` per held `transitionOut` and per Eagle pair no held pair covers; a held pair
 * takes its `publicWorksOf` date, else Track's milestone naming `fromYear`, else null.
 */
function legislationTransitions(yearList, works) {
  const listed = worksOf({ works });
  const years = [...new Set((Array.isArray(yearList) ? yearList : []).map(Number))]
    .filter(Number.isInteger)
    .sort((a, b) => a - b);
  const handOvers = listed.map(handOverOf).filter(Boolean);
  const samePair = (a, b) => a.fromYear === b.fromYear && a.toYear === b.toYear;
  // A work's record wins: an Eagle pair goes when held pairs chain from its fromYear to its toYear, or
  // when it lies inside one held pair's span.
  const chained = (fromYear, toYear) => handOvers.some(held => held.fromYear === fromYear &&
    (held.toYear === toYear || (held.toYear < toYear && chained(held.toYear, toYear))));
  const spanned = (pair) => handOvers.some(held => held.fromYear <= pair.fromYear && pair.toYear <= held.toYear);
  const pairs = years.slice(1).map((toYear, i) => ({ fromYear: years[i], toYear }))
    .filter(pair => !chained(pair.fromYear, pair.toYear) && !spanned(pair));
  for (const { fromYear, toYear } of handOvers) {
    if (!pairs.some(pair => samePair(pair, { fromYear, toYear }))) pairs.push({ fromYear, toYear });
  }
  pairs.sort((a, b) => a.fromYear - b.fromYear || a.toYear - b.toYear);

  // publicWorksOf already resolved a held date with transitionDateOf; a rerun would drop a 2025 sheet fallback.
  const heldDate = (pair) => handOvers.filter(held => samePair(held, pair)).map(held => dayOf(held.out.date))
    .find(Boolean);
  const dateOf = (pair) => heldDate(pair) ?? transitionDateOf(NO_TRANSITION_OUT, listed, pair.fromYear);
  return pairs.map(pair => ({ ...pair, date: dateOf(pair) }));
}

const namedPhases = (phases) =>
  (Array.isArray(phases) ? phases : []).filter(phase => phase && typeof phase.name === 'string' && phase.name);

/**
 * Each assessment phase as `{ phase, year, work }`: the phases of each Act's picked Assessment work, else the
 * row's own `phases` under the Act each names.
 */
function assessmentPhasesOf(view, yearOfTrack) {
  const works = worksOf(view);
  const years = [...new Set(works.filter(isAssessmentWork).map(workActYear))]
    .filter(year => year !== null)
    .sort((a, b) => a - b);
  const fromWorks = years.map(year => pickAssessmentWork(works, { year }))
    .flatMap(work => namedPhases(work.phases).map(phase => ({ phase, year: workActYear(work), work })));
  return fromWorks.length ? fromWorks
    : namedPhases(view.phases).map(phase => ({ phase, year: yearOfTrack(phase.eaActName), work: null }));
}

/**
 * The id of each work under `year`'s Act, a Track work placed by `yearOfTrack` as `trackWorkIds` places it. A work
 * from Track's pull carries no id, so it reads `track-<trackWorkId>`.
 */
const workIdsOf = (works, year, yearOfTrack) => works
  .filter(work => (isTrackWork(work) ? yearOfTrack(work.eaAct) : workActYear(work)) === year)
  .map(work => work.workId ?? (Number.isFinite(work.trackWorkId) ? `track-${work.trackWorkId}` : null))
  .filter(Boolean);

/** The milestones of the sheet work a 1996 or 2002 block draws its phases from, else none. */
function sheetMilestonesOf(works, year) {
  const work = year < TRACK_ACT_YEAR ? pickAssessmentWork(works, { year }) : null;
  return work && !isTrackWork(work) && Array.isArray(work.milestones) ? work.milestones.filter(Boolean) : [];
}

/**
 * The live work with an id, the picked Assessment work first, then the newest; null when there is none.
 * Its phase is Eagle's current phase name when the work is under the current Act, else its first open phase.
 */
function activeWorkOf(view, current) {
  const live = worksOf(view).filter(one => one.isActive === true &&
    (Number.isFinite(one.trackWorkId) || (typeof one.workId === 'string' && one.workId !== '')));
  const work = pickAssessmentWork(live) ?? live.sort(byIdsDesc)[0];
  if (!work) return null;
  const open = (Array.isArray(work.phases) ? work.phases : []).find(phase => phase && phase.isCompleted !== true);
  // Not the row's Track Act: its current-block fallback would hand a work with no Act another Act's Eagle phase.
  const workYear = workActYear(work);
  const eaglePhase = current && current.currentPhase && workYear === current.legislationYear
    ? current.currentPhase.name : null;
  return {
    trackWorkId: work.trackWorkId ?? null,
    // Track works keep today's public shape; their `trackWorkId` already names them.
    ...(isTrackWork(work) ? {} : { workId: work.workId }),
    eaAct: work.eaAct ?? null,
    workType: work.workType ?? null,
    currentPhase: eaglePhase || (open && open.name) || null
  };
}

module.exports = { legislationTransitions, worksOf, assessmentPhasesOf, sheetMilestonesOf, workIdsOf, activeWorkOf };
