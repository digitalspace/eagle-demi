'use strict';

const config = require('../config');
const phaseCatalog = require('./phase-catalog');
const works = require('../repositories/works');
const { logger } = require('../utils/logger');
const { publicWorksOf } = require('../seed/track-mappers');
const {
  OVERRIDE_MARKER_ID, compareText, hiddenByOverride, overrideBoundaryOf, sourceOf, untilTrackHidden, validateMarker
} = require('./work-model');

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
  if (!marker) return null;
  const checked = validateMarker(marker);
  if (checked.ok) return marker;
  logger.warn('[works] override marker refused, read as missing', { projectId, paths: checked.errors.map(e => e.path) });
  return null;
}

/**
 * `stored` less what the sheet override hides: sheet works first, then Track works paired with a shown one.
 * Track works move the boundary and replace untilTrack works only when listed, so an event never shows nowhere.
 */
function withOverride(stored, marker, sources) {
  const trackWorks = sources.includes('track') ? stored.filter(work => sourceOf(work) === 'track') : [];
  // listForRead drops sourceKey, so untilTrackHidden breaks a tie by input order; id order keeps it stable.
  const sheetWorks = stored.filter(work => sourceOf(work) === 'sheet').sort((a, b) => compareText(a.id, b.id));
  const boundary = overrideBoundaryOf(trackWorks);
  const replaced = untilTrackHidden(sheetWorks, trackWorks, marker);
  const shownSheetIds = new Set(sheetWorks
    .filter(work => !replaced.has(work.id) && !hiddenByOverride(work, marker, boundary, []))
    .map(work => work.id));
  return stored.filter(work => (sourceOf(work) === 'sheet'
    ? shownSheetIds.has(work.id)
    : !hiddenByOverride(work, marker, boundary, shownSheetIds)));
}

/** The works of `sources` in public shape; `deriveInputs` passes WORKS_READ_SOURCES, `loadWorks(row)` reads Track only. */
async function loadWorks(row, { sources = ['track'] } = {}) {
  const loaded = await phaseCatalog.load();
  const catalog = Object.values(loaded).some(entries => entries.length) ? loaded : undefined;
  let stored = await works.listForRead(row.id);
  if (sources.includes('sheet')) stored = withOverride(stored, await markerOf(row.id), sources);
  const kept = stored.filter(work => sources.includes(sourceOf(work)));
  return { worksForDerive: publicWorksOf(kept, row, { catalog }), catalog };
}

module.exports = { deriveInputs, loadWorks };
