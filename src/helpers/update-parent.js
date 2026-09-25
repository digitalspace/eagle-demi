'use strict';

/**
 * The parent an Update hangs off, a project or a `ProjectNotification`, and the ceiling it puts on
 * the Update's `read[]`. One rule for the push, the announce and the project cascade.
 */

const cosmos = require('../db/cosmos-nosql');
const projects = require('../repositories/projects');
const notifications = require('../repositories/notifications');
const { pickParent } = require('./parent-admit');
const { levelOfRead, readForLevel } = require('./access-sql');

/**
 * The project row carrying an Eagle id, unfiltered. Not `projects.getByEagleId(systemAccess())`:
 * systemAccess cannot see a sealed row, and a sealed parent read as missing caps nothing.
 */
function projectByEagleId(eagleId) {
  return cosmos.queryFirst(projects.CONTAINER, {
    query: 'SELECT * FROM c WHERE c.eagleId = @eagleId',
    parameters: [{ name: '@eagleId', value: String(eagleId) }]
  }, {});
}

/**
 * The DEMI parent of an Eagle id, both rows read unfiltered: a private or sealed parent must still
 * cap its Update, and a sealed notification must still win its id over a Track project.
 *
 * @returns {Promise<{id: string, read: string[], kind: 'project'|'notification', name: string|null,
 *   doc: object}|null>} `doc` is the stored parent row, for a caller's `canRead`
 */
async function readParent(eagleId) {
  if (!eagleId) return null;
  const [project, notification] = await Promise.all([
    projectByEagleId(eagleId),
    notifications.readForWrite(String(eagleId))
  ]);
  const parent = pickParent(project, notification);
  if (!parent) return null;
  const doc = parent.kind === 'notification' ? notification : project;
  return { ...parent, name: doc.name || null, doc };
}

/**
 * An Update's `read[]` under its parent: Eagle's own, verbatim, unless the parent sits at a lower
 * level, in which case the parent's level. Never widened: not `seedAcl`, not rewritten to ladder
 * tokens, so `['sysadmin']` stays `['sysadmin']` and `[]` stays `[]`. No parent, no ceiling.
 */
function readUnder(eagleRead, parent) {
  const own = Array.isArray(eagleRead) ? eagleRead : [];
  if (!parent) return own;
  const ceiling = levelOfRead(parent.read);
  return ceiling < levelOfRead(own) ? readForLevel(ceiling) : own;
}

/** The bar for emailing an Update: its parent, if it has one, is readable by anyone. */
function isPublicParent(parent) {
  return Boolean(parent) && Array.isArray(parent.read) && parent.read.includes('public');
}

module.exports = { readParent, readUnder, isPublicParent };
