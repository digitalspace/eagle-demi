'use strict';

// Maps the business works spreadsheets, as rows of the sealed extract, onto `works` documents, staff
// project entries and sheet override markers, for the 1996 and 2002 Acts. Pure; the loader does I/O.

const { randomUUID } = require('node:crypto');
const { appliedToPhaseOf, entryFor, skips2018 } = require('./works-catalog');
const {
  OVERRIDE_MARKER_ID, OVERRIDE_TYPES, childIdOf, dayOf, matchEvents, overrideBoundaryOf, settledBefore, validateWork,
  workRangeOf
} = require('./work-model');
const { daysBetween } = require('./work-override');
const { observeInvestment } = require('./project-staff-fields');
const {
  LAST_SHEET_DAY, UNKNOWN_DAY, UNKNOWN_FIELDS, actOf, assessmentWorks, datedOf, isLater, keyOf,
  milestoneOf, oneLine, postDecisionWork, refOf, registerPostDecision
} = require('./business-works-assessment');
const { commentPeriodIdFor, compareRegister, eagleItemIdFor } = require('./business-works-compare');

/** Sheet ID 8 shows Track's investment, never a sheet figure (A19). */
const INVESTMENT_USE_TRACK = Object.freeze([8]);
const MARKER_SCHEMA_VERSION = 1;
const TIMELINE_FIELDS = Object.freeze(['intakeDate', 'determinationDate', 's11Order', 'airAccepted', 'start30',
  'start180', 'start45', 'decisionDate', 'decision']);
const STAFF_LISTS = Object.freeze(['externalIds', 'staffAssignments', 'capitalInvestments', 'staffNotes']);

function contextOf(options = {}) {
  const { catalog, phaseCatalog, crosswalk, batchId, batchAt } = options;
  if (!catalog || !phaseCatalog || !(crosswalk instanceof Map) || !batchId || !dayOf(batchAt)) {
    throw new Error('mapBusinessWorks needs catalog, phaseCatalog, crosswalk (a Map), batchId and batchAt');
  }
  return {
    catalog, phaseCatalog, crosswalk, batchId, batchAt, batchDate: dayOf(batchAt),
    trackWorks: options.trackWorks || new Map(), markers: options.markers || new Map(),
    transitionIdsAreRegisterIds: options.transitionIdsAreRegisterIds === true,
    eagleItems: options.eagleItems || new Map(), storedProjects: options.storedProjects || new Map(),
    substantialStart: options.substantialStart || null, report: [], projects: new Map(), bases: new Map()
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

/** Timelines '2002' rows carry no id, so each joins the one register row of the same name. */
function joinTimelines(ctx, rows, registers) {
  const byName = new Map();
  for (const row of registers) byName.set(keyOf(row.name), [...(byName.get(keyOf(row.name)) || []), row]);
  const joined = new Map();
  for (const row of rows) {
    const list = listFor(ctx, 'timeline2002', null, row.ref);
    const hits = byName.get(keyOf(row.name)) || [];
    if (hits.length !== 1) list(hits.length ? 'timelineAmbiguous' : 'timelineUnmatched');
    else if (joined.has(hits[0].id)) list('timelineRepeated');
    else joined.set(hits[0].id, row);
  }
  return joined;
}

/** Whether column A of the transitions tab holds the register id is undecided, so the caller says. */
function transitionsOf(ctx, rows) {
  const byId = new Map();
  for (const row of rows) {
    const list = listFor(ctx, 'transitions', null, row.ref);
    if (!ctx.transitionIdsAreRegisterIds) list('transitionJoinUndecided');
    else if (byId.has(row.id)) list('transitionRepeated');
    else byId.set(row.id, row);
  }
  return byId;
}

function withTimeline(row, timeline) {
  if (!timeline) return row;
  const over = TIMELINE_FIELDS.filter(field => timeline[field] !== null && timeline[field] !== undefined);
  return { ...row, ...Object.fromEntries(over.map(field => [field, timeline[field]])), timeline2002: true };
}

function staffEntries(ctx, row, list) {
  const at = { observedAt: ctx.batchDate, source: 'sheet', recordedAt: ctx.batchAt };
  const entries = {
    externalIds: [{ system: 'eao-register', value: String(row.id), source: 'sheet', recordedAt: ctx.batchAt }],
    staffAssignments: ['epd', 'lead'].filter(role => oneLine(row[role])).map(role => ({
      id: randomUUID(), role, name: oneLine(row[role]), effectiveFrom: null, effectiveTo: null, ...at, sheetKey: `register:${role}`
    })),
    capitalInvestments: [],
    staffNotes: oneLine(row.notes) ? [{ id: randomUUID(), text: oneLine(row.notes), workId: null, ...at, sheetKey: 'register:notes' }] : []
  };
  const seen = observeInvestment([], 'sheet', row.investment, ctx.batchDate);
  if (INVESTMENT_USE_TRACK.includes(row.id) && seen.status !== 'empty') list('investmentUseTrack');
  else if (seen.status === 'unreadable') list('investmentUnreadable');
  else if (seen.status === 'append') entries.capitalInvestments.push({ ...seen.append, ...at, sheetKey: 'register:investment' });
  return entries;
}

function readRegister(ctx, records) {
  const timelines = joinTimelines(ctx, records.timeline2002 || [], records.projects || []);
  ctx.transitions = transitionsOf(ctx, records.transitions || []);
  const rows = [];
  for (const raw of records.projects || []) {
    const projectId = ctx.crosswalk.get(raw.id) ?? null;
    const list = listFor(ctx, 'projects', projectId, raw.ref);
    if (!projectId) {
      list('notInCrosswalk');
      continue;
    }
    const row = withTimeline(raw, timelines.get(raw.id));
    UNKNOWN_FIELDS.filter(field => row[field] === UNKNOWN_DAY).forEach(field => list('unknownDate', { field }));
    compareRegister(ctx.storedProjects.get(projectId), row, ctx.substantialStart, list);
    const project = projectOf(ctx, projectId);
    const entries = staffEntries(ctx, row, list);
    STAFF_LISTS.forEach(key => project.entries[key].push(...entries[key]));
    const base = { projectId, number: row.id, title: oneLine(row.name), ref: row.ref };
    ctx.bases.set(row.id, base);
    rows.push({ row, base, list, project });
    const act = actOf(ctx, row);
    if (!act) list('noAct');
    else if (act.actYear !== 2018) project.works.push(...assessmentWorks(ctx, row, base, act, list));
    else {
      list('act2018');
      const kind = entryFor(ctx.catalog, 'outcomes', row.decision);
      if (kind && kind.code === 'certificate-issued') project.certificates.push({ actYear: 2018, ...datedOf(row, 'decisionDate') });
    }
  }
  for (const [id, row] of ctx.transitions) {
    if (!ctx.bases.has(id)) listFor(ctx, 'transitions', null, row.ref)('transitionUnmatched');
  }
  return rows;
}

/** Joins a 02-06 row to its project through the register row of the same number. */
function sheetRow(ctx, source, row) {
  const base = ctx.bases.get(row.id);
  const list = listFor(ctx, source, base ? base.projectId : null, row.ref);
  if (!base) list(ctx.crosswalk.has(row.id) ? 'noRegisterRow' : 'notInCrosswalk');
  return base ? { base, list, project: ctx.projects.get(base.projectId) } : null;
}

const isAssessment = (work) => work.workTypeCode === 'assessment';
const startOf = (work) => workRangeOf(work).start ?? '';

/** The latest-starting work whose range holds `day`. */
function holderOf(works, day) {
  const holds = works.filter((work) => {
    const { start, end } = workRangeOf(work);
    return (!start || start <= day) && (!end || day <= end);
  });
  return holds.sort((a, b) => startOf(a).localeCompare(startOf(b))).at(-1) || null;
}

/** The last phase holding `day`; a phase with no start date starts at the latest date before it. */
function phaseHolding(work, day) {
  let floor = null;
  let found = null;
  for (const phase of work.phases) {
    const start = dayOf(phase.startDate) || floor;
    const end = dayOf(phase.endDate);
    if (!isLater(start, day) && !(end && end < day)) found = phase;
    floor = [floor, start, end].filter(Boolean).sort().at(-1) || null;
  }
  return found || work.phases.at(-1) || null;
}

const nextN = (work, code) => work.phases.flatMap(phase => [...phase.milestones, ...phase.interruptions])
  .filter(child => child.id.startsWith(`${code}:`)).length + 1;

/** `{start, end}` of a dated child row before 2025, else null with the reason listed. */
function childDays(row, [startKey, endKey], list) {
  const start = dayOf(row[startKey]);
  const end = endKey ? dayOf(row[endKey]) : null;
  if (!start) list('noDate');
  else if (isLater(start, LAST_SHEET_DAY)) list('afterTrackFrom');
  else if (end && end < start) list('endBeforeStart');
  else return { start, end };
  return null;
}

function attachInterruption(ctx, { project, list }, row, tabKind) {
  if (skips2018(ctx.catalog, 'appliedTo', row.appliedTo)) return list('act2018');
  const days = childDays(row, ['startDate', 'endDate'], list);
  const type = days && entryFor(ctx.catalog, 'interruptionTypes', row.type);
  if (days && !type) list('unknownInterruptionType');
  const work = type && holderOf(project.works.filter(isAssessment), days.start);
  if (type && !work) list('noWork');
  const catalogId = work && appliedToPhaseOf(ctx.catalog, row.appliedTo, work.actYear);
  const phase = catalogId && work.phases.find(one => one.catalogId === catalogId);
  if (work && !phase) list('noPhase', { sourceKey: work.sourceKey });
  if (!phase) return undefined;
  const interruption = {
    id: childIdOf(type.code, nextN(work, type.code)), kind: type.kind || tabKind, typeCode: type.code,
    legalSection: type.legalSection ?? null, startDate: days.start, endDate: days.end,
    days: days.end ? Math.max(0, daysBetween(days.start, days.end)) : null, links: { eagleItemId: null },
    sourceRef: { sheet: refOf(row.ref) }
  };
  interruption.links.eagleItemId = eagleItemIdFor(ctx.eagleItems.get(project.projectId), interruption, list);
  return phase.interruptions.push(interruption);
}

function attachVariation(ctx, { project, list }, row) {
  const days = childDays(row, ['date'], list);
  const work = days && holderOf(project.works.filter(isAssessment), days.start);
  if (days && !work) list('noWork');
  const phase = work && work.phases.find(one => one.name === 'Pre-Application');
  if (work && !phase) list('noPhase', { sourceKey: work.sourceKey });
  if (!phase) return undefined;
  const n = nextN(work, 'order-variation');
  return phase.milestones.push({ ...milestoneOf(ctx, 'order-variation', 'INTERIOR', { day: days.start }, { n }), sourceRef: { sheet: refOf(row.ref) } });
}

function attachCommentPeriod(ctx, { project, list }, row) {
  if (skips2018(ctx.catalog, 'commentPeriodTypes', row.type)) return list('act2018');
  const days = childDays(row, ['startDate', 'endDate'], list);
  const type = days && entryFor(ctx.catalog, 'commentPeriodTypes', row.type);
  if (days && !type) list('unknownCommentPeriodType');
  const work = type && holderOf(project.works, days.start);
  if (type && !work) list('noWork');
  if (!work) return undefined;
  const options = { n: nextN(work, 'comment-period'), endDate: days.end, name: type.name };
  const milestone = { ...milestoneOf(ctx, 'comment-period', 'INTERIOR', { day: days.start }, options), sourceRef: { sheet: refOf(row.ref) } };
  milestone.links.commentPeriodId = commentPeriodIdFor(ctx.eagleItems.get(project.projectId), days.start, list);
  return phaseHolding(work, days.start).milestones.push(milestone);
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

/** The project's marker, or null with no 1996 or 2002 certificate before the boundary; pairs name sheet works by `sourceKey`. */
function buildOverride(ctx, project, skipped) {
  const { projectId, works } = project;
  const trackWorks = ctx.trackWorks.get(projectId) || [];
  const existing = ctx.markers.get(projectId) || null;
  const boundary = overrideBoundaryOf(trackWorks);
  const certificates = certificatesBefore(works, boundary);
  const covered = works.filter(work => OVERRIDE_TYPES.includes(work.workTypeCode));
  const list = (reason, work, extra) => listFor(ctx, 'override', projectId, work && work.sourceRef.sheet)(reason, { ...(work && { sourceKey: work.sourceKey }), ...extra });
  if (!certificates.length) return covered.forEach(work => list('sheetWithoutMarker', work)) || null;
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
    list(side === 'kept' ? 'trackAlive' : 'afterBoundary', sheet, { trackWorkId: track.id, gap, ...(side !== 'kept' && { closed: side }) });
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
  const ctx = contextOf(options);
  const records = (extract && extract.records) || {};
  const rows = readRegister(ctx, records);
  for (const project of ctx.projects.values()) {
    project.certificates.push(...project.works.filter(work => work.certificateKind).map(work => ({
      actYear: work.actYear, day: dayOf(work.decisionDate), unknown: Boolean(work.undated && work.undated.decisionDate)
    })));
  }
  rows.forEach(({ row, base, list, project }) => registerPostDecision(ctx, { ...project, base }, row, list));
  for (const row of records.amendments || []) {
    const joined = sheetRow(ctx, 'amendments', row);
    if (!joined) continue;
    const complexity = entryFor(ctx.catalog, 'complexities', row.complexity);
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

module.exports = { INVESTMENT_USE_TRACK, mapBusinessWorks };
