'use strict';

const config = require('../config');
const phaseCatalog = require('./phase-catalog');
const works = require('../repositories/works');
const { logger } = require('../utils/logger');
const { publicWorksOf } = require('../seed/track-mappers');
const { timeLimitsOf } = require('./works-time-limit');
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
  'startDate', 'decisionDate', 'anticipatedDecisionDate', 'outcome', 'outcomeFrom', 'transitionOut', 'undated',
  'shownAfterFlip', 'untilTrack', 'replaces'];
const PHASE_KEYS = ['name', 'stage', 'order', 'startDate', 'endDate', 'numberOfDays', 'legislated', 'isCompleted',
  'isSuspended', 'suspendedDate', 'undated'];
const INTERRUPTION_KEYS = ['kind', 'typeCode', 'legalSection', 'startDate', 'endDate', 'days'];
const MILESTONE_KEYS = ['name', 'code', 'eventType', 'position', 'actualDate', 'anticipatedDate', 'endDate',
  'numberOfDays', 'outcome'];

// Track event type ids: 10 time limit extension, 11 interregnum (Special Extension category), 12 time limit
// suspension, 38 time limit resumption, 22 comment period, 13-21 the Decision category.
const EXTENSION_EVENT_TYPES = [10, 11];
const SUSPENSION_EVENT_TYPES = [12];
const RESUMPTION_EVENT_TYPES = [38];
const COMMENT_PERIOD_EVENT_TYPES = [22];
const INTERREGNUM_EVENT_TYPE = 11;
const isDecisionEvent = (milestone) => milestone.eventType >= 13 && milestone.eventType <= 21;

// Interregnum counts in the extension totals but draws as its own kind, so it overrides the extension entry.
const TRACK_MILESTONE_KINDS = new Map([[EXTENSION_EVENT_TYPES, 'extension'], [SUSPENSION_EVENT_TYPES, 'suspension'],
  [RESUMPTION_EVENT_TYPES, 'resumption'], [COMMENT_PERIOD_EVENT_TYPES, 'comment-period'],
  [[INTERREGNUM_EVENT_TYPE], 'interregnum']]
  .flatMap(([types, kind]) => types.map(type => [type, kind])));
const SHEET_MILESTONE_KINDS = new Map([['comment-period', 'comment-period'], ['order-variation', 'section-13'],
  ['decision', 'decision'], ['act-transition', 'act-transition']]);

function milestoneKindOf(milestone, track) {
  if (!track) return SHEET_MILESTONE_KINDS.get(milestone.code) ?? 'other';
  if (isDecisionEvent(milestone)) return 'decision';
  return TRACK_MILESTONE_KINDS.get(milestone.eventType) ?? 'other';
}

const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));

/** Days of the stored milestones of `types` that happened, as Track sums them; 0 when none. */
const trackDaysOf = (milestones, types) => milestones
  .filter(m => types.includes(m.eventType) && m.actualDate)
  .reduce((sum, m) => sum + (m.numberOfDays ?? 0), 0);

/** Days of the interruptions of `kind`; 0 when none, null when one of them has no day count. */
function sheetDaysOf(interruptions, kind) {
  const days = interruptions.filter(entry => entry.kind === kind).map(entry => entry.days);
  return days.includes(null) ? null : days.reduce((sum, value) => sum + value, 0);
}

/** The work's last Decision-category event's anticipated date while that event has not happened. */
function decisionEventDateOf(doc) {
  const last = listOf(doc?.phases).flatMap(phase => listOf(phase.milestones)).filter(isDecisionEvent).at(-1);
  return last && !last.actualDate ? last.anticipatedDate ?? null : null;
}

function trackPhaseFieldsOf(phase, doc, storedByTrackId) {
  const milestones = listOf(storedByTrackId.get(phase.trackPhaseId)?.milestones);
  const currentId = doc?.currentWorkPhaseId ?? null;
  return {
    isCurrent: currentId === null ? null : phase.trackPhaseId === currentId,
    extensionDays: trackDaysOf(milestones, EXTENSION_EVENT_TYPES),
    suspendedDays: trackDaysOf(milestones, RESUMPTION_EVENT_TYPES)
  };
}

/** Sheet facts the public shape leaves out, from the stored work; all null on a Track work. */
const sheetDocFieldsOf = (doc) => ({
  certificateKind: doc?.certificateKind ?? null,
  complexityCode: doc?.complexityCode ?? null,
  transitionIn: doc?.transitionIn
    ? { fromActYear: doc.transitionIn.fromActYear ?? null, date: doc.transitionIn.date ?? null }
    : null
});

const sheetPhaseFieldsOf = (phase) => ({
  isCurrent: null,
  extensionDays: sheetDaysOf(phase.interruptions, 'extension'),
  suspendedDays: sheetDaysOf(phase.interruptions, 'suspension')
});

/**
 * `work` in the Workplans shape after `project` (`projectId`, `projectName`, `eagleId`); `doc` is its stored
 * document, read for what the public shape leaves out. `today` (`YYYY-MM-DD`) ends the count of a running phase.
 */
function workplanOf(project, work, doc, today) {
  const track = work.source === 'track';
  const storedByTrackId = new Map(listOf(doc?.phases).map(phase => [phase.trackPhaseId, phase]));
  const phases = work.phases.map(phase => ({
    ...pick(phase, PHASE_KEYS),
    // Track stores the flag as 1.
    legislated: phase.legislated == null ? null : Boolean(phase.legislated),
    ...(track ? trackPhaseFieldsOf(phase, doc, storedByTrackId) : sheetPhaseFieldsOf(phase)),
    interruptions: phase.interruptions.map(entry => pick(entry, INTERRUPTION_KEYS))
  }));
  const timeLimits = timeLimitsOf(work, phases, today);
  return {
    ...project,
    ...pick(work, WORKPLAN_KEYS),
    decisionEventDate: track ? decisionEventDateOf(doc) : null,
    ...sheetDocFieldsOf(track ? null : doc),
    phases: phases.map((phase, i) => ({ ...phase, timeLimit: timeLimits[i] })),
    milestones: work.milestones.map(milestone => ({ ...pick(milestone, MILESTONE_KEYS), kind: milestoneKindOf(milestone, track) }))
  };
}

/**
 * The outcome of a sheet work with none, taken from the Track works it replaces when they agree on exactly one,
 * with `outcomeFrom: 'track'`; otherwise the work's own outcome and `outcomeFrom: null`.
 */
function outcomeWithTwins(work, workById) {
  const own = { outcome: work.outcome, outcomeFrom: null };
  if (work.source !== 'sheet' || work.outcome != null) return own;
  const twins = new Set(work.replaces.map(twin => workById.get(twin.workId)?.outcome).filter(outcome => outcome != null));
  return twins.size === 1 ? { outcome: [...twins][0], outcomeFrom: 'track' } : own;
}

/**
 * Every shown work, Track and sheet, of each of `rows` in the slim Workplans shape, sorted by `projectId`. Track works
 * the sheet override hides are left out; stored works are not changed. Staff only; reads no WORKS_READ_SOURCES.
 */
async function workplansOf(rows, today) {
  if (!rows.length) return [];
  const catalog = await catalogOf();
  return (await storedAcross(rows)).sort(byProjectId).flatMap(({ row, projectId, stored, marker }) => {
    const storedById = new Map(stored.map(doc => [doc.id, doc]));
    const project = { projectId, projectName: row.name ?? null, eagleId: row.eagleId ?? null };
    const marked = markedWorksFrom(stored, marker, row, catalog).works;
    const workById = new Map(marked.map(work => [work.workId, work]));
    return marked.filter(work => work.shownAfterFlip)
      .map(work => workplanOf(project, { ...work, ...outcomeWithTwins(work, workById) }, storedById.get(work.workId), today));
  });
}

module.exports = { ID_BATCH, deriveInputs, loadWorks, sheetWorksOf, sheetWorksSummaryOf, workplansOf };
