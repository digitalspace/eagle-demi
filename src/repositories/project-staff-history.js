'use strict';

// The loader's and the nightly's writes to a project row's staff history: etag-guarded patches of one list
// that leave `updatedAt` and `dateUpdated` alone and never touch an entry staff wrote (`source` demi).

const { createHash } = require('node:crypto');
const cosmos = require('../db/cosmos-nosql');
const { writeGuarded } = require('../helpers/etag-write');
const { logger } = require('../utils/logger');
const { eagleOnlyProjectId } = require('../merge/project');
const { fetchAll } = require('./_sql');
const { CONTAINER, readForWrite } = require('./projects');

/** The id systems and the shape of each value; the PUT (src/domain/project-staff-fields.js) holds to them too. */
const SYSTEMS = Object.freeze({
  'eao-register': /^[1-9]\d{0,8}$/,
  // Assumed ORCS file number shape (primary-secondary, optional file part); no ORCS value is loaded yet.
  orcs: /^\d{5}-\d{2}(?:\/[A-Za-z0-9.-]{1,40})?$/
});
const MAX_ENTRIES = 200;

const HISTORY_FIELDS = Object.freeze(['staffAssignments', 'capitalInvestments', 'staffNotes']);
const CLOSEABLE_FIELDS = Object.freeze(['staffAssignments', 'capitalInvestments']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameValue = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const holds = (entry, { system, value }) => isObject(entry) && entry.system === system && sameValue(entry.value, value);
const byId = (list, entryId) => list.findIndex(entry => isObject(entry) && entry.id === entryId);

// Each system's pattern is anchored ASCII, so no padded, look-alike or non-string copy of a value passes.
function checkedPair({ system, value } = {}) {
  if (!Object.hasOwn(SYSTEMS, system) || typeof value !== 'string' || !SYSTEMS[system].test(value)) {
    throw new TypeError('[project history] an external id needs a known system and a value of its shape');
  }
  return { system, value };
}

function checkedSource(source) {
  if (typeof source !== 'string' || !source || source === 'demi') {
    throw new TypeError('[project history] source must name the writer; staff entries go through the project PUT');
  }
}

function checkedField(field, fields = HISTORY_FIELDS) {
  if (!fields.includes(field)) throw new TypeError(`[project history] ${field} is not one of ${fields.join(', ')}`);
}

function listOf(row, field) {
  if (row[field] === undefined) return [];
  if (!Array.isArray(row[field])) throw new Error(`[project history] ${field} on project ${row.id} is not a list`);
  return row[field];
}

/** JSON with object keys sorted at every depth; an `undefined` key is dropped, as `JSON.stringify` does. */
const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!isObject(value)) return JSON.stringify(value ?? null);
  return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
};

/** SHA-256 of an entry, so a backup's hash matches the stored entry whatever the key order. */
const historyEntrySha256 = (entry) => createHash('sha256').update(stableJson(entry)).digest('hex');

/** `attempt(row, set)` under the row etag; `set(field, list)` writes one list. `missing` when there is no row. */
async function guarded(id, attempt) {
  const key = String(id);
  return writeGuarded({
    existing: await readForWrite(key),
    reread: () => readForWrite(key),
    attempt: async (row) => {
      if (!row) return { status: 'missing' };
      const set = (field, value) => cosmos.patch(CONTAINER, key, key, [{ op: 'set', path: `/${field}`, value }], undefined, row._etag);
      return attempt(row, set);
    },
    onLost: (_row, tryNumber) => logger.warn('[project history] patch lost its etag race', { id: key, tryNumber })
  });
}

// Only a folded twin counts for its target, so a link-and-unlink by `eagleId` cannot take a twin's ids.
// A relinked twin without `foldedInto` counts as a second holder beside its Track row: that fails closed.
function projectOf(row) {
  const twin = typeof row.eagleId === 'string' && String(row.id) === eagleOnlyProjectId(row.eagleId);
  return String(twin && row.foldedInto !== undefined && row.foldedInto !== null ? row.foldedInto : row.id);
}

/** `{project, held}` for each row holding any of `pairs`, values matched case-blind, from every partition unfiltered. */
async function holdersOf(pairs) {
  const checked = pairs.map(checkedPair);
  const match = checked.map((_, n) => `(x.system = @s${n} AND StringEquals(x.value, @v${n}, true))`).join(' OR ');
  const rows = await fetchAll(CONTAINER, {
    query: `SELECT c.id, c.eagleId, c.foldedInto, ARRAY(SELECT x.system, x.value FROM x IN c.externalIds WHERE ${match}) AS held ` +
      `FROM c WHERE EXISTS(SELECT VALUE x FROM x IN c.externalIds WHERE ${match})`,
    parameters: checked.flatMap(({ system, value }, n) => [{ name: `@s${n}`, value: system }, { name: `@v${n}`, value }])
  });
  return rows.map(row => ({ project: projectOf(row), held: Array.isArray(row.held) ? row.held : [] }));
}

/** Ids of the projects holding (system, value), the value matched case-blind. */
async function externalIdHolders(system, value) {
  return [...new Set((await holdersOf([{ system, value }])).map(holder => holder.project))];
}

/** Index in `pairs` of the first one a project other than `row`'s holds, or -1; one query for all of them. */
async function heldElsewhereIndex(row, pairs) {
  const own = projectOf(row);
  const others = (await holdersOf(pairs)).filter(holder => holder.project !== own);
  return pairs.findIndex(pair => others.some(holder => holder.held.some(entry => holds(entry, pair))));
}

/**
 * The PUT's `staffFieldChanges` result, or one fixed refusal when another project holds an appended external id:
 * the answer names no index, so one request cannot learn which of many values exists. Only the log keeps it.
 */
async function refuseHeldExternalIds(row, staff, attempt) {
  if (staff.error || !staff.values || !staff.values.externalIds) return staff;
  const stored = Array.isArray(row.externalIds) ? row.externalIds.length : 0;
  const appended = staff.values.externalIds.slice(stored);
  const held = appended.length ? await heldElsewhereIndex(row, appended) : -1;
  if (held < 0) return staff;
  logger.info('[project history] PUT refused: an appended external id is held by another project',
    { id: String(row.id), attempt, index: stored + held });
  return { error: 'an appended external id is held by another project' };
}

/** `set` (with the row's new `etag`), `unchanged` (the row holds it), `full`, `conflict` (held elsewhere, or every try lost) or `missing`. */
async function addExternalId(id, { system, value, source }, recordedAt = new Date().toISOString()) {
  const pair = checkedPair({ system, value });
  checkedSource(source);
  return guarded(id, async (row, set) => {
    const list = listOf(row, 'externalIds');
    if (list.some(entry => holds(entry, pair))) return { status: 'unchanged' };
    if (list.length >= MAX_ENTRIES) return { status: 'full' };
    if (await heldElsewhereIndex(row, [pair]) >= 0) return { status: 'conflict' };
    const written = await set('externalIds', [...list, { ...pair, source, recordedAt }]);
    return { status: 'set', etag: written?._etag ?? null };
  });
}

/** `removed`, `absent`, `changed` (staff wrote it), `conflict` or `missing`; the value matches case-blind, as on add. */
async function removeExternalId(id, { system, value }) {
  const pair = checkedPair({ system, value });
  return guarded(id, async (row, set) => {
    const list = listOf(row, 'externalIds');
    const index = list.findIndex(entry => holds(entry, pair));
    if (index < 0) return { status: 'absent' };
    if (list[index].source === 'demi') return { status: 'changed' };
    await set('externalIds', list.toSpliced(index, 1));
    return { status: 'removed' };
  });
}

/**
 * Append `entry` (and `close` that open entry) unless `stillDue(list)` of the patch's row is false. `appended` (with `etag`), `unchanged`
 * (id stored, or not due), `full`, `changed` (close target gone, closed, staff's or later), `conflict` or `missing`.
 */
async function appendHistory(id, field, entry, close, stillDue) {
  checkedField(field);
  if (close) checkedField(field, CLOSEABLE_FIELDS);
  if (!isObject(entry) || typeof entry.id !== 'string' || !entry.id) throw new TypeError('[project history] an entry needs an id');
  checkedSource(entry.source);
  return guarded(id, async (row, set) => {
    const list = listOf(row, field);
    if (byId(list, entry.id) >= 0) return { status: 'unchanged' };
    if (list.length >= MAX_ENTRIES) return { status: 'full' };
    if (stillDue && !stillDue(list)) return { status: 'unchanged' };
    const next = [...list, entry];
    if (close) {
      const index = byId(list, close.id);
      const target = list[index];
      const early = typeof target?.effectiveFrom === 'string' && close.effectiveTo < target.effectiveFrom;
      if (!target || target.source === 'demi' || (target.effectiveTo ?? null) !== null || early) return { status: 'changed' };
      next[index] = { ...target, effectiveTo: close.effectiveTo };
    }
    const written = await set(field, next);
    return { status: 'appended', etag: written?._etag ?? null };
  });
}

/** `closed`, `unchanged` (closed on that day), `absent`, `changed` (closed otherwise, or staff's), `conflict` or `missing`. */
async function closeHistory(id, field, entryId, effectiveTo) {
  checkedField(field, CLOSEABLE_FIELDS);
  return guarded(id, async (row, set) => {
    const list = listOf(row, field);
    const index = byId(list, entryId);
    if (index < 0) return { status: 'absent' };
    const target = list[index];
    if (target.source === 'demi') return { status: 'changed' };
    if (target.effectiveTo === effectiveTo) return { status: 'unchanged' };
    if ((target.effectiveTo ?? null) !== null) return { status: 'changed' };
    await set(field, list.with(index, { ...target, effectiveTo }));
    return { status: 'closed' };
  });
}

/** `removed`, `absent`, `changed` (its hash is not `expectedSha256`, or it is staff's), `conflict` or `missing`. */
async function removeHistory(id, field, entryId, expectedSha256) {
  checkedField(field);
  return guarded(id, async (row, set) => {
    const list = listOf(row, field);
    const index = byId(list, entryId);
    if (index < 0) return { status: 'absent' };
    if (list[index].source === 'demi' || historyEntrySha256(list[index]) !== expectedSha256) return { status: 'changed' };
    await set(field, list.toSpliced(index, 1));
    return { status: 'removed' };
  });
}

module.exports = {
  SYSTEMS,
  MAX_ENTRIES,
  historyEntrySha256,
  externalIdHolders,
  refuseHeldExternalIds,
  addExternalId,
  removeExternalId,
  appendHistory,
  closeHistory,
  removeHistory
};
