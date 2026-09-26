'use strict';

/**
 * The parent an Update hangs off, a project or a `ProjectNotification`, and the ceiling it puts on
 * the Update's `read[]`. One rule for the push, the announce and the project cascade.
 */

const cosmos = require('../db/cosmos-nosql');
const projects = require('../repositories/projects');
const notifications = require('../repositories/notifications');
const { pickParent } = require('./parent-admit');
const { levelOfRead, capRead, isDemiSeal } = require('./access-sql');
const { seedAcl } = require('../seed/transform');

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
 * An Update's own `read[]` from Eagle's: minus compliance (`seedAcl`), so a compliance-only read
 * lands at level 1. An empty read stays `[]` and a non-list is `[]`: neither is widened.
 */
function ownRead(eagleRead) {
  if (!Array.isArray(eagleRead) || eagleRead.length === 0) return [];
  return seedAcl(eagleRead);
}

/**
 * The read a parent caps at. A parent an Eagle push sealed (level 0, its stored `doc` without
 * `sealedAt`) caps at its Eagle read minus compliance, the read its next push lands; a DEMI seal,
 * or a parent passed without its row, caps as stored.
 */
function ceilingRead(parent) {
  const { doc } = parent;
  if (!doc || levelOfRead(parent.read) !== 0 || isDemiSeal(doc)) return parent.read;
  return seedAcl(doc.sources && doc.sources.eagle && doc.sources.eagle.read);
}

/**
 * An Update's `read[]` under its parent: Eagle's own minus compliance (`ownRead`), unless the
 * parent sits at a lower level (`ceilingRead`), in which case the parent's level through
 * `access-sql:capRead`, so a privileged-only parent keeps the Update privileged-only. Never rewritten
 * to ladder tokens, so `['sysadmin']` stays `['sysadmin']` and `[]` stays `[]`. No parent, no
 * ceiling.
 */
function readUnder(eagleRead, parent) {
  const own = ownRead(eagleRead);
  if (!parent) return own;
  const ceiling = ceilingRead(parent);
  return levelOfRead(ceiling) < levelOfRead(own) ? capRead(own, ceiling) : own;
}

/** The bar for emailing an Update: its parent, if it has one, is readable by anyone. */
function isPublicParent(parent) {
  return Boolean(parent) && Array.isArray(parent.read) && parent.read.includes('public');
}

module.exports = { readParent, ownRead, readUnder, isPublicParent };
