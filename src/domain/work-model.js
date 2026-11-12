'use strict';

// Work documents in the `works` container: ids, validation, summary, staff entries in effect and
// the sheet override of Track's post-decision works. Pure; owner rules live in repositories/works.js.

const { randomUUID } = require('node:crypto');
const { LEGISLATIONS } = require('./project-legislation');
const { ASSESSMENT_WORK_TYPE } = require('../merge/assessment-work');
const { TRANSITION_MILESTONE } = require('../merge/track-derived');

/** Track supplies every record dated on or after this day. */
const TRACK_FROM = '2025-01-01';
const ACT_YEARS = Object.freeze(Object.keys(LEGISLATIONS).map(Number).sort((a, b) => a - b));
const WORK_SOURCES = Object.freeze(['track', 'sheet', 'demi']);
const OVERRIDE_MARKER_ID = 'sheet-override';
const START_WINDOW_DAYS = 31;
const DECISION_WINDOW_DAYS = 60;
const MAX_BYTES = 1.5 * 1024 * 1024;
const MAX_CHILDREN = 2000;

const TRACK_WORK_TYPE_CODES = Object.freeze({
  1: 'project-notification', 2: 'minister-designation', 3: 'ceao-designation', 5: 'exemption-order',
  6: 'assessment', 7: 'amendment', 9: 'eac-extension', 10: 'substantial-start', 11: 'transfer',
  15: 'material-alteration', 16: 'amendment'
});
/** Track work type ids whose works an audited route may adopt. */
const TRACK_RETIRED_WORK_TYPES = Object.freeze([]);
const OVERRIDE_TYPES = Object.freeze(['amendment', 'eac-extension', 'substantial-start']);

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const DATE_KEYS = Object.freeze(['startDate', 'decisionDate', 'anticipatedDecisionDate', 'newExpiryDate',
  'endDate', 'actualDate', 'anticipatedDate']);
// Strings a public reader can see: catalog display names, titles and legal sections.
const PUBLIC_TEXT_KEYS = new Set(['title', 'workType', 'outcome', 'name', 'legalSection']);
const INTERRUPTION_KINDS = Object.freeze(['extension', 'suspension', 'interregnum']);

const given = (value) => value !== undefined && value !== null;
const listOf = (value) => (Array.isArray(value) ? value : []);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const compareText = (a, b) => (String(a ?? '') < String(b ?? '') ? -1 : String(a ?? '') > String(b ?? '') ? 1 : 0);

/** The `YYYY-MM-DD` of an ISO date or timestamp, else null; an unknown date is stored null, so it is missing here too. */
function dayOf(value) {
  if (typeof value !== 'string') return null;
  const match = DAY_PATTERN.exec(value);
  if (!match) return null;
  const day = value.slice(0, 10);
  const at = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return at.toISOString().slice(0, 10) === day ? day : null;
}

const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);

const hasControl = (text) => [...text].some((ch) => {
  const code = ch.codePointAt(0);
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
});

function newWorkId(source) {
  if (source !== 'sheet' && source !== 'demi') throw new Error('newWorkId takes sheet or demi');
  return `${source}-${randomUUID()}`;
}

/** `<number>:<kind>:<slot>`; the sheet number loses leading zeros so `'0152'` and `152` give one key. */
function sourceKeyOf(number, kind, slot) {
  const [num, kindText, slotText] = [number, kind, slot].map(part => String(part ?? '').trim());
  if (!/^\d+$/.test(num) || !kindText || kindText.includes(':') || !slotText) {
    throw new Error('sourceKeyOf needs a sheet number, a kind and a slot');
  }
  return `${Number(num)}:${kindText}:${slotText}`;
}

/** A work-local child id, `<catalogCode>` or `<catalogCode>:<n>`. */
function childIdOf(catalogCode, n) {
  const code = String(catalogCode ?? '').trim();
  if (!code || code.includes(':')) throw new Error('childIdOf needs a catalog code');
  if (n === undefined || n === null) return code;
  if (!Number.isInteger(n) || n < 1) throw new Error('childIdOf takes a positive whole n');
  return `${code}:${n}`;
}

const phasesOf = (work) => listOf(work && work.phases).filter(isObject);
const childrenOf = (phase, key) => listOf(phase[key]).filter(isObject);

/** Interruption days are end minus start, or null when either date is missing. */
function interruptionDaysOf(interruption) {
  const start = dayOf(interruption.startDate);
  const end = dayOf(interruption.endDate);
  return start && end ? daysBetween(start, end) : null;
}

function checkSize(doc) {
  const children = phasesOf(doc)
    .reduce((n, phase) => n + childrenOf(phase, 'milestones').length + childrenOf(phase, 'interruptions').length, 0);
  const over = children > MAX_CHILDREN || Buffer.byteLength(JSON.stringify(doc)) > MAX_BYTES;
  return over ? { ok: false, reason: 'oversize' } : { ok: true };
}

/** Control characters anywhere, `<` in public text, and any `staff` key. Errors name a path, never a value. */
function textErrors(value, path, errors) {
  if (typeof value === 'string' && hasControl(value)) errors.push({ path, rule: 'control-character' });
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const at = path ? `${path}.${key}` : key;
    if (hasControl(key)) errors.push({ path, rule: 'control-character' });
    if (key === 'staff') errors.push({ path: at, rule: 'staff-data' });
    if (typeof child === 'string' && PUBLIC_TEXT_KEYS.has(key) && child.includes('<')) errors.push({ path: at, rule: 'markup' });
    textErrors(child, at, errors);
  }
}

function itemErrors(item, path, [startKey, endKey], errors) {
  const at = (key) => (path ? `${path}.${key}` : key);
  for (const key of DATE_KEYS) {
    if (given(item[key]) && !dayOf(item[key])) errors.push({ path: at(key), rule: 'date' });
  }
  const start = dayOf(item[startKey]);
  const end = dayOf(item[endKey]);
  if (start && end && end < start) errors.push({ path: at(endKey), rule: 'end-before-start' });
  if (item.undated !== undefined && !isObject(item.undated)) errors.push({ path: at('undated'), rule: 'undated' });
  for (const [key, entry] of Object.entries(isObject(item.undated) ? item.undated : {})) {
    if (given(item[key])) errors.push({ path: at(`undated.${key}`), rule: 'undated-holds-date' });
    if (!isObject(entry) || !dayOf(entry.notAfter)) errors.push({ path: at(`undated.${key}`), rule: 'undated' });
  }
}

function transitionErrors(transitionOut, errors) {
  if (!given(transitionOut)) return;
  const { date, dateSource, toActYear } = isObject(transitionOut) ? transitionOut : {};
  if (!['sheet', 'track', 'none'].includes(dateSource)) errors.push({ path: 'transitionOut.dateSource', rule: 'date-source' });
  if (given(date) && dateSource !== 'sheet' && dateSource !== 'track') errors.push({ path: 'transitionOut.date', rule: 'date-source' });
  if (given(date) && !dayOf(date)) errors.push({ path: 'transitionOut.date', rule: 'date' });
  if (!ACT_YEARS.includes(toActYear)) errors.push({ path: 'transitionOut.toActYear', rule: 'act-year' });
}

function interruptionErrors(interruption, path, errors) {
  itemErrors(interruption, path, ['startDate', 'endDate'], errors);
  if (!INTERRUPTION_KINDS.includes(interruption.kind)) errors.push({ path: `${path}.kind`, rule: 'kind' });
  const days = interruptionDaysOf(interruption);
  if (given(interruption.days) && days !== null && interruption.days !== days) errors.push({ path: `${path}.days`, rule: 'days' });
}

function workErrors(doc) {
  const errors = [];
  textErrors(doc, '', errors);
  if (given(doc.source) && (!WORK_SOURCES.includes(doc.source) || !String(doc.id).startsWith(`${doc.source}-`))) {
    errors.push({ path: 'source', rule: 'source' });
  }
  if (given(doc.actYear) && !ACT_YEARS.includes(doc.actYear)) errors.push({ path: 'actYear', rule: 'act-year' });
  itemErrors(doc, '', ['startDate', 'decisionDate'], errors);
  transitionErrors(doc.transitionOut, errors);
  // Child ids are unique within the document and never embed the work id, which may be random.
  const seen = new Set();
  const checkId = (child, path) => {
    if (child.id === undefined) return;
    const bad = typeof child.id !== 'string' || !child.id || seen.has(child.id) ||
      (typeof doc.id === 'string' && child.id.includes(doc.id));
    if (bad) errors.push({ path: `${path}.id`, rule: 'child-id' });
    seen.add(child.id);
  };
  phasesOf(doc).forEach((phase, i) => {
    itemErrors(phase, `phases.${i}`, ['startDate', 'endDate'], errors);
    checkId(phase, `phases.${i}`);
    childrenOf(phase, 'milestones').forEach((m, j) => {
      itemErrors(m, `phases.${i}.milestones.${j}`, ['actualDate', 'endDate'], errors);
      checkId(m, `phases.${i}.milestones.${j}`);
    });
    childrenOf(phase, 'interruptions').forEach((x, j) => {
      interruptionErrors(x, `phases.${i}.interruptions.${j}`, errors);
      checkId(x, `phases.${i}.interruptions.${j}`);
    });
  });
  return errors;
}

const verdict = (errors) => (errors.length ? { ok: false, reason: 'invalid', errors } : { ok: true });

/** `{ok:true}`, `{ok:false, reason:'oversize'}`, or `{ok:false, reason:'invalid', errors:[{path, rule}]}`. */
function validateWork(doc) {
  if (!isObject(doc)) return verdict([{ path: '', rule: 'object' }]);
  const size = checkSize(doc);
  return size.ok ? verdict(workErrors(doc)) : size;
}

const isTrackId = (id) => typeof id === 'string' && /^track-\d+$/.test(id);
const isSheetId = (id) => typeof id === 'string' && /^sheet-./.test(id);

function markerListErrors(marker, errors) {
  const each = (key, test) => {
    if (!Array.isArray(marker[key])) errors.push({ path: key, rule: 'list' });
    listOf(marker[key]).forEach((entry, i) => { if (!test(entry)) errors.push({ path: `${key}.${i}`, rule: 'entry' }); });
  };
  each('certificates', c => isObject(c) && (c.actYear === 1996 || c.actYear === 2002) &&
    (c.certificateKind === 'EAC' || c.certificateKind === 'PAC') && (c.decisionDate === null || Boolean(dayOf(c.decisionDate))));
  each('hidden', h => isObject(h) && isTrackId(h.trackWorkId) && isSheetId(h.sheetWorkId));
  each('trackAlive', a => isObject(a) && isTrackId(a.trackWorkId) && typeof a.sourceKey === 'string' && a.sourceKey !== '');
  each('untilTrack', isSheetId);
  each('pairedTrackWorkIds', isTrackId);
}

/** The override marker's shape; same result shape as `validateWork`. */
function validateMarker(marker) {
  if (!isObject(marker)) return verdict([{ path: '', rule: 'object' }]);
  const errors = [];
  textErrors(marker, '', errors);
  const need = (ok, path, rule) => { if (!ok) errors.push({ path, rule }); };
  need(marker.id === OVERRIDE_MARKER_ID, 'id', 'marker-id');
  need(marker.kind === 'override', 'kind', 'kind');
  need(marker.source === 'sheet', 'source', 'source');
  need(marker.owner === 'sheet', 'owner', 'owner');
  need(typeof marker.active === 'boolean', 'active', 'boolean');
  const boundary = dayOf(marker.boundaryAtLoad);
  need(Boolean(boundary) && boundary <= TRACK_FROM, 'boundaryAtLoad', 'boundary');
  markerListErrors(marker, errors);
  return verdict(errors);
}

/** From `startDate` to `decisionDate`, else the last phase's `endDate`; a null end is open. */
function workRangeOf(work) {
  const phases = phasesOf(work);
  const lastEnd = phases.length ? dayOf(phases[phases.length - 1].endDate) : null;
  return { start: dayOf(work.startDate), end: dayOf(work.decisionDate) ?? lastEnd };
}

function summaryOf(work) {
  const { start, end } = workRangeOf(work);
  const elapsedDays = start && end ? daysBetween(start, end) : null;
  let suspendedDays = 0;
  let extensionDays = 0;
  let phaseDays = null;
  for (const phase of phasesOf(work)) {
    const phaseStart = dayOf(phase.startDate);
    const phaseEnd = dayOf(phase.endDate);
    if (phaseStart && phaseEnd) phaseDays = (phaseDays ?? 0) + daysBetween(phaseStart, phaseEnd);
    for (const interruption of childrenOf(phase, 'interruptions')) {
      const days = interruptionDaysOf(interruption) ?? 0;
      if (interruption.kind === 'suspension') suspendedDays += days;
      if (interruption.kind === 'extension') extensionDays += days;
    }
  }
  const decided = dayOf(work.decisionDate);
  return {
    elapsedDays,
    suspendedDays,
    extensionDays,
    effortDays: elapsedDays === null ? null : elapsedDays - suspendedDays,
    phaseDays,
    decisionYear: decided ? Number(decided.slice(0, 4)) : null
  };
}

const actBefore = (year) => {
  const i = ACT_YEARS.indexOf(Number(year));
  return i > 0 ? ACT_YEARS[i - 1] : null;
};

/** Track's "Project Transitioning FROM ..." milestone date naming `fromYear`, over public-shape works. */
function trackTransitionDateOf(projectWorks, fromYear) {
  for (const work of listOf(projectWorks)) {
    if (!isObject(work) || Number(work.workTypeId) !== ASSESSMENT_WORK_TYPE) continue;
    for (const milestone of listOf(work.milestones)) {
      if (!isObject(milestone) || typeof milestone.name !== 'string' ||
          !milestone.name.startsWith(TRANSITION_MILESTONE) || !dayOf(milestone.actualDate)) continue;
      if (Number((/\b(\d{4})\b/.exec(milestone.name) || [])[1]) === fromYear) return milestone.actualDate;
    }
  }
  return null;
}

/** A sheet date before `TRACK_FROM`, else Track's milestone, else the stored fallback, else null. */
function transitionDateOf(transitionOut, projectWorks) {
  if (!isObject(transitionOut)) return null;
  const stored = dayOf(transitionOut.date) ? transitionOut.date : null;
  if (transitionOut.dateSource === 'sheet' && stored && dayOf(stored) < TRACK_FROM) return stored;
  const fromYear = actBefore(transitionOut.toActYear);
  const fromTrack = fromYear === null ? null : trackTransitionDateOf(projectWorks, fromYear);
  if (fromTrack) return fromTrack;
  return transitionOut.dateSource === 'track' ? stored : null;
}

/** Staff entries that overlap the work; an unknown-start entry only when the work is open on its `observedAt`. */
function inEffect(entries, work) {
  const { start, end } = workRangeOf(work || {});
  const found = [];
  for (const entry of listOf(entries).filter(isObject)) {
    if (entry.effectiveFrom === null || entry.effectiveFrom === undefined) {
      const seen = dayOf(entry.observedAt);
      if (seen && (!start || start <= seen) && (!end || seen <= end)) found.push({ ...entry, currentAsOf: entry.observedAt });
      continue;
    }
    const from = dayOf(entry.effectiveFrom);
    const to = dayOf(entry.effectiveTo);
    if (from && (!end || from <= end) && (!to || !start || start <= to)) found.push(entry);
  }
  return found;
}

/** `TRACK_FROM`, or the project's first completed 2018 Act Assessment decision in Track when earlier. */
function overrideBoundaryOf(trackWorks) {
  let boundary = TRACK_FROM;
  for (const work of listOf(trackWorks).filter(isObject)) {
    if (Number(work.workTypeId) !== ASSESSMENT_WORK_TYPE || work.workState !== 'COMPLETED') continue;
    const started = dayOf(work.startDate);
    const decided = dayOf(work.decisionDate);
    if (started && decided && started >= LEGISLATIONS[2018].inForce && decided < boundary) boundary = decided;
  }
  return boundary;
}

function settledBefore(trackWork, boundary) {
  const decided = dayOf(trackWork && trackWork.decisionDate);
  return decided ? decided < boundary : Boolean(trackWork) && trackWork.workState === 'COMPLETED';
}

const workTypeCodeOf = (work) => work.workTypeCode ?? TRACK_WORK_TYPE_CODES[work.workTypeId] ?? null;
const sourceOf = (work) => work.source ?? (String(work.id).startsWith('track-') ? 'track' : null);

function gapWithin(a, b, limit) {
  const x = dayOf(a);
  const y = dayOf(b);
  if (!x || !y) return null;
  const gap = Math.abs(daysBetween(x, y));
  return gap <= limit ? gap : null;
}

/** `{gap}` in days when both stand for one covered event, else null. */
function sameEvent(sheetWork, trackWork) {
  if (!isObject(sheetWork) || !isObject(trackWork) || sheetWork.projectId !== trackWork.projectId) return null;
  const code = workTypeCodeOf(sheetWork);
  if (!OVERRIDE_TYPES.includes(code) || workTypeCodeOf(trackWork) !== code) return null;
  const gaps = [
    gapWithin(sheetWork.startDate, trackWork.startDate, START_WINDOW_DAYS),
    gapWithin(sheetWork.decisionDate, trackWork.decisionDate, DECISION_WINDOW_DAYS)
  ].filter(gap => gap !== null);
  return gaps.length ? { gap: Math.min(...gaps) } : null;
}

const trackNumberOf = (work) => Number(work.trackWorkId ?? String(work.id).replace(/^track-/, ''));
const byTrackWork = (a, b) => (trackNumberOf(a) - trackNumberOf(b)) || compareText(a.id, b.id);

function choicesOf(candidates, pairs) {
  const choices = [];
  for (const [side, other] of [['track', 'sheet'], ['sheet', 'track']]) {
    const bySide = new Map();
    for (const c of candidates) bySide.set(c[side], [...(bySide.get(c[side]) || []), c]);
    for (const [work, list] of bySide) {
      if (list.length < 2) continue;
      const pair = pairs.find(p => p[side] === work) || null;
      choices.push({ side, work, pair, left: list.filter(c => c !== pair).map(c => ({ work: c[other], gap: c.gap })) });
    }
  }
  return choices;
}

/** One-to-one pairs by smallest gap, then Track work id, then sheet `sourceKey`; plus works with several candidates. */
function matchEvents(sheetWorks, trackWorks) {
  const candidates = [];
  for (const sheet of listOf(sheetWorks)) {
    for (const track of listOf(trackWorks)) {
      const hit = sameEvent(sheet, track);
      if (hit) candidates.push({ sheet, track, gap: hit.gap });
    }
  }
  candidates.sort((a, b) => a.gap - b.gap || byTrackWork(a.track, b.track) || compareText(a.sheet.sourceKey, b.sheet.sourceKey));
  const used = new Set();
  const pairs = [];
  for (const candidate of candidates) {
    if (used.has(candidate.sheet) || used.has(candidate.track)) continue;
    used.add(candidate.sheet).add(candidate.track);
    pairs.push(candidate);
  }
  return { pairs, sameEventChoice: choicesOf(candidates, pairs) };
}

/**
 * The read rule of the sheet override. `untilTrack` sheet works are left to the caller's `sameEvent`
 * check; a Track work hides only in a `hidden` pair whose sheet work is in `shownSheetIds`.
 */
function hiddenByOverride(work, marker, boundary, shownSheetIds) {
  if (!isObject(work) || !OVERRIDE_TYPES.includes(workTypeCodeOf(work))) return false;
  const active = isObject(marker) && marker.active === true;
  const source = sourceOf(work);
  if (source === 'sheet') {
    if (!active) return true;
    if (listOf(marker.untilTrack).includes(work.id)) return false;
    const decided = dayOf(work.decisionDate);
    return !(decided && decided < boundary);
  }
  if (source !== 'track' || !active) return false;
  const shown = new Set(shownSheetIds || []);
  const paired = listOf(marker.hidden)
    .some(pair => isObject(pair) && pair.trackWorkId === work.id && shown.has(pair.sheetWorkId));
  return paired && settledBefore(work, boundary);
}

module.exports = {
  OVERRIDE_MARKER_ID, OVERRIDE_TYPES, TRACK_RETIRED_WORK_TYPES, TRACK_WORK_TYPE_CODES,
  checkSize, childIdOf, hiddenByOverride, inEffect, matchEvents, newWorkId, overrideBoundaryOf,
  sameEvent, settledBefore, sourceKeyOf, summaryOf, transitionDateOf, validateMarker, validateWork
};
