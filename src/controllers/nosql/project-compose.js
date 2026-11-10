'use strict';

// A project's `works` and `phases` from the works container, read after the row passed canRead.

const worksDerive = require('../../domain/works-derive');
const { deriveAssessments } = require('../../merge/assessments');
const { pickAssessmentWork } = require('../../merge/assessment-work');

/** Derive inputs per try, so a retry after a lost race reads the works again; a push creating its row has none. */
const deriveInputs = async (row) => (row ? worksDerive.deriveInputs(row) : {});

/** Track keeps no planned-versus-actual split on a phase, so both are read off its dates and completion. */
const withPlanned = (phase, now) => ({
  ...phase,
  startPlanned: phase.isCompleted !== true && Date.parse(phase.startDate) > now,
  endPlanned: phase.isCompleted !== true
});

/**
 * `row` with `works` swapped for `worksForDerive`, and `phases` for the picked Assessment work's, as the nightly
 * stores them. No works leaves the row as stored, as the nightly leaves a row Track holds none for.
 */
function composedRow(row, worksForDerive, now = Date.now()) {
  if (!Array.isArray(worksForDerive) || !worksForDerive.length) return row;
  const works = worksForDerive.map(work => ({ ...work, phases: work.phases.map(phase => withPlanned(phase, now)) }));
  const picked = pickAssessmentWork(works);
  return { ...row, works, ...(picked && picked.phases.length ? { phases: picked.phases } : {}) };
}

/** The row the project GET answers from; untouched while WORKS_READ is off. */
async function composeWorks(row) {
  const { worksForDerive } = await deriveInputs(row);
  return worksForDerive ? composedRow(row, worksForDerive) : row;
}

/** Assigns `assessments`, `phaseIds` and `activeWork` onto a staff save's `row`, from the works read now. */
async function derivedFor(row, current) {
  return Object.assign(row, deriveAssessments(row, { previous: current.assessments, ...await deriveInputs(row) }));
}

module.exports = { composeWorks, composedRow, derivedFor, deriveInputs };
