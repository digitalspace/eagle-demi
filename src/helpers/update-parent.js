'use strict';

/**
 * The parent an Update hangs off, a project or a `ProjectNotification`, and the ceiling it puts on
 * the Update's `read[]`. One rule for the push, the announce and the project cascade.
 */

const projects = require('../repositories/projects');
const notifications = require('../repositories/notifications');
const { pickParent } = require('./parent-admit');
const { levelOfRead, capRead, isDemiSeal, noLadderToken } = require('./access-sql');
const { eagleBaseAcl } = require('../seed/transform');

// The DEMI parent of an Eagle id, `{id, read, kind, name, doc}` or null. Both rows read unfiltered: a private
// or sealed parent must still cap its Update, and systemAccess cannot see a sealed row.
async function readParent(eagleId) {
  if (!eagleId) return null;
  const [project, notification] = await Promise.all([
    projects.readByEagleId(eagleId),
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
 * A parent an Eagle push sealed caps at its Eagle read minus compliance, the read its next push
 * lands; a DEMI seal, or a parent passed without its row, caps as stored.
 */
function ceilingRead(parent) {
  const { doc } = parent;
  if (!doc || levelOfRead(parent.read) !== 0 || isDemiSeal(doc)) return parent.read;
  return eagleBaseAcl(doc.sources && doc.sources.eagle && doc.sources.eagle.read);
}

/**
 * Capped where the ceiling sits lower or either side has no ladder token (levels cannot compare
 * those); otherwise kept verbatim. `[]` is capped only by a lower ceiling.
 */
const capIfLower = (own, ceiling) => {
  const byRoles = own.length > 0 && (noLadderToken(own) || (noLadderToken(ceiling) && ceiling.length > 0));
  return byRoles || levelOfRead(ceiling) < levelOfRead(own) ? capRead(own, ceiling) : own;
};

/** `['sysadmin','inspector']` under a `['sysadmin']` parent stores `['sysadmin']`. `[]` stays `[]`. */
function readUnder(eagleRead, parent) {
  const own = ownRead(eagleRead);
  return parent ? capIfLower(own, ceilingRead(parent)) : own;
}

/** Eagle sent no `read` at all: absent or null. `[]` is a read, and so is any non-list. */
function hasNoRead(doc) {
  return doc.read === undefined || doc.read === null;
}

const ARCHIVED = 'archived';

/**
 * `archived` never inherits: Eagle hides it from staff. A row with no status inherits only when
 * `active: true` and `read` is absent; Eagle's `$redact` pruned `read: []`, so that stays `[]`.
 */
function inheritsParentRead(doc) {
  if (!doc) return false;
  if (doc.status === undefined || doc.status === null) return hasNoRead(doc) && doc.active === true;
  const emptyRead = hasNoRead(doc) || (Array.isArray(doc.read) && doc.read.length === 0);
  return emptyRead && doc.status !== ARCHIVED;
}

/**
 * A row `inheritsParentRead` admits takes the parent's ceiling as is; every other row is `readUnder`.
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
