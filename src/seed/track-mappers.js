'use strict';

// Track rows mapped to DEMI shapes: today's public `works[]` shape, and the stored work document
// that `publicWorksOf` turns back into it. Pure; the I/O stays in `sources.js`.

const { workActYear } = require('../merge/assessment-work');
const { entryForTrackCode } = require('../domain/phase-catalog');

/** Track `WorkTypeEnum` ids mirrored into `works[]`; 4, 8, 12, 13 and 14 stay out. */
const MIRRORED_WORK_TYPE_IDS = new Set([1, 2, 3, 5, 6, 7, 9, 10, 11, 15, 16]);

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
    anticipatedDecisionDate: pub.anticipatedDecisionDate
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
  return { ...fields, outcome: outcomeOf(last), phases: ordered, pushStamps, updatedAt };
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

function publicPhaseOf(doc, phase, catalog) {
  const entry = catalog ? entryForTrackCode(catalog, workActYear(doc), phase.phaseCodeId) : null;
  return {
    name: phase.trackName,
    // A work's phases come from the phase codes of its own Act and work type (Track services/work.py).
    eaActId: doc.eaActId,
    eaActName: doc.eaAct,
    workType: doc.workType,
    startDate: phase.startDate,
    endDate: phase.endDate,
    numberOfDays: phase.numberOfDays,
    legislated: phase.legislated,
    sortOrder: phase.sortOrder,
    isCompleted: phase.isCompleted,
    trackPhaseId: phase.trackPhaseId,
    phaseCodeId: phase.phaseCodeId,
    catalogId: entry ? entry.catalogId : phase.phaseCodeId === null ? null : `track-${phase.phaseCodeId}`,
    catalogName: entry ? entry.name : phase.trackName,
    stage: entry ? entry.stage ?? null : null,
    order: entry ? entry.order ?? null : phase.sortOrder,
    isSuspended: phase.isSuspended,
    suspendedDate: phase.suspendedDate
  };
}

const publicMilestoneOf = (m) => ({
  name: m.name, position: m.position, eventType: m.eventType, actualDate: m.actualDate,
  anticipatedDate: m.anticipatedDate, outcome: m.outcome, numberOfDays: m.numberOfDays, trackEventId: m.trackEventId
});

/**
 * Stored work documents as the public `works[]` the project row has carried: by Track work id,
 * flat `milestones`, Track's phase names, title built from `row.sources.track.name`. Tombstones are left out.
 */
function publicWorksOf(workDocs, row, { catalog } = {}) {
  const projectName = row?.sources?.track?.name ?? null;
  return (Array.isArray(workDocs) ? workDocs : []).filter(doc => doc && doc.deleted !== true)
    .sort((a, b) => a.trackWorkId - b.trackWorkId)
    .map(doc => ({
      trackWorkId: doc.trackWorkId,
      workTypeId: doc.workTypeId,
      workType: doc.workType,
      title: titleOf(doc, projectName),
      eaAct: doc.eaAct,
      startDate: doc.startDate,
      isActive: doc.isActive,
      workState: doc.workState,
      decisionDate: doc.decisionDate,
      anticipatedDecisionDate: doc.anticipatedDecisionDate,
      outcome: doc.outcome,
      phases: doc.phases.map(phase => publicPhaseOf(doc, phase, catalog)),
      milestones: doc.phases.flatMap(phase => phase.milestones.map(publicMilestoneOf))
    }));
}

module.exports = {
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
