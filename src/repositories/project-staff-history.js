'use strict';

// The loader's and the nightly's writes to a project row's staff history: etag-guarded patches of one list
// that leave `updatedAt` and `dateUpdated` alone and never touch an entry staff wrote (`source` demi).

const { createHash } = require('node:crypto');
const cosmos = require('../db/cosmos-nosql');
const { writeGuarded } = require('../helpers/etag-write');
const { logger } = require('../utils/logger');
const { eagleOnlyProjectId } = require('../merge/project');
const { fetchAll } = require('./_sql');
const { CONTAINER, readByEagleId, readForWrite } = require('./projects');

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

/** SHA-256 of an entry with its keys sorted, so a backup's hash matches the stored entry whatever the key order. */
const historyEntrySha256 = (entry) => createHash('sha256').update(JSON.stringify(entry, Object.keys(entry).sort())).digest('hex');

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

/**
 * The project a holder row stands for: a twin's ids belong to the row it folded into, or the row its Eagle id names.
 * Only a twin moves: an Eagle id a PUT can set on any other row must not hide that row's ids.
 */
async function projectOf(row) {
  if (row.foldedInto !== undefined && row.foldedInto !== null) return String(row.foldedInto);
  if (typeof row.eagleId !== 'string' || String(row.id) !== eagleOnlyProjectId(row.eagleId)) return String(row.id);
  const named = await readByEagleId(row.eagleId);
  return String(named ? named.id : row.id);
}

/** Ids of the projects holding (system, value), the value matched case-blind, from every partition and unfiltered. */
async function externalIdHolders(system, value) {
  const pair = checkedPair({ system, value });
  const rows = await fetchAll(CONTAINER, {
    query: 'SELECT c.id, c.eagleId, c.foldedInto FROM c WHERE EXISTS(SELECT VALUE x FROM x IN c.externalIds ' +
      'WHERE x.system = @system AND StringEquals(x.value, @value, true))',
    parameters: [{ name: '@system', value: pair.system }, { name: '@value', value: pair.value }]
  });
  const holders = new Set();
  for (const row of rows) holders.add(await projectOf(row));
  return [...holders];
}

const heldElsewhere = async (row, { system, value }) =>
  (await externalIdHolders(system, value)).some(holder => holder !== String(row.id));

/** The PUT's `staffFieldChanges` result, or a refusal naming the first appended external id another project holds. */
async function refuseHeldExternalIds(row, staff) {
  if (staff.error || !staff.values || !staff.values.externalIds) return staff;
  const stored = Array.isArray(row.externalIds) ? row.externalIds.length : 0;
  for (const [index, entry] of staff.values.externalIds.entries()) {
    if (index >= stored && await heldElsewhere(row, entry)) return { error: `externalIds[${index}]: another project holds this id` };
  }
  return staff;
}

/** `set`, `unchanged` (the row holds it), `full`, `conflict` (another project holds it, or every try lost) or `missing`. */
async function addExternalId(id, { system, value, source }, recordedAt = new Date().toISOString()) {
  const pair = checkedPair({ system, value });
  checkedSource(source);
  return guarded(id, async (row, set) => {
    const list = listOf(row, 'externalIds');
    if (list.some(entry => holds(entry, pair))) return { status: 'unchanged' };
    if (list.length >= MAX_ENTRIES) return { status: 'full' };
    if (await heldElsewhere(row, pair)) return { status: 'conflict' };
    await set('externalIds', [...list, { ...pair, source, recordedAt }]);
    return { status: 'set' };
  });
}

/** `removed`, `absent`, `changed` (staff wrote it), `conflict` or `missing`; the value must match exactly. */
async function removeExternalId(id, { system, value }) {
  const pair = checkedPair({ system, value });
  return guarded(id, async (row, set) => {
    const list = listOf(row, 'externalIds');
    const index = list.findIndex(entry => isObject(entry) && entry.system === pair.system && entry.value === pair.value);
    if (index < 0) return { status: 'absent' };
    if (list[index].source === 'demi') return { status: 'changed' };
    await set('externalIds', list.toSpliced(index, 1));
    return { status: 'removed' };
  });
}

/**
 * Append `entry`, and with `close` (`{id, effectiveTo}`) close that open entry in the same patch. `appended`,
 * `unchanged` (its id is stored), `changed` (the close target is gone, closed or staff's), `conflict` or `missing`.
 */
async function appendHistory(id, field, entry, close) {
  checkedField(field);
  if (close) checkedField(field, CLOSEABLE_FIELDS);
  if (!isObject(entry) || typeof entry.id !== 'string' || !entry.id) throw new TypeError('[project history] an entry needs an id');
  checkedSource(entry.source);
  return guarded(id, async (row, set) => {
    const list = listOf(row, field);
    if (byId(list, entry.id) >= 0) return { status: 'unchanged' };
    if (list.length >= MAX_ENTRIES) return { status: 'full' };
    const next = [...list, entry];
    if (close) {
      const index = byId(list, close.id);
      const target = list[index];
      if (!target || target.source === 'demi' || (target.effectiveTo ?? null) !== null) return { status: 'changed' };
      next[index] = { ...target, effectiveTo: close.effectiveTo };
    }
    await set(field, next);
    return { status: 'appended' };
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
