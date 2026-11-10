'use strict';

const config = require('../config');
const phaseCatalog = require('./phase-catalog');
const works = require('../repositories/works');
const { publicWorksOf } = require('../seed/track-mappers');

/**
 * Options to spread into deriveAssessments and the merges: `{}` while WORKS_READ is off, so they
 * read `row.works`. An empty catalog goes as undefined so the phase name rules still apply.
 */
async function deriveInputs(row) {
  if (!config.worksRead) return {};
  const loaded = await phaseCatalog.load();
  const catalog = Object.values(loaded).some(entries => entries.length) ? loaded : undefined;
  return { worksForDerive: publicWorksOf(await works.listByProject(row.id), row, { catalog }), catalog };
}

module.exports = { deriveInputs };
