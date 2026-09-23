'use strict';

/**
 * Short links, Cosmos NoSQL. Partitioned by `/id` (id IS the code): the redirect is a single-
 * partition point read, and a code clash on create is a 409 from Cosmos, not a read-then-write race.
 */

const cosmos = require('../db/cosmos-nosql');
const projects = require('./projects');
const { selectWhere, fetchAll } = require('./_sql');
const { systemAccess } = require('../helpers/access-sql');
const { isEagleOnlyProjectId } = require('../merge/project');

const CONTAINER = 'links';

/** Point read by code. Returns null on 404. */
async function getById(code) {
  return cosmos.readItem(CONTAINER, String(code), String(code));
}

/**
 * Null (no container configured) is thrown as an error so it never looks like a stored link.
 * A 409 (code already taken) propagates uncaught; the controller decides retry vs. surface.
 */
async function create(record) {
  const saved = await cosmos.create(CONTAINER, record);
  if (!saved) throw new Error('links container not configured');
  return saved;
}

/**
 * `patch`, not `upsert` (see `repositories/api-keys.js:76-82`). patch has no 404 catch, so one is
 * added here: a missing code returns null so the controller 404s rather than 500s. `etag` makes it
 * land only on the revision the caller read; a mismatch throws 412. `claimedBy` stamps a project
 * adopting the record.
 */
async function repoint(code, url, { etag, claimedBy } = {}) {
  const ops = [
    { op: 'set', path: '/url', value: url },
    { op: 'set', path: '/updatedAt', value: new Date().toISOString() }
  ];
  if (claimedBy) ops.push({ op: 'set', path: '/claimedBy', value: claimedBy });
  try {
    return await cosmos.patch(CONTAINER, String(code), String(code), ops, undefined, etag);
  } catch (err) {
    if (err.code === 404) return null;
    throw err;
  }
}

/** `cosmos.remove` already returns false on 404; passed through as-is. `etag` as in `repoint`. */
async function remove(code, { etag } = {}) {
  return cosmos.remove(CONTAINER, String(code), String(code), { etag });
}

/**
 * Every link the caller may see, newest first: shared ones plus their own personal ones. A row
 * with no `personal` field predates the flag and is shared. Cross-partition; the container holds
 * one row per link, not per click.
 */
async function list(me) {
  const { items } = await cosmos.query(CONTAINER, {
    query: 'SELECT * FROM c WHERE (NOT IS_DEFINED(c.personal)) OR c.personal = false ' +
      'OR c.createdBy = @me ORDER BY c.createdAt DESC',
    parameters: [{ name: '@me', value: String(me || '') }]
  });
  return items || [];
}

/**
 * How well `row` owns `code`, lower first: a Track row before an `eagle-<id>` twin the sync left
 * behind with the same codes, then current before legacy.
 */
function ownerRank(row, code) {
  return (isEagleOnlyProjectId(row.id) ? 2 : 0) + (row.shortCode === code ? 0 : 1);
}

/**
 * Which project holds each code, current or legacy, in one query over the projects container: the
 * list route tags every row with it, and a lookup per row would be one query per link. Bounded by
 * the project count. Several holders resolve by `ownerRank`. `access` narrows it to the projects
 * the caller may read.
 *
 * @returns {Promise<Map<string, {projectId: string, projectRole: 'current'|'legacy'}>>}
 */
async function listProjectCodes(access = systemAccess()) {
  const spec = selectWhere({
    access,
    partitionField: projects.PARTITION_FIELD,
    criteria: [{
      clause: '((IS_DEFINED(c.shortCode) AND NOT IS_NULL(c.shortCode)) OR ARRAY_LENGTH(c.legacyShortCodes) > 0)',
      params: []
    }],
    select: 'c.id, c.shortCode, c.legacyShortCodes'
  });
  const rows = await fetchAll(projects.CONTAINER, spec);
  const held = new Map();
  const ranks = new Map();
  for (const row of rows) {
    for (const code of [row.shortCode, ...(row.legacyShortCodes || [])]) {
      if (!code) continue;
      const rank = ownerRank(row, code);
      if (ranks.has(code) && ranks.get(code) <= rank) continue;
      ranks.set(code, rank);
      held.set(code, { projectId: String(row.id), projectRole: row.shortCode === code ? 'current' : 'legacy' });
    }
  }
  return held;
}

module.exports = {
  CONTAINER,
  getById,
  create,
  repoint,
  remove,
  list,
  listProjectCodes,
  ownerRank
};
