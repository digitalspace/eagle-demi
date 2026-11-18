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

/** `marker`, or null when it is absent or fails the validator. */
function checkedMarker(projectId, marker) {
  if (!marker) return null;
  const checked = validateMarker(marker);
  if (checked.ok) return marker;
  logger.warn('[works] override marker refused, read as missing', { projectId, paths: checked.errors.map(e => e.path) });
  return null;
}

/** The project's override marker, or null when it is absent or fails the validator. */
async function markerOf(projectId) {
  return checkedMarker(projectId, await works.get(projectId, OVERRIDE_MARKER_ID));
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

/** The phase catalog, or undefined when it holds no entries so the phase name rules still apply. */
async function catalogOf() {
  const loaded = await phaseCatalog.load();
  return Object.values(loaded).some(entries => entries.length) ? loaded : undefined;
}

/** The works of `sources` in public shape; `deriveInputs` passes WORKS_READ_SOURCES, `loadWorks(row)` reads Track only. */
async function loadWorks(row, { sources = ['track'] } = {}) {
  const catalog = await catalogOf();
  let stored = await works.listForRead(row.id);
  if (sources.includes('sheet')) stored = withOverride(stored, await markerOf(row.id), sources);
  const kept = stored.filter(work => sources.includes(sourceOf(work)));
  return { worksForDerive: publicWorksOf(kept, row, { catalog }), catalog };
}

const trackSummaryOf = ({ workId, title, startDate, decisionDate }) => ({ workId, title, startDate, decisionDate });

/**
 * Every live sheet work in public shape, hidden or not, marked as a read with WORKS_READ_SOURCES
 * `track,sheet` would treat it. Staff only; the public read never calls this.
 */
async function sheetWorksOf(row) {
  const catalog = await catalogOf();
  const stored = await works.listForRead(row.id);
  return sheetWorksFrom(stored, await markerOf(row.id), row, catalog);
}

/**
 * Every live work in public shape, each marked with `shownAfterFlip`, `untilTrack` and `replaces` as a read
 * with WORKS_READ_SOURCES `track,sheet` would treat it; a Track work never replaces and is never untilTrack.
 */
function markedWorksFrom(stored, marker, row, catalog) {
  const bySource = source => stored.filter(work => sourceOf(work) === source);
  const { boundary, shownSheetIds } = overrideShown(bySource('sheet'), bySource('track'), marker);
  const overrideActive = marker?.active === true;
  const hiddenTrackIds = new Set(bySource('track')
    .filter(work => hiddenByOverride(work, marker, boundary, shownSheetIds)).map(work => work.id));
  // Built over every work so a sheet work's transitionOut resolves against Track's milestones.
  const publicWorks = publicWorksOf(stored, row, { catalog });
  const publicById = new Map(publicWorks.map(work => [work.workId, work]));
  const marked = publicWorks.map(work => (work.source === 'sheet' ? {
    ...work,
    shownAfterFlip: shownSheetIds.has(work.workId),
    untilTrack: listOf(marker?.untilTrack).includes(work.workId),
    replaces: listOf(marker?.hidden)
      .filter(pair => pair.sheetWorkId === work.workId && hiddenTrackIds.has(pair.trackWorkId))
      .map(pair => trackSummaryOf(publicById.get(pair.trackWorkId)))
  } : { ...work, shownAfterFlip: !hiddenTrackIds.has(work.workId), untilTrack: false, replaces: [] }));
  return { overrideActive, boundary: overrideActive ? boundary : null, works: marked };
}

/** `sheetWorksOf` over the project's live works `stored` and its checked `marker`. */
function sheetWorksFrom(stored, marker, row, catalog) {
  const marked = markedWorksFrom(stored, marker, row, catalog);
  return { ...marked, works: marked.works.filter(work => work.source === 'sheet') };
}

/** The panel's per-Act counts and pills: `hidden + replaces + untilTrack` is the number of pills it draws. */
function sheetCountsOf(sheetWorks) {
  const count = test => sheetWorks.filter(test).length;
  return {
    act1996: count(work => work.actYear === 1996),
    act2002: count(work => work.actYear === 2002),
    hidden: count(work => !work.shownAfterFlip),
    replaces: count(work => work.shownAfterFlip && work.replaces.length > 0),
    untilTrack: count(work => work.shownAfterFlip && work.replaces.length === 0 && work.untilTrack)
  };
}

/** Largest id list one cross-partition IN query takes. */
const ID_BATCH = 200;

/** Each of `rows` with its live works and checked override marker; one works query and one marker query per ID_BATCH rows. */
async function storedAcross(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i += ID_BATCH) {
    const batch = rows.slice(i, i + ID_BATCH);
    const ids = batch.map(row => String(row.id));
    const storedOf = Map.groupBy(await works.listForReadAcross(ids), work => String(work.projectId));
    const markers = new Map((await works.getEach(ids, OVERRIDE_MARKER_ID)).map(doc => [String(doc.projectId), doc]));
    out.push(...batch.map((row) => {
      const projectId = String(row.id);
      return { row, projectId, stored: storedOf.get(projectId) || [], marker: checkedMarker(projectId, markers.get(projectId)) };
    }));
  }
  return out;
}

const byProjectId = (a, b) => (a.projectId < b.projectId ? -1 : Number(a.projectId > b.projectId));

/** `sheetCountsOf` each of `rows` with a live sheet work, sorted by `projectId`. */
async function sheetWorksSummaryOf(rows) {
  if (!rows.length) return [];
  const catalog = await catalogOf();
  return (await storedAcross(rows)).flatMap(({ row, projectId, stored, marker }) => {
    const sheet = sheetWorksFrom(stored, marker, row, catalog).works;
    return sheet.length ? [{ projectId, ...sheetCountsOf(sheet) }] : [];
  }).sort(byProjectId);
}

const WORKPLAN_KEYS = ['workId', 'source', 'title', 'workTypeCode', 'workType', 'actYear', 'workState', 'isActive',
  'startDate', 'decisionDate', 'anticipatedDecisionDate', 'outcome', 'transitionOut', 'undated',
  'shownAfterFlip', 'untilTrack', 'replaces'];
const PHASE_KEYS = ['name', 'stage', 'order', 'startDate', 'endDate', 'numberOfDays', 'isCompleted', 'isSuspended', 'undated'];
const INTERRUPTION_KEYS = ['kind', 'legalSection', 'startDate', 'endDate', 'days'];

const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));

const workplanOf = (projectId, projectName, work) => ({
  projectId,
  projectName,
  ...pick(work, WORKPLAN_KEYS),
  phases: work.phases.map(phase => ({
    ...pick(phase, PHASE_KEYS), interruptions: phase.interruptions.map(entry => pick(entry, INTERRUPTION_KEYS))
  }))
});

/**
 * Every live work, Track and sheet, of each of `rows` in the slim Workplans shape, sorted by `projectId`.
 * Staff only; reads no WORKS_READ_SOURCES, so the public read cannot change through it.
 */
async function workplansOf(rows) {
  if (!rows.length) return [];
  const catalog = await catalogOf();
  return (await storedAcross(rows)).sort(byProjectId).flatMap(({ row, projectId, stored, marker }) =>
    markedWorksFrom(stored, marker, row, catalog).works.map(work => workplanOf(projectId, row.name ?? null, work)));
}

module.exports = { ID_BATCH, deriveInputs, loadWorks, sheetWorksOf, sheetWorksSummaryOf, workplansOf };
