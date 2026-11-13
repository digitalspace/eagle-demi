'use strict';

// Project values built from a project's works, of any source. Pure.

const { isRegistryYear } = require('../domain/project-legislation');
const { dayOf, transitionDateOf } = require('../domain/work-model');
const { byIdsDesc, isAssessmentWork, isTrackWork, pickAssessmentWork, workActYear } = require('./assessment-work');

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
 * One `{fromYear, toYear, date}` per change of Act in Eagle's year list or a work's `transitionOut`; a pair
 * a work holds takes its `publicWorksOf` date, any other Track's milestone naming `fromYear`, else null.
 */
function legislationTransitions(yearList, works) {
  const listed = worksOf({ works });
  const years = [...new Set((Array.isArray(yearList) ? yearList : []).map(Number))]
    .filter(Number.isInteger)
    .sort((a, b) => a - b);
  const pairs = years.slice(1).map((toYear, i) => ({ fromYear: years[i], toYear }));
  const handOvers = listed.map(handOverOf).filter(Boolean);
  const samePair = (a, b) => a.fromYear === b.fromYear && a.toYear === b.toYear;
  for (const { fromYear, toYear } of handOvers) {
    if (!pairs.some(pair => samePair(pair, { fromYear, toYear }))) pairs.push({ fromYear, toYear });
  }
  pairs.sort((a, b) => a.fromYear - b.fromYear || a.toYear - b.toYear);

  // publicWorksOf already resolved a held date with transitionDateOf; a rerun would drop a 2025 sheet fallback.
  const dateOf = (pair) => handOvers.filter(held => samePair(held, pair)).map(held => dayOf(held.out.date)).find(Boolean) ??
    transitionDateOf(NO_TRANSITION_OUT, listed, pair.fromYear);
  return pairs.map(pair => ({ ...pair, date: dateOf(pair) }));
}

const namedPhases = (phases) =>
  (Array.isArray(phases) ? phases : []).filter(phase => phase && typeof phase.name === 'string' && phase.name);

/**
 * Each assessment phase as `{ phase, year, work }`: the phases of each Act's picked Assessment work, else the
 * row's own `phases` under the Act each names.
 */
function trackPhasesOf(view, yearOfTrack) {
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

module.exports = { legislationTransitions, worksOf, trackPhasesOf, activeWorkOf };
