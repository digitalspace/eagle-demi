'use strict';

/**
 * One summary row per project, id = project id. No ACL: the row derives from ACL-filtered documents,
 * and controllers/project-summary.js gates on the project first; a copy here would be weaker.
 */

const cosmos = require('../db/cosmos-nosql');

const CONTAINER = 'projectSummaries';

/** Point read by project id. Returns null on 404 or with no container configured. */
async function getById(projectId) {
  return cosmos.readItem(CONTAINER, String(projectId), String(projectId));
}

/**
 * Upsert, not patch: a partial write could leave citations pointing at another section's sources.
 * Throws when no container is configured, so a script cannot report success for nothing.
 */
async function upsert(record) {
  const saved = await cosmos.upsert(CONTAINER, record);
  if (!saved) throw new Error('projectSummaries container not configured');
  return saved;
}

module.exports = {
  getById,
  upsert
};
