'use strict';

// Track rows mapped to DEMI shapes: today's public `works[]` shape, and the stored work document
// that `publicWorksOf` turns back into it. Pure; the I/O stays in `sources.js`.

const { workActYear } = require('../merge/assessment-work');
const { entryForTrackCode } = require('../domain/phase-catalog');
const { TRACK_WORK_TYPE_CODES, dayOf, summaryOf, transitionDateOf } = require('../domain/work-model');

/** Track `WorkTypeEnum` ids mirrored into `works[]`; 4, 8, 12, 13 and 14 stay out. */
const MIRRORED_WORK_TYPE_IDS = new Set([1, 2, 3, 5, 6, 7, 9, 10, 11, 15, 16]);

const workTypeCodeOfTrack = (workTypeId) => TRACK_WORK_TYPE_CODES[workTypeId] ?? null;

const WORK_SCHEMA_VERSION = 1;

// Keys the container's works carry beyond what the row stored from Track's pull, per level;
// `startPlanned` and `endPlanned` are added to phases by `composedRow`.
const ADDED_WORK_KEYS = new Set(['workId', 'source', 'actYear', 'workTypeCode', 'outcomeCode', 'transitionOut',
  'undated']);
const ADDED_PHASE_KEYS = new Set(['catalogId', 'catalogName', 'stage', 'order', 'trackPhaseId', 'phaseCodeId',
  'isSuspended', 'suspendedDate', 'startPlanned', 'endPlanned', 'undated', 'interruptions']);
const ADDED_MILESTONE_KEYS = new Set(['trackEventId', 'code', 'endDate', 'links', 'undated']);

const omit = (obj, keys) => (obj && typeof obj === 'object' && !Array.isArray(obj)
  ? Object.fromEntries(Object.entries(obj).filter(([key]) => !keys.has(key))) : obj);
const omitEach = (list, keys) => (Array.isArray(list) ? list.map(item => omit(item, keys)) : list);

/** A row-shaped object with the added keys dropped from `works[]`, their phases and milestones, and `phases[]`. */
function withoutAdded(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  if (Array.isArray(row.works)) {
    out.works = row.works.map((work) => {
      const kept = omit(work, ADDED_WORK_KEYS);
      if (!kept || typeof kept !== 'object') return kept;
      if ('phases' in kept) kept.phases = omitEach(kept.phases, ADDED_PHASE_KEYS);
      if ('milestones' in kept) kept.milestones = omitEach(kept.milestones, ADDED_MILESTONE_KEYS);
      return kept;
    });
  }
  if ('phases' in row) out.phases = omitEach(row.phases, ADDED_PHASE_KEYS);
  return out;
}

/** Track sends these either nested (`{name}`) or as a bare string, depending on the endpoint. */
const nameOf = (v) => (v && typeof v === 'object' ? v.name : v);

const workTypeIdOf = (work) => Number(work.work_type_id ?? (work.work_type || {}).id);

const isMirrored = (work) => MIRRORED_WORK_TYPE_IDS.has(workTypeIdOf(work));

/** A work's Track project id as the string the Maps key on, or null when it names none. */
function projectKeyOf(work) {
  const projectId = work.project_id ?? (work.project || {}).id;
  return projectId === undefined || projectId === null ? null : String(projectId);
}

/** Track sends timestamps with a zone; anything unparseable lands as null rather than a bad date. */
function isoOrNull(value) {
  if (!value) return null;
  const at = new Date(value);
  return isNaN(at.getTime()) ? null : at.toISOString();
}

/**
 * One `GET /works/<id>/phases` row in the public shape. `work_phase.name` wins over the phase
 * code's: Track lets a work rename its phase, and staff and reports use the renamed one.
 */
function trackPhaseToPublic(row) {
  const wp = (row && row.work_phase) || {};
  const phase = wp.phase || {};
  const eaAct = phase.ea_act || {};
  return {
    name: wp.name || phase.name || null,
    eaActId: phase.ea_act_id ?? eaAct.id ?? null,
    eaActName: eaAct.name || null,
    workType: (phase.work_type || {}).name || null,
    startDate: isoOrNull(wp.start_date),
    endDate: isoOrNull(wp.end_date),
    numberOfDays: wp.number_of_days ?? null,
    legislated: wp.legislated ?? null,
    sortOrder: wp.sort_order ?? null,
    isCompleted: wp.is_completed === true
  };
}

/** One milestone event in the public `works[].milestones[]` shape. Nothing else leaves Track.
 *  The template name wins over the event name because staff rename events freely. */
function trackMilestoneToPublic(event, outcome) {
  const conf = event.event_configuration || {};
  return {
    name: conf.name || event.name || null,
    position: conf.event_position || null,
    eventType: conf.event_type_id ?? null,
    actualDate: isoOrNull(event.actual_date),
    anticipatedDate: isoOrNull(event.anticipated_date),
    outcome: outcome ?? null,
    numberOfDays: event.number_of_days ?? null
  };
}

/** Outcome = last phase's END milestone with an outcome; type-10 works end earlier phases with none. */
function outcomeOf(lastMilestones) {
  const decided = (lastMilestones || []).filter(m => m.position === 'END' && m.outcome !== null);
  return decided.length ? decided[decided.length - 1].outcome : null;
}

/** One Track work in the public `works[]` shape: a literal, so no staff note or reference rides along. */
function trackWorkToPublic(work, phaseEvents) {
  return {
    trackWorkId: work.id,
    workTypeId: workTypeIdOf(work),
    workType: nameOf(work.work_type) || null,
    title: work.title || work.simple_title || null,
    eaAct: nameOf(work.ea_act) || null,
    startDate: isoOrNull(work.start_date),
    isActive: work.is_active === true,
    workState: work.work_state || null,
    decisionDate: isoOrNull(work.work_decision_date),
    anticipatedDecisionDate: isoOrNull(work.anticipated_decision_date),
    outcome: outcomeOf(phaseEvents.length ? phaseEvents[phaseEvents.length - 1].milestones : []),
    phases: phaseEvents.map(p => p.phase),
    milestones: phaseEvents.flatMap(p => p.milestones)
  };
}

const bySortOrder = (a, b) => (a.sortOrder || 0) - (b.sortOrder || 0);

/** `{work_phase}` rows by sort order, then Track phase id, each beside its public shape. */
const orderedPhases = (rows) => (rows || [])
  .map(row => ({ row, phase: trackPhaseToPublic(row) }))
  .sort((a, b) => bySortOrder(a.phase, b.phase) || ((a.row.work_phase || {}).id || 0) - ((b.row.work_phase || {}).id || 0));

const isShownEvent = (event) => (event.event_configuration || {}).visibility !== 'HIDDEN';

/** The events `milestones[]` shows: HIDDEN dropped, by template order, then id. */
function shownEvents(events) {
  const order = (e) => (e.event_configuration || {}).sort_order || 0;
  return (events || []).filter(isShownEvent).sort((a, b) => order(a) - order(b) || a.id - b.id);
}

/** A nested Track work (`phases[].events[]`, outcome as `outcome_name`) as `trackWorkToPublic`'s phases. */
const phaseEventsOf = (work) => orderedPhases((work.phases || []).map(wp => ({ work_phase: wp })))
  .map(({ row, phase }) => ({
    phase,
    milestones: shownEvents(row.work_phase.events).map(e => trackMilestoneToPublic(e, e.outcome_name))
  }));

/** One Track event as a stored milestone, kept under its phase. */
function docMilestoneOf(event) {
  const conf = event.event_configuration || {};
  return {
    trackEventId: event.id,
    ...trackMilestoneToPublic(event, event.outcome_name),
    sortOrder: conf.sort_order ?? null
  };
}

/** One Track work phase as a stored phase; Track's name and code only, the catalog is read later. */
function docPhaseOf(wp, milestones = []) {
  const { name, startDate, endDate, numberOfDays, legislated, sortOrder, isCompleted } =
    trackPhaseToPublic({ work_phase: wp });
  return {
    trackPhaseId: wp.id,
    phaseCodeId: wp.phase_id ?? (wp.phase || {}).id ?? null,
    trackName: name,
    startDate, endDate, numberOfDays, legislated, sortOrder, isCompleted,
    isSuspended: wp.is_suspended === true,
    suspendedDate: isoOrNull(wp.suspended_date),
    milestones
  };
}

/** The work's own fields of a stored work document, with no phases. */
function docWorkFieldsOf(work, projectId) {
  const pub = trackWorkToPublic(work, []);
  return {
    id: `track-${work.id}`,
    projectId,
    trackWorkId: pub.trackWorkId,
    workTypeId: pub.workTypeId,
    workType: pub.workType,
    eaActId: work.ea_act_id ?? (work.ea_act || {}).id ?? null,
    eaAct: pub.eaAct,
    simpleTitle: work.simple_title || null,
    startDate: pub.startDate,
    isActive: pub.isActive,
    workState: pub.workState,
    decisionDate: pub.decisionDate,
    anticipatedDecisionDate: pub.anticipatedDecisionDate,
    schemaVersion: WORK_SCHEMA_VERSION,
    workTypeCode: workTypeCodeOfTrack(pub.workTypeId),
    actYear: workActYear(pub)
  };
}

const byOrderThenId = (idKey) => (a, b) => bySortOrder(a, b) || (a[idKey] || 0) - (b[idKey] || 0);
const byPhaseOrder = byOrderThenId('trackPhaseId');
const byMilestoneOrder = byOrderThenId('trackEventId');

/** A work document with its phases and milestones ordered and its `outcome` derived from them. */
function settledDoc(fields, phases, pushStamps, updatedAt) {
  const ordered = phases.map(p => ({ ...p, milestones: [...p.milestones].sort(byMilestoneOrder) }))
    .sort(byPhaseOrder);
  const last = ordered.length ? ordered[ordered.length - 1].milestones : [];
  const doc = { ...fields, outcome: outcomeOf(last), phases: ordered, pushStamps, updatedAt };
  return { ...doc, summary: summaryOf(doc) };
}

/**
 * The stored `works` document for one nested Track work (`phases[].events[]`, outcome as
 * `outcome_name`), or null for a work type DEMI does not mirror. HIDDEN events are left out.
 */
function workDocOf(work, { projectId = null, pushStamps = {}, updatedAt = null } = {}) {
  if (!isMirrored(work)) return null;
  const phases = (work.phases || []).map(wp =>
    docPhaseOf(wp, (wp.events || []).filter(isShownEvent).map(docMilestoneOf)));
  return settledDoc(docWorkFieldsOf(work, projectId), phases, pushStamps, updatedAt);
}

/** Track's title rule (utils/util.py `generate_title`): project name, work type, then simple title. */
function titleOf(doc, projectName) {
  if (!projectName) return doc.simpleTitle || null;
  return [projectName, doc.workType, doc.simpleTitle].filter(Boolean).join(' - ');
}

const isTrackDoc = (doc) => /^track-\d+$/.test(String(doc.id));
const listOf = (value) => (Array.isArray(value) ? value : []);
const or = (value) => value ?? null;
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Only `{notAfter}` of each entry, so nothing else stored beside a date leaves. */
function undatedOf(undated) {
  if (!isPlainObject(undated)) return null;
  return Object.fromEntries(Object.entries(undated).map(([key, entry]) =>
    [key, { notAfter: isPlainObject(entry) && typeof entry.notAfter === 'string' ? entry.notAfter : null }]));
}

/** `value` on a Track document; null on any other source, whatever it stores. */
const trackOnly = (doc, value) => (isTrackDoc(doc) ? or(value) : null);

function catalogEntryOf(doc, phase, catalog) {
  if (!catalog) return null;
  if (isTrackDoc(doc)) return entryForTrackCode(catalog, workActYear(doc), phase.phaseCodeId);
  return listOf(catalog[doc.actYear]).find(entry => entry.catalogId === phase.catalogId) || null;
}

function catalogIdOf(doc, phase, entry) {
  if (entry) return entry.catalogId;
  if (!isTrackDoc(doc)) return or(phase.catalogId);
  return phase.phaseCodeId === null || phase.phaseCodeId === undefined ? null : `track-${phase.phaseCodeId}`;
}

const publicInterruptionOf = (x) => ({
  id: or(x.id), kind: or(x.kind), typeCode: or(x.typeCode), legalSection: or(x.legalSection),
  startDate: or(x.startDate), endDate: or(x.endDate), days: or(x.days)
});

function publicPhaseOf(doc, phase, catalog) {
  const entry = catalogEntryOf(doc, phase, catalog);
  // A sheet phase shows its catalog name, never the sheet's own text.
  const name = isTrackDoc(doc) ? or(phase.trackName) : or(entry ? entry.name : phase.name);
  return {
    name,
    // A work's phases come from the phase codes of its own Act and work type (Track services/work.py).
    eaActId: or(doc.eaActId),
    eaActName: or(doc.eaAct),
    workType: or(doc.workType),
    startDate: or(phase.startDate),
    endDate: or(phase.endDate),
    numberOfDays: or(phase.numberOfDays),
    legislated: or(phase.legislated),
    sortOrder: or(phase.sortOrder),
    isCompleted: phase.isCompleted === true,
    trackPhaseId: trackOnly(doc, phase.trackPhaseId),
    phaseCodeId: trackOnly(doc, phase.phaseCodeId),
    catalogId: catalogIdOf(doc, phase, entry),
    catalogName: entry ? entry.name : name,
    stage: entry ? or(entry.stage) : null,
    order: entry ? or(entry.order) : or(phase.sortOrder),
    isSuspended: trackOnly(doc, phase.isSuspended),
    suspendedDate: or(phase.suspendedDate),
    undated: undatedOf(phase.undated),
    interruptions: listOf(phase.interruptions).map(publicInterruptionOf)
  };
}

const publicMilestoneOf = (doc, m) => ({
  name: or(m.name), code: or(m.code), position: or(m.position), eventType: or(m.eventType),
  actualDate: or(m.actualDate), anticipatedDate: or(m.anticipatedDate), endDate: or(m.endDate),
  outcome: or(m.outcome), numberOfDays: or(m.numberOfDays), trackEventId: trackOnly(doc, m.trackEventId),
  links: { commentPeriodId: or(m.links && m.links.commentPeriodId), blockField: or(m.links && m.links.blockField) },
  undated: undatedOf(m.undated)
});

function publicWorkOf(doc, projectName, catalog) {
  const phases = listOf(doc.phases);
  const track = isTrackDoc(doc);
  return {
    workId: doc.id,
    source: doc.source ?? (track ? 'track' : null),
    trackWorkId: trackOnly(doc, doc.trackWorkId),
    workTypeId: trackOnly(doc, doc.workTypeId),
    // Read-time fallbacks for a Track document the nightly has not rewritten yet.
    workTypeCode: or(doc.workTypeCode ?? (track ? workTypeCodeOfTrack(doc.workTypeId) : null)),
    workType: or(doc.workType),
    title: titleOf(doc, projectName),
    eaAct: or(doc.eaAct),
    actYear: or(doc.actYear ?? (track ? workActYear(doc) : null)),
    startDate: or(doc.startDate),
    isActive: or(doc.isActive),
    workState: or(doc.workState),
    decisionDate: or(doc.decisionDate),
    anticipatedDecisionDate: or(doc.anticipatedDecisionDate),
    outcome: or(doc.outcome),
    outcomeCode: or(doc.outcomeCode),
    transitionOut: isPlainObject(doc.transitionOut)
      ? { toActYear: or(doc.transitionOut.toActYear), date: null, dateSource: 'none' }
      : null,
    undated: undatedOf(doc.undated),
    phases: phases.map(phase => publicPhaseOf(doc, phase, catalog)),
    milestones: phases.flatMap(phase => listOf(phase.milestones).map(m => publicMilestoneOf(doc, m)))
  };
}

/** The resolved hand-over day and where it came from: Track's milestone, the sheet, or none. */
function resolvedTransition(transitionOut, works, actYear) {
  const date = transitionDateOf(transitionOut, works, actYear);
  if (date === null) return { date: null, dateSource: 'none' };
  const fromTrack = transitionDateOf({ dateSource: 'none' }, works, actYear);
  return { date: dayOf(date), dateSource: date === fromTrack ? 'track' : 'sheet' };
}

const textOrder = (a, b) => (String(a ?? '') < String(b ?? '') ? -1 : String(a ?? '') > String(b ?? '') ? 1 : 0);

/** Track documents by Track work id, then the rest by start date, then id. */
const byPublicOrder = (a, b) => isTrackDoc(b) - isTrackDoc(a) || (isTrackDoc(a)
  ? a.trackWorkId - b.trackWorkId
  : textOrder(a.startDate, b.startDate) || textOrder(a.id, b.id));

/**
 * Stored work documents as the public `works[]`: an allow-list at every level, flat `milestones`,
 * title built from Track's project name, else the row's. Tombstones are left out.
 */
function publicWorksOf(workDocs, row, { catalog } = {}) {
  const projectName = row?.sources?.track?.name ?? row?.name ?? null;
  const live = listOf(workDocs).filter(doc => doc && doc.deleted !== true).sort(byPublicOrder);
  const works = live.map(doc => publicWorkOf(doc, projectName, catalog));
  // Resolved over the public shape, where Track's transition milestone sits in flat `milestones`.
  works.forEach((work, i) => {
    if (work.transitionOut) Object.assign(work.transitionOut, resolvedTransition(live[i].transitionOut, works, work.actYear));
  });
  return works;
}

module.exports = {
  MIRRORED_WORK_TYPE_IDS,
  withoutAdded,
  nameOf,
  workTypeIdOf,
  isMirrored,
  projectKeyOf,
  isoOrNull,
  trackWorkToPublic,
  orderedPhases,
  isShownEvent,
  shownEvents,
  phaseEventsOf,
  docMilestoneOf,
  docPhaseOf,
  docWorkFieldsOf,
  settledDoc,
  workDocOf,
  publicWorksOf
};
