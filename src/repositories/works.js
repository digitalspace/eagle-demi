'use strict';

/**
 * Container `works`, one document per work (id `track-<trackWorkId>`), no `read[]`: never a response, gated by
 * the parent project's read the caller already holds. Only files allowed in test/repositories/works.test.js require it.
 */

const cosmos = require('../db/cosmos-nosql');
const { upsertWithEtag, createItem, eq, fetchAll } = require('./_sql');

const CONTAINER = 'works';
const PARTITION_FIELD = 'projectId';
const LABEL = 'works';

/** Every work of one project, one single-partition query. A tombstone is left out unless asked for. */
async function listByProject(projectId, { includeDeleted = false } = {}) {
  const { clause, params } = eq(PARTITION_FIELD, String(projectId), '@projectId');
  // Not selectWhere(systemAccess()): its seal term is undefined on a row with no read[], so Cosmos would drop every work.
  const rows = await fetchAll(CONTAINER, { query: `SELECT * FROM c WHERE ${clause}`, parameters: params },
    { partitionKey: String(projectId) });
  return includeDeleted ? rows : rows.filter(work => work.deleted !== true);
}

/** Point read, tombstone included, with its `_etag`; null when absent. */
async function get(projectId, workId) {
  return cosmos.readItem(CONTAINER, String(workId), String(projectId));
}

/**
 * Whole-document write guarded on `etag` (412 when the document moved), or a create when the
 * caller read it as absent (409 when one was created behind it). Run it inside `writeGuarded`.
 */
async function save(doc, { etag } = {}) {
  if (!etag) return createItem(CONTAINER, doc, LABEL);
  return upsertWithEtag(CONTAINER, doc, { etag, label: LABEL });
}

/** Replaces a deleted work with its stamps alone, so an older PUT for it is still seen as stale. */
async function tombstone({ id, projectId, pushStamps }, { etag } = {}) {
  return save({ id, projectId, deleted: true, pushStamps }, { etag });
}

module.exports = { CONTAINER, PARTITION_FIELD, listByProject, get, save, tombstone };
