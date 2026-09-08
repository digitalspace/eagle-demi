'use strict';

/**
 * Stored per-project AI summaries, Cosmos NoSQL. Partitioned by `/id` (id IS the project id): the
 * page read is a single-partition point read, and there is exactly one row per project.
 *
 * No visibility predicate and no `access` argument, unlike the mirrored data repositories. The row
 * is DERIVED from documents that were already ACL-filtered when it was generated, and the route
 * that serves it gates on the PROJECT the caller can read (controllers/project-summary.js) before
 * it gets here. Adding an ACL here would be a second, weaker copy of that gate.
 */

const cosmos = require('../db/cosmos-nosql');

const CONTAINER = 'projectSummaries';

/** Point read by project id. Returns null on 404 or with no container configured. */
async function getById(projectId) {
  return cosmos.readItem(CONTAINER, String(projectId), String(projectId));
}

/**
 * Whole-record write. Upsert, not patch: a regeneration REPLACES the record, and a partial write
 * would leave one section's citations pointing at another section's sources.
 *
 * Null (no container configured) is thrown rather than returned, so a script that reports success
 * cannot have written nothing.
 */
async function upsert(record) {
  const saved = await cosmos.upsert(CONTAINER, record);
  if (!saved) throw new Error('projectSummaries container not configured');
  return saved;
}

async function remove(projectId) {
  return cosmos.remove(CONTAINER, String(projectId), String(projectId));
}

module.exports = {
  CONTAINER,
  getById,
  upsert,
  remove
};
