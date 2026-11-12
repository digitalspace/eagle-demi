'use strict';

// Project values built from Track works. Pure.

const { ASSESSMENT_WORK_TYPE, workActYear, pickAssessmentWork } = require('./assessment-work');

const TRANSITION_MILESTONE = 'Project Transitioning FROM';

const isDated = (value) => value !== undefined && value !== null && String(value).trim() !== '';

/**
 * One `{fromYear, toYear, date}` per change of Act. Eagle stores no date, so it comes from Track's
 * optional "Project Transitioning FROM the EA Act (2002)" milestone, matched on the year it names.
 */
function legislationTransitions(yearList, works) {
  const years = [...new Set((Array.isArray(yearList) ? yearList : []).map(Number))]
    .filter(Number.isInteger)
    .sort((a, b) => a - b);
  const pairs = years.slice(1).map((toYear, i) => ({ fromYear: years[i], toYear }));

  const dateByFromYear = new Map();
  for (const work of works) {
    if (!work || work.workTypeId !== ASSESSMENT_WORK_TYPE || !Array.isArray(work.milestones)) continue;
    for (const milestone of work.milestones) {
      if (!milestone || typeof milestone.name !== 'string' ||
          !milestone.name.startsWith(TRANSITION_MILESTONE) || !isDated(milestone.actualDate)) continue;
      const year = Number((/\b(\d{4})\b/.exec(milestone.name) || [])[1]);
      if (year && !dateByFromYear.has(year)) dateByFromYear.set(year, milestone.actualDate);
    }
  }

  return pairs.map(pair => ({ ...pair, date: dateByFromYear.get(pair.fromYear) ?? null }));
}

const worksOf = (view) =>
  (Array.isArray(view.works) ? view.works : []).filter(work => work && typeof work === 'object');

const namedPhases = (phases) =>
  (Array.isArray(phases) ? phases : []).filter(phase => phase && typeof phase.name === 'string' && phase.name);

/**
 * Each Track phase as `{ phase, year, work }`: the phases of each Act's picked Assessment work, else the
 * row's own `phases` under the Act each names.
 */
function trackPhasesOf(view, yearOfTrack) {
  const works = worksOf(view);
  const years = [...new Set(works.filter(work => work.workTypeId === ASSESSMENT_WORK_TYPE).map(workActYear))]
    .sort((a, b) => a - b);
  const fromWorks = years.map(year => pickAssessmentWork(works, { year }))
    .flatMap(work => namedPhases(work.phases).map(phase => ({ phase, year: workActYear(work), work })));
  return fromWorks.length ? fromWorks
    : namedPhases(view.phases).map(phase => ({ phase, year: yearOfTrack(phase.eaActName), work: null }));
}

/**
 * The live work with a Track id, the picked Assessment work first, then the newest; null when there is none.
 * Its phase is Eagle's current phase name when the work is under the current Act, else its first open phase.
 */
function activeWorkOf(view, current) {
  const live = worksOf(view).filter(one => one.isActive === true && Number.isFinite(one.trackWorkId));
  const work = pickAssessmentWork(live) ?? live.sort((a, b) => b.trackWorkId - a.trackWorkId)[0];
  if (!work) return null;
  const open = (Array.isArray(work.phases) ? work.phases : []).find(phase => phase && phase.isCompleted !== true);
  // Not the row's Track Act: its current-block fallback would hand a work with no Act another Act's Eagle phase.
  const workYear = workActYear(work);
  const eaglePhase = current && current.currentPhase && workYear === current.legislationYear
    ? current.currentPhase.name : null;
  return {
    trackWorkId: work.trackWorkId,
    eaAct: work.eaAct ?? null,
    workType: work.workType ?? null,
    currentPhase: eaglePhase || (open && open.name) || null
  };
}

module.exports = { TRANSITION_MILESTONE, legislationTransitions, worksOf, trackPhasesOf, activeWorkOf };
