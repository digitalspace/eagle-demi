'use strict';

const config = require('../config');
const phaseCatalog = require('./phase-catalog');
const works = require('../repositories/works');
const { logger } = require('../utils/logger');
const { publicWorksOf } = require('../seed/track-mappers');
const {
  OVERRIDE_MARKER_ID, hiddenByOverride, listOf, overrideShown, sourceOf, validateMarker
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
  const { boundary, shownSheetIds } = overrideShown(stored.filter(work => sourceOf(work) === 'sheet'), trackWorks, marker);
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

/** The public `title` and dates of `trackWorkId` among `publicWorks`; nulls when it is not stored. */
function trackSummaryOf(publicWorks, trackWorkId) {
  const work = publicWorks.find(candidate => candidate.workId === trackWorkId);
  return { workId: trackWorkId, title: work?.title ?? null, startDate: work?.startDate ?? null, decisionDate: work?.decisionDate ?? null };
}

/**
 * Every live sheet work in public shape, hidden or not, marked as a read with WORKS_READ_SOURCES
 * `track,sheet` would treat it. Staff only; the public read never calls this.
 */
async function sheetWorksOf(row) {
  const loaded = await phaseCatalog.load();
  const catalog = Object.values(loaded).some(entries => entries.length) ? loaded : undefined;
  const stored = await works.listForRead(row.id);
  const marker = await markerOf(row.id);
  const bySource = source => stored.filter(work => sourceOf(work) === source);
  const { boundary, shownSheetIds } = overrideShown(bySource('sheet'), bySource('track'), marker);
  const overrideActive = marker?.active === true;
  // Built over every work so a sheet work's transitionOut resolves against Track's milestones.
  const publicWorks = publicWorksOf(stored, row, { catalog });
  const sheetWorks = publicWorks.filter(work => work.source === 'sheet').map(work => ({
    ...work,
    shownAfterFlip: shownSheetIds.has(work.workId),
    untilTrack: listOf(marker?.untilTrack).includes(work.workId),
    replaces: listOf(marker?.hidden).filter(pair => pair.sheetWorkId === work.workId)
      .map(pair => trackSummaryOf(publicWorks, pair.trackWorkId))
  }));
  return { overrideActive, boundary: overrideActive ? boundary : null, works: sheetWorks };
}

module.exports = { deriveInputs, loadWorks, sheetWorksOf };
