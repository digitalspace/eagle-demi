'use strict';

/**
 * The parent an Update hangs off, a project or a `ProjectNotification`, and the ceiling it puts on
 * the Update's `read[]`. One rule for the push, the announce and the project cascade.
 */

const cosmos = require('../db/cosmos-nosql');
const projects = require('../repositories/projects');
const notifications = require('../repositories/notifications');
const { pickParent } = require('./parent-admit');
const { levelOfRead, capRead, isDemiSeal, noLadderToken } = require('./access-sql');
const { eagleBaseAcl } = require('../seed/transform');

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
 * An Update's own `read[]` from Eagle's through `eagleBaseAcl`: minus compliance. An empty read
 * stays `[]` and a non-list is `[]`: neither is widened.
 */
function ownRead(eagleRead) {
  if (!Array.isArray(eagleRead) || eagleRead.length === 0) return [];
  return eagleBaseAcl(eagleRead);
}

/**
 * The read a parent caps at. A parent an Eagle push sealed (level 0, its stored `doc` without
 * `sealedAt`) caps at its Eagle read minus compliance, the read its next push lands; a DEMI seal,
 * or a parent passed without its row, caps as stored.
 */
function ceilingRead(parent) {
  const { doc } = parent;
  if (!doc || levelOfRead(parent.read) !== 0 || isDemiSeal(doc)) return parent.read;
  return eagleBaseAcl(doc.sources && doc.sources.eagle && doc.sources.eagle.read);
}

/**
 * Capped by `capRead` where the ceiling sits lower, or where either side carries no ladder token (a
 * level-1 audience a level alone cannot compare); otherwise kept verbatim, not rewritten to ladder
 * tokens. `[]` is capped only by a lower ceiling.
 */
const capIfLower = (own, ceiling) => {
  const byRoles = own.length > 0 && (noLadderToken(own) || (noLadderToken(ceiling) && ceiling.length > 0));
  return byRoles || levelOfRead(ceiling) < levelOfRead(own) ? capRead(own, ceiling) : own;
};

/**
 * An Update's `read[]` under its parent: `ownRead`, capped by `ceilingRead`. So
 * `['sysadmin','inspector']` under a `['sysadmin']` parent stores `['sysadmin']`. `[]` stays `[]`.
 * No parent, no ceiling.
 */
function readUnder(eagleRead, parent) {
  const own = ownRead(eagleRead);
  return parent ? capIfLower(own, ceilingRead(parent)) : own;
}

/** Eagle sent no `read` at all: absent or null. `[]` is a read, and so is any non-list. */
function hasNoRead(doc) {
  return doc.read === undefined || doc.read === null;
}

/**
 * Eagle's legacy `RecentActivity` rows with no `read` field, a null `status` and `active: true` are
 * shown to anonymous callers: eagle-api's public search `$redact` DESCENDS into a row whose `read`
 * is missing or null, but PRUNES `read: []` (an empty array is true in `$cond` and false in
 * `$anyElementTrue`). So only a missing read is as visible as its parent; `[]` stays `[]`.
 */
function inheritsParentRead(doc) {
  if (!doc) return false;
  const noStatus = doc.status === undefined || doc.status === null;
  return hasNoRead(doc) && noStatus && doc.active === true;
}

/**
 * The `read[]` DEMI stores for an Eagle Update under `parent`: a legacy open row
 * (`inheritsParentRead`) takes the parent's ceiling as is; every other row is `readUnder`. No
 * parent, nothing to inherit.
 *
 * @param {{read?: *, status?: *, active?: *}} doc  the Eagle record, or its `sources.eagle` copy
 */
function updateRead(doc, parent) {
  if (parent && inheritsParentRead(doc)) return ceilingRead(parent);
  return readUnder(doc && doc.read, parent);
}

/** The bar for emailing an Update: its parent, if it has one, is readable by anyone. */
function isPublicParent(parent) {
  return Boolean(parent) && Array.isArray(parent.read) && parent.read.includes('public');
}

module.exports = { readParent, ownRead, readUnder, hasNoRead, inheritsParentRead, updateRead, isPublicParent };
