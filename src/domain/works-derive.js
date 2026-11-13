'use strict';

const config = require('../config');
const phaseCatalog = require('./phase-catalog');
const works = require('../repositories/works');
const { publicWorksOf } = require('../seed/track-mappers');
const {
  OVERRIDE_MARKER_ID, hiddenByOverride, overrideBoundaryOf, untilTrackHidden, validateMarker
} = require('./work-model');
const { sourceOf } = require('./work-override');

/**
 * Options to spread into deriveAssessments and the merges: `{}` while WORKS_READ is off, so they
 * read `row.works`. An empty catalog goes as undefined so the phase name rules still apply.
 */
async function deriveInputs(row) {
  if (!config.worksRead) return {};
  return loadWorks(row, { sources: config.worksReadSources });
}

/** The project's override marker, or null when it is absent or fails the validator. */
async function markerOf(projectId) {
  const marker = await works.get(projectId, OVERRIDE_MARKER_ID);
  return marker && validateMarker(marker).ok ? marker : null;
}

/** `stored` less what the sheet override hides: sheet works first, then Track works paired with a shown one. */
function withOverride(stored, marker) {
  const trackWorks = stored.filter(work => sourceOf(work) === 'track');
  // listForRead drops sourceKey, so untilTrackHidden breaks a tie by input order; id order keeps it stable.
  const sheetWorks = stored.filter(work => sourceOf(work) === 'sheet')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const boundary = overrideBoundaryOf(trackWorks);
  const replaced = untilTrackHidden(sheetWorks, trackWorks, marker);
  const shownSheetIds = new Set(sheetWorks
    .filter(work => !replaced.has(work.id) && !hiddenByOverride(work, marker, boundary, []))
    .map(work => work.id));
  return stored.filter(work => (sourceOf(work) === 'sheet'
    ? shownSheetIds.has(work.id)
    : !hiddenByOverride(work, marker, boundary, shownSheetIds)));
}

/** `deriveInputs` whatever WORKS_READ says, keeping only works whose source is in `sources`. */
async function loadWorks(row, { sources = ['track'] } = {}) {
  const loaded = await phaseCatalog.load();
  const catalog = Object.values(loaded).some(entries => entries.length) ? loaded : undefined;
  let stored = await works.listForRead(row.id);
  if (sources.includes('sheet')) stored = withOverride(stored, await markerOf(row.id));
  const kept = stored.filter(work => sources.includes(sourceOf(work)));
  return { worksForDerive: publicWorksOf(kept, row, { catalog }), catalog };
}

module.exports = { deriveInputs, loadWorks };
