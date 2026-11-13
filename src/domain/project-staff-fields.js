'use strict';

// Staff-only history on a project row: external ids, contacts, capital investment and notes. Each
// array only grows; a correction is a new entry plus a close. Errors name a field and an index, never a value.

const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { check } = require('./_schema');
const { ADMIN_ROLES } = require('../helpers/access-sql');
const { STAFF_ROLE_FIELDS } = require('../ownership/project');
const { SYSTEMS, MAX_ENTRIES } = require('../repositories/project-staff-history');
const { logger } = require('../utils/logger');

const ROLES = Object.freeze(['epd', 'lead']);

// Keeps the row well under the Cosmos 2 MB item limit whatever else it holds.
const MAX_BYTES = 256 * 1024;
const MAX_NEW_EXTERNAL_IDS = 20;

/** Which source's open entry is the current investment, first wins. */
const INVESTMENT_ORDER = Object.freeze(['demi', 'track', 'eagle', 'sheet']);

const SERVER_KEYS = Object.freeze(['id', 'source', 'sheetKey', 'observedAt', 'recordedAt']);
const TRIMMED_KEYS = Object.freeze(['name', 'text', 'value']);

// Control, bidi, zero-width and line/paragraph separator characters: none belongs in a name or a note.
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200d\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DATE = { type: 'isoDate', nullable: true };
const WORK_ID = { type: 'string', max: 100, nullable: true };

/** What a caller may set on a new entry; `SERVER_KEYS` are the server's. */
const ENTRY_SCHEMAS = Object.freeze({
  externalIds: {
    system: { type: 'enum', values: Object.keys(SYSTEMS), required: true },
    value: { type: 'string', max: 60, required: true }
  },
  staffAssignments: {
    role: { type: 'enum', values: ROLES, required: true },
    name: { type: 'string', max: 200, required: true },
    effectiveFrom: DATE,
    effectiveTo: DATE
  },
  // `amountCad` is checked apart: the schema has no integer type.
  capitalInvestments: { effectiveFrom: DATE, effectiveTo: DATE, workId: WORK_ID },
  staffNotes: {
    text: { type: 'string', max: 4000, required: true },
    workId: WORK_ID
  }
});

/** The keys a new entry starts with before the caller's values land on it. */
const ENTRY_DEFAULTS = Object.freeze({
  staffAssignments: { effectiveFrom: null, effectiveTo: null },
  capitalInvestments: { effectiveFrom: null, effectiveTo: null, workId: null },
  staffNotes: { workId: null }
});

const PACIFIC_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver' });

/** The America/Vancouver calendar day of ISO timestamp `now`, as `YYYY-MM-DD`. */
const pacificDay = (now) => PACIFIC_DAY.format(new Date(now));

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isOpen = (entry) => entry.effectiveTo === null || entry.effectiveTo === undefined;
const closeable = (field) => Object.hasOwn(ENTRY_SCHEMAS[field], 'effectiveTo');
const isDay = (value) => DAY.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

/** Why a close of an entry starting `from` on `to` is refused, or null; `today` is the Pacific day. */
function closeError(from, to, today) {
  if (to === null || to === undefined) return null;
  if (typeof to !== 'string' || !isDay(to)) return 'effectiveTo must be a date (YYYY-MM-DD)';
  if (to > today) return 'effectiveTo must not be in the future';
  return from && to < from ? 'effectiveTo must not be before effectiveFrom' : null;
}

/** `entry` with `name`, `text` and `value` trimmed. */
const trimmed = (entry) => (isObject(entry) ? Object.fromEntries(Object.entries(entry).map(([key, value]) =>
  [key, TRIMMED_KEYS.includes(key) && typeof value === 'string' ? value.trim() : value])) : entry);

/** Why a new (trimmed) entry of `field` is refused, or null. */
function newEntryError(field, entry, today) {
  if (!isObject(entry)) return 'must be an object';
  const { amountCad, ...rest } = entry;
  const checked = check(ENTRY_SCHEMAS[field], field === 'capitalInvestments' ? rest : entry);
  if (checked.status !== 'ok') {
    const [key, message] = Object.entries(checked.fields)[0];
    if (message !== 'is not a writable field') return `${key} ${message}`;
    return SERVER_KEYS.includes(key) ? `${key} is set by the server` : 'unknown key';
  }
  for (const [key, value] of Object.entries(entry)) {
    if (typeof value !== 'string') continue;
    if (HIDDEN.test(value)) return `${key} must not hold control or invisible characters`;
    if (!value.trim()) return `${key} must not be blank`;
  }
  if (field === 'capitalInvestments' && !(Number.isSafeInteger(amountCad) && amountCad >= 0)) {
    return 'amountCad must be a whole number of 0 or more';
  }
  if (field === 'externalIds' && !SYSTEMS[entry.system].test(entry.value)) {
    return `value is not a valid ${entry.system} id`;
  }
  if (typeof entry.effectiveFrom === 'string' && !isDay(entry.effectiveFrom)) return 'effectiveFrom must be a date (YYYY-MM-DD)';
  return closeError(entry.effectiveFrom, entry.effectiveTo, today);
}

/** Why `sent` may not replace the stored entry `before`, or null. Only an open entry's close moves. */
function keptEntryError(field, before, sent, today) {
  if (!isObject(sent)) return 'must be an object';
  const { effectiveTo: to = null, ...rest } = sent;
  const { effectiveTo: was = null, ...kept } = before;
  if (!isDeepStrictEqual(rest, kept) || (to !== was && !closeable(field))) {
    return 'a stored entry cannot be edited; add a new entry and close this one';
  }
  if (to === was) return null;
  if (was !== null) return 'a closed entry cannot be changed';
  return closeError(before.effectiveFrom, to, today);
}

/** A new entry with the server's keys stamped; `now` is an ISO timestamp. */
function stamp(field, entry, now) {
  if (field === 'externalIds') return { system: entry.system, value: entry.value, source: 'demi', recordedAt: now };
  return {
    id: randomUUID(), ...ENTRY_DEFAULTS[field], ...entry,
    observedAt: pacificDay(now), source: 'demi', sheetKey: null, recordedAt: now
  };
}

// A kept entry that fails at `index` while everything from there on is a valid new entry: the client
// appended to an older copy of the list, so it must read again rather than fix its body.
const appendedToOlderCopy = (field, sent, index, today) => index < sent.length &&
  sent.slice(index).every(entry => !newEntryError(field, trimmed(entry), today));

/** Index of the first entry from `from` on whose (system, value) an earlier entry holds, value case-blind; else -1. */
function repeatedIdIndex(entries, from) {
  const keys = entries.map(entry => `${entry.system} ${String(entry.value).toLowerCase()}`);
  return keys.findIndex((key, index) => index >= from && keys.indexOf(key) < index);
}

/** `{entries}` for `field` after a PUT sent `sent` over `stored`, or `{error}` (`stale` when the list moved). */
function nextEntries(field, stored, sent, now) {
  if (!Array.isArray(sent)) return { error: `${field}: must be an array` };
  if (sent.length > MAX_ENTRIES) return { error: `${field}[${MAX_ENTRIES}]: at most ${MAX_ENTRIES} entries` };
  // All appended ids go to one query across every project; the cap limits probing which values exist.
  if (field === 'externalIds' && sent.length - stored.length > MAX_NEW_EXTERNAL_IDS) {
    return { error: `externalIds: at most ${MAX_NEW_EXTERNAL_IDS} new external ids per request` };
  }
  const today = pacificDay(now);
  const entries = [];
  for (const [index, given] of sent.entries()) {
    const entry = trimmed(given);
    if (index < stored.length) {
      if (!isObject(stored[index])) return { error: `${field}[${index}]: the stored entry is unreadable` };
      const error = keptEntryError(field, stored[index], given, today);
      if (error && appendedToOlderCopy(field, sent, index, today)) {
        return { error: `${field}[${index}]: the stored list gained entries since it was read; read the project again`, stale: true };
      }
      if (error) return { error: `${field}[${index}]: ${error}` };
      entries.push(isOpen(given) === isOpen(stored[index]) ? stored[index] : { ...stored[index], effectiveTo: given.effectiveTo });
      continue;
    }
    const error = newEntryError(field, entry, today);
    if (error) return { error: `${field}[${index}]: ${error}` };
    entries.push(stamp(field, entry, now));
  }
  if (sent.length < stored.length) return { error: `${field}[${sent.length}]: a stored entry cannot be removed` };
  // Other projects are checked against the store when the write runs (project-staff-history.js).
  const repeat = field === 'externalIds' ? repeatedIdIndex(entries, stored.length) : -1;
  if (repeat >= 0) return { error: `externalIds[${repeat}]: the list already holds this id (compared without case)` };
  return { entries };
}

/** The staff fields `changes` sends that `access` may not write: service keys read them, people with a staff role write them. */
const unwritableStaffFields = (access, changes) => (access.roles.some(role => ADMIN_ROLES.includes(role))
  ? [] : STAFF_ROLE_FIELDS.filter(field => Object.hasOwn(changes, field)));

/** The PUT diff rule over `stored`'s lists; `{values}` to store, or the first refusal. */
function diffStaffFields(stored, changes, now) {
  const values = {};
  for (const field of STAFF_ROLE_FIELDS) {
    if (!Object.hasOwn(changes, field)) continue;
    const current = stored[field] === undefined ? [] : stored[field];
    if (!Array.isArray(current)) return { error: `${field}: the stored value is unreadable` };
    const result = nextEntries(field, current, changes[field], now);
    if (result.error) return result;
    values[field] = result.entries;
  }
  const lists = STAFF_ROLE_FIELDS.map(field => (Object.hasOwn(values, field) ? values[field] : stored[field]));
  if (Object.keys(values).length && Buffer.byteLength(JSON.stringify(lists)) > MAX_BYTES) {
    return { error: `staff history: the four lists together may hold at most ${MAX_BYTES / 1024} KB` };
  }
  return { values };
}

// A sent staff field may only append entries and close open ones. `{values}` holds the arrays to
// store, or `{error}` (with `stale` when the stored list moved) names the field and index; `context` is logged.
function staffFieldChanges(stored, changes, now, context = {}) {
  const result = diffStaffFields(stored, changes, now);
  if (result.error) logger.warn('[Project Staff Fields] staff history refused', { ...context, error: result.error });
  return result;
}

/** An upstream amount as whole dollars, or undefined: a number is rounded, a string must be digits, `$`, commas and spaces. */
function readAmount(value) {
  let amount;
  if (typeof value === 'number') amount = value;
  else if (typeof value === 'string' && /^[\s$]*\d[\d,\s]*$/.test(value)) amount = Number(value.replace(/[\s$,]/g, ''));
  else return undefined;
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  const rounded = Math.round(amount);
  return Number.isSafeInteger(rounded) ? rounded : undefined;
}

// `status` is `empty` (null, blank, 0), `unreadable`, `unchanged`, `full` or `append`; `append` carries
// the new entry and the `close` of that source's open entry, to apply in one patch.
function observeInvestment(entries, source, value, runDate) {
  const list = Array.isArray(entries) ? entries : [];
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return { status: 'empty' };
  const amountCad = readAmount(value);
  if (amountCad === undefined) return { status: 'unreadable' };
  if (amountCad === 0) return { status: 'empty' };
  const own = list.flatMap((entry, index) => (isObject(entry) && entry.source === source ? [{ entry, index }] : []));
  if (own.length && own.at(-1).entry.amountCad === amountCad) return { status: 'unchanged' };
  if (list.length >= MAX_ENTRIES) return { status: 'full' };
  const open = own.filter(({ entry }) => isOpen(entry)).at(-1);
  return {
    status: 'append',
    ...(open && { close: { index: open.index, id: open.entry.id, effectiveTo: runDate } }),
    append: {
      id: randomUUID(), amountCad, effectiveFrom: own.length ? runDate : null, effectiveTo: null,
      observedAt: runDate, workId: null, source, sheetKey: null, recordedAt: new Date().toISOString()
    }
  };
}

/** The open entry of the first source in `INVESTMENT_ORDER` that has one, or null. */
function currentInvestment(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter(isObject);
  for (const source of INVESTMENT_ORDER) {
    const open = list.filter(entry => entry.source === source && isOpen(entry)).at(-1);
    if (open) return open;
  }
  return null;
}

module.exports = {
  ENTRY_SCHEMAS,
  SERVER_KEYS,
  unwritableStaffFields,
  staffFieldChanges,
  observeInvestment,
  currentInvestment
};
