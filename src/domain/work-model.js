'use strict';

// Work documents in the `works` container: ids, validation, summary, staff entries in effect and
// transition dates. Pure; owner rules live in repositories/works.js, override rules in work-override.js.

const { randomUUID } = require('node:crypto');
const { LEGISLATIONS } = require('./project-legislation');
const { ASSESSMENT_WORK_TYPE } = require('../merge/assessment-work');
const { TRANSITION_MILESTONE } = require('../merge/track-derived');
const override = require('./work-override');

const {
  TRACK_FROM, WORK_ID_PATTERNS, controlErrors, dayOf, daysBetween, eachString, given, isObject, listOf
} = override;

const ACT_YEARS = Object.freeze(Object.keys(LEGISLATIONS).map(Number).sort((a, b) => a - b));
const MAX_BYTES = 1.5 * 1024 * 1024;
const MAX_CHILDREN = 2000;
/** Track work type ids whose works an audited route may adopt. */
const TRACK_RETIRED_WORK_TYPES = Object.freeze([]);

const DATE_KEYS = Object.freeze(['startDate', 'decisionDate', 'anticipatedDecisionDate', 'newExpiryDate',
  'endDate', 'actualDate', 'anticipatedDate']);
// Strings a public reader can see, or that a public string is built from.
const PUBLIC_TEXT_KEYS = new Set(['title', 'simpleTitle', 'workType', 'outcome', 'name', 'trackName', 'eaAct',
  'sourceName', 'legalSection']);
// Staff-only project fields; a work document must never carry them.
const STAFF_KEYS = Object.freeze(['staff', 'staffNotes', 'staffAssignments', 'capitalInvestments', 'externalIds',
  'notes', 'contacts', 'investment', 'intake']);
const INTERRUPTION_KINDS = Object.freeze(['extension', 'suspension', 'interregnum']);

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

function checkSize(doc) {
  const children = phasesOf(doc)
    .reduce((n, phase) => n + childrenOf(phase, 'milestones').length + childrenOf(phase, 'interruptions').length, 0);
  const over = children > MAX_CHILDREN || Buffer.byteLength(JSON.stringify(doc)) > MAX_BYTES;
  return over ? { ok: false, reason: 'oversize' } : { ok: true };
}

/** A staff key at any depth, and `<` in public text. */
const contentErrors = (doc, errors) => eachString(doc, (text, path, key) => {
  if (key === null && STAFF_KEYS.includes(text)) errors.push({ path: path ? `${path}.${text}` : text, rule: 'staff-data' });
  if (PUBLIC_TEXT_KEYS.has(key) && text.includes('<')) errors.push({ path, rule: 'markup' });
});

/** Calls `visit(child, path)` for each object in `owner[key]`; a non-list or a non-object child is an error. */
function eachChild(owner, key, path, errors, visit) {
  const at = path ? `${path}.${key}` : key;
  if (owner[key] === undefined) return;
  if (!Array.isArray(owner[key])) {
    errors.push({ path: at, rule: 'list' });
    return;
  }
  owner[key].forEach((child, i) => (isObject(child) ? visit(child, `${at}.${i}`) : errors.push({ path: `${at}.${i}`, rule: 'object' })));
}

function itemErrors(item, path, [startKey, endKey], errors) {
  const at = (key) => (path ? `${path}.${key}` : key);
  for (const key of DATE_KEYS) if (given(item[key]) && !dayOf(item[key])) errors.push({ path: at(key), rule: 'date' });
  const start = dayOf(item[startKey]);
  const end = dayOf(item[endKey]);
  if (start && end && end < start) errors.push({ path: at(endKey), rule: 'end-before-start' });
  if (item.undated !== undefined && !isObject(item.undated)) errors.push({ path: at('undated'), rule: 'undated' });
  for (const [key, entry] of Object.entries(isObject(item.undated) ? item.undated : {})) {
    if (!DATE_KEYS.includes(key)) {
      errors.push({ path: at('undated'), rule: 'undated-key' });
      continue;
    }
    if (given(item[key])) errors.push({ path: at(`undated.${key}`), rule: 'undated-holds-date' });
    if (!isObject(entry) || !dayOf(entry.notAfter)) errors.push({ path: at(`undated.${key}`), rule: 'undated' });
  }
}

function identityErrors(doc, errors) {
  const id = typeof doc.id === 'string' ? doc.id : '';
  const idSource = Object.keys(WORK_ID_PATTERNS).find(source => WORK_ID_PATTERNS[source].test(id));
  if (!idSource) errors.push({ path: 'id', rule: 'id' });
  const sourceBad = !Object.hasOwn(WORK_ID_PATTERNS, doc.source) || (idSource && doc.source !== idSource);
  if (given(doc.source) && sourceBad) errors.push({ path: 'source', rule: 'source' });
  if (typeof doc.projectId !== 'string' || !doc.projectId) errors.push({ path: 'projectId', rule: 'required' });
  if (idSource === 'track') return;
  for (const key of ['source', 'workTypeCode']) {
    if (typeof doc[key] !== 'string' || !doc[key]) errors.push({ path: key, rule: 'required' });
  }
}

function transitionErrors(doc, errors) {
  if (!given(doc.transitionOut)) return;
  const { date, dateSource, toActYear } = isObject(doc.transitionOut) ? doc.transitionOut : {};
  const at = (key) => `transitionOut.${key}`;
  if (!['sheet', 'track', 'none'].includes(dateSource)) errors.push({ path: at('dateSource'), rule: 'date-source' });
  if (given(date) && dateSource !== 'sheet' && dateSource !== 'track') errors.push({ path: at('date'), rule: 'date-source' });
  if (given(date) && !dayOf(date)) errors.push({ path: at('date'), rule: 'date' });
  if (dateSource === 'sheet' && dayOf(date) >= TRACK_FROM) errors.push({ path: at('date'), rule: 'sheet-date-after' });
  if (!ACT_YEARS.includes(toActYear) || !ACT_YEARS.includes(doc.actYear) || toActYear <= doc.actYear) {
    errors.push({ path: at('toActYear'), rule: 'act-year' });
  }
}

function interruptionErrors(interruption, path, errors) {
  itemErrors(interruption, path, ['startDate', 'endDate'], errors);
  if (!INTERRUPTION_KINDS.includes(interruption.kind)) errors.push({ path: `${path}.kind`, rule: 'kind' });
  const days = interruptionSpanOf(interruption, {});
  if (given(interruption.days) && days !== null && interruption.days !== days) errors.push({ path: `${path}.days`, rule: 'days' });
}

function workErrors(doc) {
  const errors = [];
  controlErrors(doc, errors);
  contentErrors(doc, errors);
  identityErrors(doc, errors);
  if (given(doc.actYear) && !ACT_YEARS.includes(doc.actYear)) errors.push({ path: 'actYear', rule: 'act-year' });
  itemErrors(doc, '', ['startDate', 'decisionDate'], errors);
  transitionErrors(doc, errors);
  // Child ids are unique within the document and never embed the work id, which may be random.
  const seen = new Set();
  const checkId = (child, path) => {
    if (child.id === undefined) return;
    const bad = typeof child.id !== 'string' || !child.id || seen.has(child.id) || (Boolean(doc.id) && child.id.includes(doc.id));
    if (bad) errors.push({ path: `${path}.id`, rule: 'child-id' });
    seen.add(child.id);
  };
  eachChild(doc, 'phases', '', errors, (phase, at) => {
    itemErrors(phase, at, ['startDate', 'endDate'], errors);
    checkId(phase, at);
    eachChild(phase, 'milestones', at, errors, (milestone, path) => {
      itemErrors(milestone, path, ['actualDate', 'endDate'], errors);
      checkId(milestone, path);
    });
    eachChild(phase, 'interruptions', at, errors, (interruption, path) => {
      interruptionErrors(interruption, path, errors);
      checkId(interruption, path);
    });
  });
  return errors;
}

/** `{ok:true}`, `{ok:false, reason:'oversize'}`, or `{ok:false, reason:'invalid', errors:[{path, rule}]}`. */
function validateWork(doc) {
  if (!isObject(doc)) return { ok: false, reason: 'invalid', errors: [{ path: '', rule: 'object' }] };
  const size = checkSize(doc);
  if (!size.ok) return size;
  const errors = workErrors(doc);
  return errors.length ? { ok: false, reason: 'invalid', errors } : { ok: true };
}

const OPEN_END = '9999-12-31';

/** The last phase by `sortOrder` when phases carry one, else by latest end; an open phase ends last. */
function lastPhaseOf(phases) {
  const ordered = phases.filter(phase => Number.isFinite(phase.sortOrder));
  if (ordered.length) return ordered.reduce((a, b) => (b.sortOrder >= a.sortOrder ? b : a));
  const endOf = (phase) => dayOf(phase.endDate) ?? OPEN_END;
  return phases.reduce((a, b) => (endOf(b) >= endOf(a) ? b : a), phases[0]);
}

/** From `startDate` to `decisionDate`, else the last phase's `endDate`; a null end is open. */
function workRangeOf(work) {
  const phases = phasesOf(work);
  const last = phases.length ? lastPhaseOf(phases) : null;
  return { start: dayOf(work.startDate), end: dayOf(work.decisionDate) ?? (last ? dayOf(last.endDate) : null) };
}

const spanOf = (from, to) => (from && to ? Math.max(0, daysBetween(from, to)) : null);
const totalOf = (spans) => (spans.includes(null) ? null : spans.reduce((a, b) => a + b, 0));

/** End minus start, clamped to the work's range; null when either date is unknown. */
function interruptionSpanOf(interruption, { start, end }) {
  const from = dayOf(interruption.startDate);
  const to = dayOf(interruption.endDate);
  if (!from || !to) return null;
  return spanOf(start && from < start ? start : from, end && to > end ? end : to);
}

function summaryOf(work) {
  const range = workRangeOf(work);
  const phases = phasesOf(work);
  const interruptions = phases.flatMap(phase => childrenOf(phase, 'interruptions'));
  const daysOf = (kind) => totalOf(interruptions.filter(x => x.kind === kind).map(x => interruptionSpanOf(x, range)));
  const elapsedDays = spanOf(range.start, range.end);
  const suspendedDays = daysOf('suspension');
  const decided = dayOf(work.decisionDate);
  return {
    elapsedDays,
    suspendedDays,
    extensionDays: daysOf('extension'),
    effortDays: elapsedDays === null || suspendedDays === null ? null : Math.max(0, elapsedDays - suspendedDays),
    phaseDays: phases.length ? totalOf(phases.map(phase => spanOf(dayOf(phase.startDate), dayOf(phase.endDate)))) : null,
    decisionYear: decided ? Number(decided.slice(0, 4)) : null
  };
}

// Accepts what legislationTransitions in merge/track-derived.js accepts, so both give one date.
const isDated = (value) => value !== undefined && value !== null && String(value).trim() !== '';

/** Track's "Project Transitioning FROM ..." milestone date naming `fromYear`, over public-shape works. */
function trackTransitionDateOf(projectWorks, fromYear) {
  for (const work of listOf(projectWorks)) {
    if (!work || work.workTypeId !== ASSESSMENT_WORK_TYPE || !Array.isArray(work.milestones)) continue;
    for (const milestone of work.milestones) {
      if (!milestone || typeof milestone.name !== 'string' ||
          !milestone.name.startsWith(TRANSITION_MILESTONE) || !isDated(milestone.actualDate)) continue;
      if (Number((/\b(\d{4})\b/.exec(milestone.name) || [])[1]) === fromYear) return milestone.actualDate;
    }
  }
  return null;
}

/**
 * A sheet date before `TRACK_FROM`, else Track's milestone naming the work's own `actYear`,
 * else the stored fallback, else null.
 */
function transitionDateOf(transitionOut, projectWorks, actYear) {
  if (!isObject(transitionOut)) return null;
  const stored = dayOf(transitionOut.date) ? transitionOut.date : null;
  if (transitionOut.dateSource === 'sheet' && stored && dayOf(stored) < TRACK_FROM) return stored;
  const fromTrack = ACT_YEARS.includes(actYear) ? trackTransitionDateOf(projectWorks, actYear) : null;
  if (fromTrack) return fromTrack;
  return transitionOut.dateSource === 'track' ? stored : null;
}

/** Staff entries that overlap the work; an unknown-start entry only when the work is open on its `observedAt`. */
function inEffect(entries, work) {
  const { start, end } = workRangeOf(work || {});
  const found = [];
  for (const entry of listOf(entries).filter(isObject)) {
    if (!given(entry.effectiveFrom)) {
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

module.exports = {
  OVERRIDE_MARKER_ID: override.OVERRIDE_MARKER_ID,
  OVERRIDE_TYPES: override.OVERRIDE_TYPES,
  TRACK_FROM,
  TRACK_RETIRED_WORK_TYPES,
  TRACK_WORK_TYPE_CODES: override.TRACK_WORK_TYPE_CODES,
  checkSize, childIdOf, dayOf, inEffect, newWorkId, sourceKeyOf, summaryOf, transitionDateOf, validateWork, workRangeOf,
  compareText: override.compareText,
  hiddenByOverride: override.hiddenByOverride,
  matchEvents: override.matchEvents,
  overrideBoundaryOf: override.overrideBoundaryOf,
  sameEvent: override.sameEvent,
  settledBefore: override.settledBefore,
  sourceOf: override.sourceOf,
  untilTrackHidden: override.untilTrackHidden,
  validateMarker: override.validateMarker
};
