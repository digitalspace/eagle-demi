'use strict';

// The sheet override of Track's post-decision works, plus the calendar-day and id rules that
// work-model.js shares. Pure; work-model.js re-exports every name, so callers import that module.

const { LEGISLATIONS } = require('./project-legislation');
const { ASSESSMENT_WORK_TYPE } = require('../merge/assessment-work');

/** Track supplies every record dated on or after this day. */
const TRACK_FROM = '2025-01-01';
const OVERRIDE_MARKER_ID = 'sheet-override';
const OVERRIDE_TYPES = Object.freeze(['amendment', 'eac-extension', 'substantial-start']);
const TRACK_WORK_TYPE_CODES = Object.freeze({
  1: 'project-notification', 2: 'minister-designation', 3: 'ceao-designation', 5: 'exemption-order',
  6: 'assessment', 7: 'amendment', 9: 'eac-extension', 10: 'substantial-start', 11: 'transfer',
  15: 'material-alteration', 16: 'amendment'
});
const START_WINDOW_DAYS = 31;
const DECISION_WINDOW_DAYS = 60;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const WORK_ID_PATTERNS = Object.freeze({
  track: /^track-\d+$/,
  sheet: new RegExp(`^sheet-${UUID}$`),
  demi: new RegExp(`^demi-${UUID}$`)
});

const given = (value) => value !== undefined && value !== null;
const listOf = (value) => (Array.isArray(value) ? value : []);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const compareText = (a, b) => (String(a ?? '') < String(b ?? '') ? -1 : String(a ?? '') > String(b ?? '') ? 1 : 0);

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const PACIFIC_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit'
});

function isCalendarDay(day) {
  if (!DATE_ONLY.test(day)) return false;
  const [year, month, date] = day.split('-').map(Number);
  const at = new Date(Date.UTC(year, month - 1, date));
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === date;
}

/**
 * A bare `YYYY-MM-DD` as written, or the Pacific calendar day of a zoned timestamp: Track stamps
 * UTC clock times, so a BC evening is the next UTC day. Anything else, an unknown date too, is null.
 */
function dayOf(value) {
  if (typeof value !== 'string') return null;
  if (DATE_ONLY.test(value)) return isCalendarDay(value) ? value : null;
  const match = TIMESTAMP.exec(value);
  const at = match && isCalendarDay(match[1]) ? new Date(value) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  const parts = Object.fromEntries(PACIFIC_DAY.formatToParts(at).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);

const hasControl = (text) => [...text].some((ch) => {
  const code = ch.codePointAt(0);
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
});

/** Calls `visit(text, path, key)` for every key and string under `value`; an odd key shows as `*` in paths. */
function eachString(value, visit, path = '', key = null) {
  if (typeof value === 'string') return visit(value, path, key);
  if (value === null || typeof value !== 'object') return undefined;
  for (const [name, child] of Object.entries(value)) {
    visit(name, path, null);
    const step = /^[A-Za-z0-9_-]{1,64}$/.test(name) ? name : '*';
    eachString(child, visit, path ? `${path}.${step}` : step, name);
  }
  return undefined;
}

const controlErrors = (value, errors) => eachString(value, (text, path) => {
  if (hasControl(text)) errors.push({ path, rule: 'control-character' });
});

/** `track`, `sheet` or `demi` from `source`, else from the id prefix; null for anything else. */
function sourceOf(work) {
  if (given(work.source)) return work.source;
  const id = String(work.id);
  return Object.keys(WORK_ID_PATTERNS).find(source => id.startsWith(`${source}-`)) || null;
}

const workTypeCodeOf = (work) => work.workTypeCode ?? TRACK_WORK_TYPE_CODES[work.workTypeId] ?? null;

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

function gapWithin(a, b, limit) {
  const x = dayOf(a);
  const y = dayOf(b);
  if (!x || !y) return null;
  const gap = Math.abs(daysBetween(x, y));
  return gap <= limit ? gap : null;
}

/** `{gap}` in days when both stand for one covered event on one project, else null. */
function sameEvent(sheetWork, trackWork) {
  if (!isObject(sheetWork) || !isObject(trackWork)) return null;
  if (!given(sheetWork.projectId) || sheetWork.projectId !== trackWork.projectId) return null;
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

const isActive = (marker) => isObject(marker) && marker.active === true;

/**
 * The read rule of the sheet override. `untilTrack` sheet works are left to `untilTrackHidden`;
 * a Track work hides only in a `hidden` pair whose sheet work is in `shownSheetIds`.
 */
function hiddenByOverride(work, marker, boundary, shownSheetIds) {
  if (!isObject(work) || !OVERRIDE_TYPES.includes(workTypeCodeOf(work))) return false;
  const source = sourceOf(work);
  if (source === 'sheet') {
    if (!isActive(marker)) return true;
    if (listOf(marker.untilTrack).includes(work.id)) return false;
    const decided = dayOf(work.decisionDate);
    return !(decided && decided < boundary);
  }
  if (source !== 'track' || !isActive(marker)) return false;
  const shown = new Set(shownSheetIds || []);
  const paired = listOf(marker.hidden)
    .some(pair => isObject(pair) && pair.trackWorkId === work.id && shown.has(pair.sheetWorkId));
  return paired && settledBefore(work, boundary);
}

/**
 * Ids of `untilTrack` sheet works that a Track work outside `pairedTrackWorkIds` now stands for.
 * Each such Track work takes only its smallest-gap sheet work, ties by `sourceKey`.
 */
function untilTrackHidden(sheetWorks, trackWorks, marker) {
  const hidden = new Set();
  if (!isActive(marker)) return hidden;
  const waiting = listOf(sheetWorks).filter(work => isObject(work) && listOf(marker.untilTrack).includes(work.id));
  const paired = new Set(listOf(marker.pairedTrackWorkIds));
  for (const track of listOf(trackWorks).filter(work => isObject(work) && !paired.has(work.id))) {
    const [best] = waiting.map(sheet => ({ sheet, hit: sameEvent(sheet, track) }))
      .filter(candidate => candidate.hit)
      .sort((a, b) => a.hit.gap - b.hit.gap || compareText(a.sheet.sourceKey, b.sheet.sourceKey));
    if (best) hidden.add(best.sheet.id);
  }
  return hidden;
}

const isTrackId = (id) => typeof id === 'string' && WORK_ID_PATTERNS.track.test(id);
const isSheetId = (id) => typeof id === 'string' && WORK_ID_PATTERNS.sheet.test(id);
const hasRepeat = (values) => new Set(values).size !== values.length;

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

function markerPairErrors(marker, errors) {
  const hiddenTrack = listOf(marker.hidden).filter(isObject).map(pair => pair.trackWorkId);
  const hiddenSheet = listOf(marker.hidden).filter(isObject).map(pair => pair.sheetWorkId);
  const aliveTrack = listOf(marker.trackAlive).filter(isObject).map(pair => pair.trackWorkId);
  const untilTrack = listOf(marker.untilTrack);
  const paired = new Set(listOf(marker.pairedTrackWorkIds));
  if (hasRepeat(hiddenTrack)) errors.push({ path: 'hidden', rule: 'repeated-track-work' });
  if (hasRepeat(hiddenSheet)) errors.push({ path: 'hidden', rule: 'repeated-sheet-work' });
  if (hasRepeat(aliveTrack)) errors.push({ path: 'trackAlive', rule: 'repeated-track-work' });
  if (hasRepeat(untilTrack)) errors.push({ path: 'untilTrack', rule: 'repeated-sheet-work' });
  if (hasRepeat(listOf(marker.pairedTrackWorkIds))) errors.push({ path: 'pairedTrackWorkIds', rule: 'repeated-track-work' });
  if (untilTrack.some(id => hiddenSheet.includes(id))) errors.push({ path: 'untilTrack', rule: 'hidden-and-until-track' });
  if (aliveTrack.some(id => hiddenTrack.includes(id))) errors.push({ path: 'trackAlive', rule: 'hidden-and-alive' });
  if ([...hiddenTrack, ...aliveTrack].some(id => !paired.has(id))) errors.push({ path: 'pairedTrackWorkIds', rule: 'unpaired' });
}

/** `{ok:true}` or `{ok:false, reason:'invalid', errors:[{path, rule}]}`; errors never carry a value. */
function validateMarker(marker) {
  if (!isObject(marker)) return { ok: false, reason: 'invalid', errors: [{ path: '', rule: 'object' }] };
  const errors = [];
  controlErrors(marker, errors);
  const need = (ok, path, rule) => { if (!ok) errors.push({ path, rule }); };
  need(marker.id === OVERRIDE_MARKER_ID, 'id', 'marker-id');
  need(marker.kind === 'override', 'kind', 'kind');
  need(marker.source === 'sheet', 'source', 'source');
  need(marker.owner === 'sheet', 'owner', 'owner');
  need(typeof marker.active === 'boolean', 'active', 'boolean');
  need(typeof marker.batchId === 'string' && marker.batchId !== '', 'batchId', 'required');
  need(isObject(marker.provenance), 'provenance', 'required');
  need(Number.isInteger(marker.schemaVersion), 'schemaVersion', 'required');
  const boundary = DATE_ONLY.test(String(marker.boundaryAtLoad)) ? dayOf(marker.boundaryAtLoad) : null;
  need(Boolean(boundary) && boundary >= LEGISLATIONS[2018].inForce && boundary <= TRACK_FROM, 'boundaryAtLoad', 'boundary');
  markerListErrors(marker, errors);
  markerPairErrors(marker, errors);
  return errors.length ? { ok: false, reason: 'invalid', errors } : { ok: true };
}

module.exports = {
  OVERRIDE_MARKER_ID, OVERRIDE_TYPES, TRACK_FROM, TRACK_WORK_TYPE_CODES, WORK_ID_PATTERNS,
  compareText, controlErrors, dayOf, daysBetween, eachString, gapWithin, given, hasControl, isObject, listOf, sourceOf,
  hiddenByOverride, matchEvents, overrideBoundaryOf, sameEvent, settledBefore, untilTrackHidden, validateMarker,
  workTypeCodeOf
};
