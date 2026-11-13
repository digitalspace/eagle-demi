'use strict';

// Which Assessment work stands for a project, so every reader of its phases picks the same one.

const { LEGISLATIONS, isRegistryYear } = require('../domain/project-legislation');

const ASSESSMENT_WORK_TYPE = 6;
// Track holds only the 2018 Act.
const TRACK_ACT_YEAR = 2018;

/** The Act a label such as "2018 Act" names: the exact label, else the whole year in it. */
function actYearOf(label) {
  if (typeof label !== 'string' || !label) return null;
  const exact = Object.keys(LEGISLATIONS).find(year => LEGISLATIONS[year].label === label);
  if (exact) return Number(exact);
  const year = Number((/\b(19|20)\d{2}\b/.exec(label) || [])[0]);
  return isRegistryYear(year) ? year : null;
}

/** A public work whose `source` is track, or a row work from Track's pull, which carries no `source`. */
const isTrackWork = (work) => work.source === undefined || work.source === null || work.source === 'track';

/** The work's `actYear`, else the Act its `eaAct` names; only a Track work naming none is under the Track Act. */
function workActYear(work) {
  if (isRegistryYear(work.actYear)) return work.actYear;
  return actYearOf(work.eaAct) ?? (isTrackWork(work) ? TRACK_ACT_YEAR : null);
}

/** An Assessment by `workTypeCode`; a Track work with no code by its Track work type. */
const isAssessmentWork = (work) => (typeof work.workTypeCode === 'string'
  ? work.workTypeCode === 'assessment'
  : isTrackWork(work) && work.workTypeId === ASSESSMENT_WORK_TYPE);

/** Start time in ms; a work with no start sorts before every dated one. */
function startOf(work) {
  const time = new Date(work.startDate ?? NaN).getTime();
  return Number.isNaN(time) ? -Infinity : time;
}

const idOf = (work) => String(work.workId ?? work.id ?? '');

/** The highest Track work id first, then the highest work id. */
const byIdsDesc = (a, b) => (Number(b.trackWorkId) || 0) - (Number(a.trackWorkId) || 0) ||
  (idOf(b) > idOf(a)) - (idOf(b) < idOf(a));

/**
 * Among the Assessment works, under the `year` Act when given: the active one, else the latest
 * start, ties by `byIdsDesc`. Null when there is none.
 */
function pickAssessmentWork(works, { year } = {}) {
  const candidates = (Array.isArray(works) ? works : []).filter(work => work && typeof work === 'object' &&
    isAssessmentWork(work) && (year === undefined || workActYear(work) === Number(year)));
  // Two missing starts give NaN, which falls through `||` to the ids.
  candidates.sort((a, b) => (b.isActive === true) - (a.isActive === true) || startOf(b) - startOf(a) ||
    byIdsDesc(a, b));
  return candidates[0] ?? null;
}

module.exports = {
  ASSESSMENT_WORK_TYPE, TRACK_ACT_YEAR, actYearOf, byIdsDesc, isAssessmentWork, isTrackWork, pickAssessmentWork,
  workActYear
};
