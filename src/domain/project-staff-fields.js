'use strict';

// Staff-only history on a project row: external ids, contacts, capital investment and notes. Each
// array only grows; a correction is a new entry plus a close. Errors name a field and an index, never a value.

const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { check } = require('./_schema');
const { ADMIN_ROLES } = require('../helpers/access-sql');
const { logger } = require('../utils/logger');

const STAFF_ROLE_FIELDS = Object.freeze(['externalIds', 'staffAssignments', 'capitalInvestments', 'staffNotes']);

const ROLES = Object.freeze(['epd', 'lead']);

const SYSTEMS = Object.freeze({
  'eao-register': /^[1-9]\d{0,8}$/,
  // Assumed ORCS file number shape (primary-secondary, optional file part); no ORCS value is loaded yet.
  orcs: /^\d{5}-\d{2}(?:\/[A-Za-z0-9.-]{1,40})?$/
});

const MAX_ENTRIES = 200;

/** Which source's open entry is the current investment, first wins. */
const INVESTMENT_ORDER = Object.freeze(['demi', 'track', 'eagle', 'sheet']);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const DATE = { type: 'isoDate', nullable: true };
const WORK_ID = { type: 'string', max: 100, nullable: true };

/** What a caller may set on a new entry; `id`, `source`, `sheetKey`, `observedAt` and `recordedAt` are the server's. */
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

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isOpen = (entry) => entry.effectiveTo === null || entry.effectiveTo === undefined;
const closeable = (field) => Object.hasOwn(ENTRY_SCHEMAS[field], 'effectiveTo');
const endsBeforeStart = (from, to) => Boolean(from && to) && Date.parse(to) < Date.parse(from);

/** Why a new entry of `field` is refused, or null. */
function newEntryError(field, entry) {
  if (!isObject(entry)) return 'must be an object';
  const { amountCad, ...rest } = entry;
  const checked = check(ENTRY_SCHEMAS[field], field === 'capitalInvestments' ? rest : entry);
  if (checked.status !== 'ok') {
    const [key, message] = Object.entries(checked.fields)[0];
    return `${key} ${message}`;
  }
  for (const [key, value] of Object.entries(entry)) {
    if (typeof value !== 'string') continue;
    if (CONTROL.test(value)) return `${key} must not hold control characters`;
    if (!value.trim()) return `${key} must not be blank`;
  }
  if (field === 'capitalInvestments' && !(Number.isSafeInteger(amountCad) && amountCad >= 0)) {
    return 'amountCad must be a whole number of 0 or more';
  }
  if (field === 'externalIds' && !SYSTEMS[entry.system].test(entry.value)) {
    return `value is not a valid ${entry.system} id`;
  }
  return endsBeforeStart(entry.effectiveFrom, entry.effectiveTo) ? 'effectiveTo must not be before effectiveFrom' : null;
}

/** Why `sent` may not replace the stored entry `before`, or null. Only an open entry's close moves. */
function keptEntryError(field, before, sent) {
  if (!isObject(sent)) return 'must be an object';
  const { effectiveTo: to = null, ...rest } = sent;
  const { effectiveTo: was = null, ...kept } = before;
  if (!isDeepStrictEqual(rest, kept) || (to !== was && !closeable(field))) {
    return 'a stored entry cannot be edited; add a new entry and close this one';
  }
  if (to === was) return null;
  if (was !== null) return 'a closed entry cannot be changed';
  const checked = check({ effectiveTo: { type: 'isoDate' } }, { effectiveTo: to });
  if (checked.status !== 'ok') return `effectiveTo ${checked.fields.effectiveTo}`;
  return endsBeforeStart(before.effectiveFrom, to) ? 'effectiveTo must not be before effectiveFrom' : null;
}

/** A new entry with the server's keys stamped; `now` is an ISO timestamp. */
function stamp(field, entry, now) {
  if (field === 'externalIds') return { system: entry.system, value: entry.value, source: 'demi', recordedAt: now };
  return {
    id: randomUUID(), ...ENTRY_DEFAULTS[field], ...entry,
    observedAt: now.slice(0, 10), source: 'demi', sheetKey: null, recordedAt: now
  };
}

/** `{entries}` for `field` after a PUT sent `sent` over `stored`, or `{error}`. */
function nextEntries(field, stored, sent, now) {
  if (!Array.isArray(sent)) return { error: `${field} must be an array` };
  if (sent.length > MAX_ENTRIES) return { error: `${field} holds at most ${MAX_ENTRIES} entries` };
  if (sent.length < stored.length) return { error: `${field}: a stored entry cannot be removed` };
  const entries = [];
  for (const [index, entry] of sent.entries()) {
    const kept = index < stored.length;
    const error = kept ? keptEntryError(field, stored[index], entry) : newEntryError(field, entry);
    if (error) return { error: `${field}[${index}]: ${error}` };
    if (!kept) entries.push(stamp(field, entry, now));
    else entries.push(isOpen(entry) === isOpen(stored[index]) ? stored[index] : { ...stored[index], effectiveTo: entry.effectiveTo });
  }
  // A (system, value) pair is unique across projects, and no query checks that yet.
  if (field === 'externalIds' && entries.length > stored.length) {
    return { error: `externalIds[${stored.length}]: a new external id cannot be added until it can be checked against other projects` };
  }
  return { entries };
}

/** The staff fields `changes` sends that `access` may not write: service keys read them, people with a staff role write them. */
const unwritableStaffFields = (access, changes) => (access.roles.some(role => ADMIN_ROLES.includes(role))
  ? [] : STAFF_ROLE_FIELDS.filter(field => Object.hasOwn(changes, field)));

// The PUT diff rule: a sent staff field may only append entries and close open ones. `{values}` holds
// the arrays to store, or `{error}` names the first refused field and index; `context` goes in its log.
function staffFieldChanges(stored, changes, now, context = {}) {
  const values = {};
  for (const field of STAFF_ROLE_FIELDS) {
    if (!Object.hasOwn(changes, field)) continue;
    const result = nextEntries(field, Array.isArray(stored[field]) ? stored[field] : [], changes[field], now);
    if (result.error) {
      logger.warn('[Project Staff Fields] staff history refused', { ...context, error: result.error });
      return result;
    }
    values[field] = result.entries;
  }
  return { values };
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
  STAFF_ROLE_FIELDS,
  ROLES,
  SYSTEMS,
  MAX_ENTRIES,
  INVESTMENT_ORDER,
  unwritableStaffFields,
  staffFieldChanges,
  observeInvestment,
  currentInvestment
};
