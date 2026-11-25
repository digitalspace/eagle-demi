'use strict';

// Maps the business works spreadsheets, as rows of the sealed extract, onto `works` documents, staff
// project entries and sheet override markers, for the 1996 and 2002 Acts. Pure; the loader does I/O.

const { randomUUID } = require('node:crypto');
const { entryFor } = require('./works-catalog');
const {
  OVERRIDE_MARKER_ID, OVERRIDE_TYPES, dayOf, matchEvents, overrideBoundaryOf, settledBefore, validateWork
} = require('./work-model');
const { SERVER_KEYS, newEntryError, observeInvestment } = require('./project-staff-fields');
const {
  UNKNOWN_DAY, UNKNOWN_FIELDS, actOf, assessmentWorks, datedOf, keyOf, oneLine, postDecisionWork, refOf, registerPostDecision,
  splitsOn2002
} = require('./business-works-assessment');
const { attachCommentPeriod, attachInterruption, attachVariation, isAssessment } = require('./business-works-children');
const { compareRegister } = require('./business-works-compare');
const { REGISTER_SYSTEM, sheetIdOf } = require('./business-works-inputs');

/** Sheet ID 8 shows Track's investment, never a sheet figure (A19); a surrogate id cannot be checked against it. */
const INVESTMENT_USE_TRACK = Object.freeze([8]);
const MARKER_SCHEMA_VERSION = 1;
const TIMELINE_DATES = Object.freeze(['intakeDate', 'determinationDate', 's11Order', 'airAccepted', 'start30',
  'start180', 'start45', 'decisionDate', 'startExtra']);
// The register has no column for these, so they are copied from Timelines but never listed as differing.
const TIMELINE_ONLY = Object.freeze(['startExtra']);
const STAFF_LISTS = Object.freeze(['externalIds', 'staffAssignments', 'capitalInvestments', 'staffNotes']);

function contextOf(extract, options = {}) {
  const { catalog, phaseCatalog, crosswalk, batchId, batchAt } = options;
  if (!catalog || !phaseCatalog || !(crosswalk instanceof Map) || !batchId || !dayOf(batchAt)) {
    throw new Error('mapBusinessWorks needs catalog, phaseCatalog, crosswalk (a Map), batchId and batchAt');
  }
  return {
    catalog, phaseCatalog, crosswalk, skipped: new Map(options.skipped), batchId, batchAt, batchDate: dayOf(batchAt),
    numbersReal: Boolean(extract) && extract.numbersReal === true,
    trackWorks: options.trackWorks || new Map(), markers: options.markers || new Map(),
    eagleItems: options.eagleItems || new Map(), storedProjects: options.storedProjects || new Map(),
    substantialStart: options.substantialStart || null, report: [], projects: new Map(), bases: new Map(), noWork: new Map()
  };
}

const listFor = (ctx, source, projectId, ref) => (reason, extra = {}) => {
  ctx.report.push({ reason, source, projectId, ...(ref && { ref: refOf(ref) }), ...extra });
};

function projectOf(ctx, projectId) {
  if (!ctx.projects.has(projectId)) {
    ctx.projects.set(projectId, { projectId, works: [], certificates: [], entries: Object.fromEntries(STAFF_LISTS.map(key => [key, []])) });
  }
  return ctx.projects.get(projectId);
}

/** The one row per register id; which of several rows is right is undecided, so each is refused as `reason`. */
function onePerId(ctx, source, byId, reason) {
  const one = new Map();
  for (const [id, rows] of byId) {
    if (rows.length === 1) one.set(id, rows[0]);
    else rows.forEach(row => listFor(ctx, source, null, row.ref)(reason));
  }
  return one;
}

/** Timelines '2002' rows carry no id, so each joins the one register row of the same name. */
function joinTimelines(ctx, rows, registers) {
  const byName = Map.groupBy(registers, row => keyOf(row.name));
  const hitsOf = (row) => byName.get(keyOf(row.name)) || [];
  const matched = rows.filter((row) => {
    const [hit, ...more] = hitsOf(row);
    const list = listFor(ctx, 'timeline2002', null, row.ref);
    if (!hit || more.length) return list(hit ? 'timelineAmbiguous' : 'timelineUnmatched');
    return ctx.skipped.has(hit.id) ? list('crosswalkSkipped', { state: ctx.skipped.get(hit.id).state }) : true;
  });
  return onePerId(ctx, 'timeline2002', Map.groupBy(matched, row => hitsOf(row)[0].id), 'timelineRepeated');
}

/** Column A of the transitions tab holds the register id. */
const transitionsOf = (ctx, rows) => onePerId(ctx, 'transitions', Map.groupBy(rows, row => row.id), 'transitionRepeated');

/** `{row, differs}`: the Timelines tab's dates win, its decision fills only a blank one; `differs` holds each register field that disagrees. */
function overlaid(raw, timeline) {
  const dates = TIMELINE_DATES.filter(field => dayOf(timeline[field]) && dayOf(timeline[field]) !== dayOf(raw[field]));
  const differs = dates.filter(field => !TIMELINE_ONLY.includes(field)).map(field => ({ field, kept: 'timeline' }));
  const labelled = oneLine(raw.decision);
  if (labelled && oneLine(timeline.decision) && keyOf(raw.decision) !== keyOf(timeline.decision)) differs.push({ field: 'decision', kept: 'register' });
  const decision = labelled || !oneLine(timeline.decision) ? raw.decision : timeline.decision;
  return { row: { ...raw, ...Object.fromEntries(dates.map(field => [field, timeline[field]])), decision }, differs };
}

/** A joined row carries `timeline2002`; the tab's fields overlay only a 2002 row or one that splits on 2002. */
function withTimeline(ctx, raw, timeline, list) {
  if (!timeline) return raw;
  const flagged = { ...raw, timeline2002: true };
  const splits = splitsOn2002(ctx, flagged);
  if (!splits && actOf(ctx, raw)?.actYear !== 2002) return flagged;
  const { row, differs } = overlaid(flagged, timeline);
  // partsOf decides the split again on the row it gets, so an overlay that would flip it is not applied.
  const applied = splitsOn2002(ctx, row) === splits;
  if (applied) differs.forEach(one => list('timelineDiffers', one));
  else list('timelineFlipsSplit');
  return applied ? row : flagged;
}

const withoutServerKeys = (entry) => Object.fromEntries(Object.entries(entry).filter(([key]) => !SERVER_KEYS.includes(key)));

/** Drops each entry W3a's validator refuses, listed by field, index and sheet key only. */
function validEntries(ctx, entries, list) {
  return Object.fromEntries(Object.entries(entries).map(([field, built]) => [field, built.filter((entry, index) => {
    if (!newEntryError(field, withoutServerKeys(entry), ctx.batchDate)) return true;
    return list('staffEntryInvalid', { field, index, sheetKey: entry.sheetKey ?? null });
  })]));
}

function staffEntries(ctx, row, list) {
  const at = { observedAt: ctx.batchDate, source: 'sheet', recordedAt: ctx.batchAt };
  const entries = {
    externalIds: [{ system: REGISTER_SYSTEM, value: String(row.id), source: 'sheet', recordedAt: ctx.batchAt }],
    staffAssignments: ['epd', 'lead'].filter(role => oneLine(row[role])).map(role => ({
      id: randomUUID(), role, name: oneLine(row[role]), effectiveFrom: null, effectiveTo: null, ...at, sheetKey: `register:${role}`
    })),
    capitalInvestments: [],
    staffNotes: oneLine(row.notes) ? [{ id: randomUUID(), text: oneLine(row.notes), workId: null, ...at, sheetKey: 'register:notes' }] : []
  };
  const seen = observeInvestment([], 'sheet', row.investment, ctx.batchDate);
  if (ctx.numbersReal && INVESTMENT_USE_TRACK.includes(row.id) && seen.status !== 'empty') list('investmentUseTrack');
  else if (seen.status === 'unreadable') list('investmentUnreadable');
  else if (seen.status === 'append') entries.capitalInvestments.push({ ...seen.append, ...at, sheetKey: 'register:investment' });
  return validEntries(ctx, entries, list);
}

/** The project a register row loads into, else null with the row listed as skipped or not in the crosswalk. */
function registerProjectOf(ctx, raw) {
  const skipped = ctx.skipped.get(raw.id)?.state;
  const projectId = skipped ? null : ctx.crosswalk.get(raw.id) ?? null;
  const list = listFor(ctx, 'projects', null, raw.ref);
  if (skipped) list('crosswalkSkipped', { state: skipped });
  else if (!projectId) list('notInCrosswalk');
  return projectId;
}

function readRegister(ctx, records) {
  const registers = records.projects || [];
  // As the crosswalk counts it: an unusable id is `badId` only when a register row holds it.
  registers.filter(row => !sheetIdOf(row.id)).forEach(row => ctx.skipped.set(row.id, { state: 'badId' }));
  const timelines = joinTimelines(ctx, records.timeline2002 || [], registers);
  ctx.transitions = transitionsOf(ctx, records.transitions || []);
  const repeated = Map.groupBy(registers, row => row.id);
  if (!ctx.numbersReal && registers.length) listFor(ctx, 'projects', null)('investmentUseTrackUnchecked');
  const rows = [];
  for (const raw of registers) {
    const projectId = registerProjectOf(ctx, raw);
    if (!projectId) continue;
    const list = listFor(ctx, 'projects', projectId, raw.ref);
    const base = { projectId, number: raw.id, title: oneLine(raw.name), ref: raw.ref };
    ctx.bases.set(raw.id, base);
    // Which of the rows sharing a number is right is undecided, so none of them loads anything.
    if (repeated.get(raw.id).length > 1) {
      ctx.noWork.set(raw.id, 'registerRepeated');
      list('registerRepeated');
      continue;
    }
    const row = withTimeline(ctx, raw, timelines.get(raw.id), list);
    UNKNOWN_FIELDS.filter(field => row[field] === UNKNOWN_DAY).forEach(field => list('unknownDate', { field }));
    compareRegister(ctx.storedProjects.get(projectId), row, ctx.substantialStart, list);
    const project = projectOf(ctx, projectId);
    const entries = staffEntries(ctx, row, list);
    STAFF_LISTS.forEach(key => project.entries[key].push(...entries[key]));
    rows.push({ row, base, list, project });
    const act = actOf(ctx, row, list);
    if (!act || act.actYear === 2018) ctx.noWork.set(row.id, act ? 'act2018' : 'noAct');
    if (!act) list('noAct');
    else if (act.actYear !== 2018) project.works.push(...assessmentWorks(ctx, row, base, act, list));
    else {
      list('act2018');
      const kind = entryFor(ctx.catalog, 'outcomes', row.decision);
      if (kind && kind.code === 'certificate-issued') project.certificates.push({ actYear: 2018, ...datedOf(row, 'decisionDate') });
    }
  }
  ctx.transitions.forEach((row, id) => listUnjoinedTransition(ctx, row, id));
  return rows;
}

function listUnjoinedTransition(ctx, row, id) {
  const skipped = ctx.skipped.get(id)?.state;
  if (skipped) listFor(ctx, 'transitions', null, row.ref)('crosswalkSkipped', { state: skipped });
  else if (!ctx.bases.has(id)) listFor(ctx, 'transitions', null, row.ref)('transitionUnmatched');
}

/** Joins a 02-06 row to its project through the register row of the same number. */
function sheetRow(ctx, source, row) {
  const base = ctx.bases.get(row.id);
  const list = listFor(ctx, source, base ? base.projectId : null, row.ref);
  const skipped = ctx.skipped.get(row.id)?.state;
  if (skipped) return list('crosswalkSkipped', { state: skipped });
  if (!base) list(ctx.crosswalk.has(row.id) ? 'noRegisterRow' : 'notInCrosswalk');
  if (base && ctx.noWork.get(row.id) === 'registerRepeated') {
    list('registerRepeated');
    return null;
  }
  return base ? { base, list, project: ctx.projects.get(base.projectId), noWork: ctx.noWork.get(row.id) || 'noWork' } : null;
}

/** `kept` when closed before `boundary`, else `open` (no close date) or `closedAfter`. */
function sideOf(work, boundary) {
  const closed = dayOf(work.decisionDate);
  if (!closed) return 'open';
  return closed < boundary ? 'kept' : 'closedAfter';
}

function certificatesBefore(works, boundary) {
  return works.filter(work => isAssessment(work) && work.certificateKind &&
    ((work.undated && work.undated.decisionDate) || (dayOf(work.decisionDate) || '9999') < boundary))
    .map(work => ({ actYear: work.actYear, certificateKind: work.certificateKind, decisionDate: work.decisionDate ?? null }));
}

const childrenOf = (work) => work.phases.flatMap(phase => [...phase.milestones, ...phase.interruptions]).filter(child => child.sourceRef);

/** The project's marker, or null with no 1996 or 2002 certificate before the boundary; pairs name sheet works by `sourceKey`. */
function buildOverride(ctx, project, skipped) {
  const { projectId, works } = project;
  const trackWorks = ctx.trackWorks.get(projectId) || [];
  const existing = ctx.markers.get(projectId) || null;
  const boundary = overrideBoundaryOf(trackWorks);
  const certificates = certificatesBefore(works, boundary);
  const covered = works.filter(work => OVERRIDE_TYPES.includes(work.workTypeCode));
  const named = (work) => work && { sourceKey: work.sourceKey, actYear: work.actYear, workTypeCode: work.workTypeCode };
  const list = (reason, work, extra) => listFor(ctx, 'override', projectId, work && work.sourceRef.sheet)(reason, { ...named(work), ...extra });
  if (!certificates.length) {
    if (existing) list('markerWithoutCertificate');
    covered.forEach(work => list('sheetWithoutMarker', work));
    return null;
  }
  if (existing && existing.active !== true) list('overrideHeldOff');
  const marker = {
    id: OVERRIDE_MARKER_ID, projectId, kind: 'override', source: 'sheet', owner: 'sheet', active: existing ? existing.active === true : true,
    boundaryAtLoad: boundary, certificates, hidden: [], trackAlive: [], untilTrack: [], pairedTrackWorkIds: [],
    batchId: ctx.batchId, provenance: { batchId: ctx.batchId }, schemaVersion: MARKER_SCHEMA_VERSION
  };
  const { pairs, sameEventChoice } = matchEvents(covered, trackWorks);
  for (const { sheet, track, gap } of pairs) {
    const pair = { trackWorkId: track.id, sourceKey: sheet.sourceKey };
    const side = sideOf(sheet, boundary);
    marker.pairedTrackWorkIds.push(track.id);
    if (side === 'kept' && settledBefore(track, boundary)) {
      marker.hidden.push(pair);
      if (!dayOf(track.decisionDate)) list('trackCompletedNoDate', sheet, { trackWorkId: track.id, gap });
      continue;
    }
    skipped.add(sheet.sourceKey);
    if (side === 'kept') marker.trackAlive.push(pair);
    const reason = side === 'kept' ? 'trackAlive' : 'afterBoundary';
    list(reason, sheet, { trackWorkId: track.id, gap, ...(side !== 'kept' && { closed: side }) });
    childrenOf(sheet).forEach(child => listFor(ctx, 'override', projectId, child.sourceRef.sheet)(reason, { sourceKey: sheet.sourceKey, child: child.id }));
  }
  const paired = new Set(pairs.map(pair => pair.sheet));
  for (const work of covered.filter(one => !paired.has(one) && sideOf(one, boundary) !== 'kept')) {
    marker.untilTrack.push(work.sourceKey);
    list('afterBoundary', work, { closed: sideOf(work, boundary), untilTrack: true });
  }
  for (const choice of sameEventChoice) {
    const nameOf = (work) => work.sourceKey ?? work.id;
    list('sameEventChoice', null, { side: choice.side, work: nameOf(choice.work), left: choice.left.map(one => ({ work: nameOf(one.work), gap: one.gap })) });
  }
  return marker;
}

/** Refuses every work whose `sourceKey` repeats, and every work the validator refuses. */
function acceptedWorks(ctx, works) {
  const counts = new Map();
  works.forEach(work => counts.set(work.sourceKey, (counts.get(work.sourceKey) || 0) + 1));
  return works.filter((work) => {
    const list = listFor(ctx, 'works', work.projectId, work.sourceRef.sheet);
    if (counts.get(work.sourceKey) > 1) return list('duplicateKey', { sourceKey: work.sourceKey });
    const checked = validateWork(work);
    if (!checked.ok) list('invalid', { sourceKey: work.sourceKey, errors: checked.errors || [{ rule: checked.reason }] });
    return checked.ok;
  });
}

/** `{works, markers, projects, report}` from an opened extract; option shapes are in the module's tests. */
function mapBusinessWorks(extract, options) {
  const ctx = contextOf(extract, options);
  const records = (extract && extract.records) || {};
  const rows = readRegister(ctx, records);
  for (const project of ctx.projects.values()) {
    project.works = acceptedWorks(ctx, project.works);
    project.certificates.push(...project.works.filter(work => work.certificateKind).map(work => ({
      actYear: work.actYear, day: dayOf(work.decisionDate), unknown: Boolean(work.undated && work.undated.decisionDate)
    })));
  }
  rows.forEach(({ row, base, list, project }) => registerPostDecision(ctx, { ...project, base }, row, list));
  for (const row of records.amendments || []) {
    const joined = sheetRow(ctx, 'amendments', row);
    if (!joined) continue;
    if (!oneLine(String(row.ref.slot ?? ''))) {
      joined.list('noSlot');
      continue;
    }
    const complexity = entryFor(ctx.catalog, 'complexities', row.complexity);
    if (oneLine(row.complexity) && !complexity) joined.list('unknownComplexity', { field: 'complexity' });
    postDecisionWork(ctx, { ...joined.project, base: joined.base }, {
      kind: 'amendment', slot: row.ref.slot, code: 'amendment', startDay: dayOf(row.startDate), decisionDay: dayOf(row.endDate),
      ref: row.ref, status: row.status, extra: { complexityCode: complexity ? complexity.code : null }
    }, joined.list);
  }
  const attach = (source, each) => (records[source] || []).forEach((row) => {
    const joined = sheetRow(ctx, source, row);
    if (joined) each(joined, row);
  });
  attach('suspensions', (joined, row) => attachInterruption(ctx, joined, row, 'suspension'));
  attach('extensions', (joined, row) => attachInterruption(ctx, joined, row, 'extension'));
  attach('orderVariations', (joined, row) => attachVariation(ctx, joined, row));
  attach('commentPeriods', (joined, row) => attachCommentPeriod(ctx, joined, row));
  const works = [];
  const markers = [];
  for (const project of ctx.projects.values()) {
    project.works = acceptedWorks(ctx, project.works);
    const skipped = new Set();
    const marker = buildOverride(ctx, project, skipped);
    if (marker) markers.push(marker);
    works.push(...project.works.filter(work => !skipped.has(work.sourceKey)));
  }
  const projects = [...ctx.projects.values()].map(({ projectId, entries }) => ({ projectId, ...entries }));
  return { works, markers, projects, report: ctx.report };
}

module.exports = { mapBusinessWorks };
