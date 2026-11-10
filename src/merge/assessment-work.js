'use strict';

// Which Track Assessment work stands for a project, so every reader of its phases picks the same one.

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

/** The Act a Track work is under; one naming none is under the Track Act. */
const workActYear = (work) => actYearOf(work.eaAct) ?? TRACK_ACT_YEAR;

/** Start time in ms; a work with no start sorts before every dated one. */
function startOf(work) {
  const time = new Date(work.startDate ?? NaN).getTime();
  return Number.isNaN(time) ? -Infinity : time;
}

/**
 * Among the Assessment works, under the `year` Act when given: the active one, else the latest
 * start, ties to the highest Track work id. Null when there is none.
 */
function pickAssessmentWork(works, { year } = {}) {
  const candidates = (Array.isArray(works) ? works : []).filter(work => work && typeof work === 'object' &&
    work.workTypeId === ASSESSMENT_WORK_TYPE && (year === undefined || workActYear(work) === Number(year)));
  // Two missing starts give NaN, which falls through `||` to the id.
  candidates.sort((a, b) => (b.isActive === true) - (a.isActive === true) || startOf(b) - startOf(a) ||
    (Number(b.trackWorkId) || 0) - (Number(a.trackWorkId) || 0));
  return candidates[0] ?? null;
}

module.exports = { ASSESSMENT_WORK_TYPE, TRACK_ACT_YEAR, actYearOf, workActYear, pickAssessmentWork };
