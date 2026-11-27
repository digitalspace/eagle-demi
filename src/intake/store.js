'use strict';

/** The intake's reads and writes on the `documents` container. */

const cosmos = require('../db/cosmos-nosql');
const documents = require('../repositories/documents');
const { systemAccess } = require('../helpers/access-sql');

// Only a row still pending may be settled, so two writers racing on one row write once.
const STILL_PENDING = "FROM c WHERE c.scanStatus = 'pending'";
const RELEASED = "FROM c WHERE c.scanStatus = 'clean'";
// Fault stop for the upload list, far past a project's uploads in the listed window.
const LIST_FOR_PROJECT_MAX = 500;

/** The row for an intake document id, across partitions. */
function findById(id) {
  return documents.getById(systemAccess(), id, undefined, { includeUnscanned: true });
}

/** Patch `ops` onto the row when `condition` holds; false on a 412 (the condition failed). */
async function patchWhen(row, ops, condition) {
  try {
    await cosmos.patch(documents.CONTAINER, String(row.id), String(row.projectId), ops, condition);
    return true;
  } catch (err) {
    if ((err.code || err.statusCode) === 412) return false;
    throw err;
  }
}

/** Set fields on a row still pending. False when another writer settled it first. */
function settle(row, fields) {
  const ops = Object.entries({ ...fields, updatedAt: new Date().toISOString() })
    .map(([key, value]) => ({ op: 'set', path: `/${key}`, value }));
  return patchWhen(row, ops, STILL_PENDING);
}

/** Record why a publish on release was refused, on a released row only. False when not released. */
function markPublishRefused(row, reason) {
  return patchWhen(row, [{ op: 'set', path: '/publishRefused', value: String(reason) }], RELEASED);
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

/**
 * One page of pending rows, oldest first, with the fields a release or reject reads. Pass the
 * returned `continuationToken` back for the next page; it is undefined after the last one.
 */
async function listPending({ pageSize, continuationToken } = {}) {
  const { items, continuationToken: next } = await cosmos.query(documents.CONTAINER, {
    query: 'SELECT c.id, c.projectId, c.createdAt, c.requestedRead, c.s3Key, c.fileExt FROM c ' +
      'WHERE c.scanStatus = @pending ORDER BY c.createdAt ASC',
    parameters: [{ name: '@pending', value: 'pending' }]
  }, { maxItemCount: pageSize, continuationToken });
  return { items, continuationToken: next };
}

/**
 * One project's rows in any of `statuses` created at or after `since` (ISO string), newest first,
 * with the fields the upload list answers plus `projectId` and `requestedRead` for its ACL check.
 */
async function listForProject(projectId, statuses, since) {
  const { items } = await cosmos.query(documents.CONTAINER, {
    query: `SELECT TOP ${LIST_FOR_PROJECT_MAX} c.id, c.projectId, c.requestedRead, c.displayName, c.scanStatus, ` +
      'c.scanRejectReason, c.publishRefused, c.createdAt, c.scannedAt FROM c ' +
      'WHERE c.projectId = @projectId AND ARRAY_CONTAINS(@statuses, c.scanStatus) AND c.createdAt >= @since ' +
      'ORDER BY c.createdAt DESC',
    parameters: [
      { name: '@projectId', value: String(projectId) },
      { name: '@statuses', value: statuses },
      { name: '@since', value: since }
    ]
  }, { partitionKey: String(projectId) });
  return items;
}

/** How many pending rows were created after `createdAt` (ISO string). */
async function countPendingAfter(createdAt) {
  const count = await cosmos.queryValue(documents.CONTAINER, {
    query: 'SELECT VALUE COUNT(1) FROM c WHERE c.scanStatus = @pending AND c.createdAt > @after',
    parameters: [{ name: '@pending', value: 'pending' }, { name: '@after', value: createdAt }]
  });
  return Number(count) || 0;
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

module.exports = { findById, settle, markPublishRefused, listPending, listForProject, countPendingAfter, listStalePending, scannedBytesBetween };
