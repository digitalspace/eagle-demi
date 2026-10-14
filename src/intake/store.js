'use strict';

/** The intake's reads and writes on the `documents` container. */

const cosmos = require('../db/cosmos-nosql');
const documents = require('../repositories/documents');
const { systemAccess } = require('../helpers/access-sql');

// Only a row still pending may be settled, so a repeated event or a sweep racing an event writes once.
const STILL_PENDING = "FROM c WHERE c.scanStatus = 'pending'";

/** The row for an intake document id. Cross-partition: the scan event carries no project. */
function findById(id) {
  return documents.getById(systemAccess(), id, undefined, { includeUnscanned: true });
}

/** Set fields on a row still pending. False when another writer settled it first. */
async function settle(row, fields) {
  const ops = Object.entries({ ...fields, updatedAt: new Date().toISOString() })
    .map(([key, value]) => ({ op: 'set', path: `/${key}`, value }));
  try {
    await cosmos.patch(documents.CONTAINER, String(row.id), String(row.projectId), ops, STILL_PENDING);
    return true;
  } catch (err) {
    if ((err.code || err.statusCode) === 412) return false;
    throw err;
  }
}

/** Rows still pending that were created before `cutoff` (ISO string). */
async function listStalePending(cutoff) {
  const { items } = await cosmos.query(documents.CONTAINER, {
    query: 'SELECT c.id, c.projectId, c.createdAt FROM c ' +
      'WHERE c.scanStatus = @pending AND c.createdAt < @cutoff',
    parameters: [{ name: '@pending', value: 'pending' }, { name: '@cutoff', value: cutoff }]
  });
  return items;
}

/** Bytes scanned from `from` up to `to` (`YYYY-MM-DD`), summed over the rows' `scanSizeBytes`. */
async function scannedBytesBetween(from, to) {
  // IS_NUMBER: one null makes Cosmos return undefined for the whole SUM.
  const total = await cosmos.queryValue(documents.CONTAINER, {
    query: 'SELECT VALUE SUM(c.scanSizeBytes) FROM c ' +
      'WHERE c.scannedAt >= @from AND c.scannedAt < @to AND IS_NUMBER(c.scanSizeBytes)',
    parameters: [{ name: '@from', value: from }, { name: '@to', value: to }]
  });
  return Number(total) || 0;
}

module.exports = { findById, settle, listStalePending, scannedBytesBetween };
