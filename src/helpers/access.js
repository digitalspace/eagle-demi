'use strict';

/**
 * Single source of truth for read visibility.
 *
 * Mirrors the EPIC model used by eagle-api (`api/helpers/constants.js`,
 * `api/aggregators/documentAggregator.js`): records carry a `read[]` ACL, callers carry a
 * role list, and a record is visible when the two intersect. `isPublished` is kept only as
 * a convenience mirror — `read` is authoritative.
 *
 * Every read path must compose readFilter(). No controller should hand-roll a visibility
 * check; if you find yourself writing one, add it here instead.
 */

const PUBLIC_ROLES = ['public'];
const SECURE_ROLES = ['sysadmin', 'staff', 'demi-admin'];

/**
 * Roles for the current request. Always includes 'public'.
 * Reads only from req.user, which is populated exclusively by verified auth
 * (helpers/auth.js) — never from client-supplied headers or query params.
 */
function rolesFor(req) {
  const roles = new Set(PUBLIC_ROLES);
  const tokenRoles = req && req.user && req.user.realm_access && req.user.realm_access.roles;
  if (Array.isArray(tokenRoles)) {
    for (const r of tokenRoles) {
      if (r) roles.add(r);
    }
  }
  return Array.from(roles);
}

function isAdmin(req) {
  return rolesFor(req).some(r => SECURE_ROLES.includes(r));
}

/**
 * MongoDB filter restricting a read to what these roles may see.
 * Privileged roles get everything; everyone else must match the record's read[] ACL.
 *
 * Three tiers, in order of authority:
 *   1. read[] intersects the caller's roles          -> visible
 *   2. no read[], but isPublished === true           -> visible (boolean mirror)
 *   3. LEGACY: no read[] AND no isPublished field    -> visible
 *
 * Tier 3 exists because rows written before this ACL landed carry neither marker, and
 * they were already served publicly (the old filter was dead code, so every caller got
 * everything). Treating them as public preserves the status quo rather than creating new
 * exposure — hiding them would blank the public site instead.
 *
 * It is deliberately narrow: an explicit `isPublished: false` is still hidden, and every
 * write path (createProject/createDocument, the sync + seed scripts) now sets read[]
 * explicitly, so no NEW row can land in tier 3.
 *
 * Remove tier 3 once `node src/scripts/backfill-read-acl.js` has run in an environment —
 * after that every row has an explicit read[], and this clause matches nothing.
 */
function readFilter(roles) {
  if (roles.some(r => SECURE_ROLES.includes(r))) {
    return {};
  }
  const effective = Array.from(new Set([...roles, ...PUBLIC_ROLES]));
  const noAcl = { $or: [{ read: { $exists: false } }, { read: { $size: 0 } }] };
  return {
    $or: [
      { read: { $in: effective } },
      { ...noAcl, isPublished: true },
      { ...noAcl, isPublished: { $exists: false } }
    ]
  };
}

/**
 * Combine the visibility filter with caller-supplied criteria.
 * Uses $and so neither can cancel the other out.
 */
function withReadFilter(roles, ...criteria) {
  const clauses = [readFilter(roles), ...criteria].filter(
    c => c && typeof c === 'object' && Object.keys(c).length > 0
  );
  if (clauses.length === 0) return {};
  if (clauses.length === 1) return clauses[0];
  return { $and: clauses };
}

/**
 * Is a single already-fetched record visible to these roles?
 * For point reads (findById) where filtering happened outside the query.
 */
function canRead(doc, roles) {
  if (!doc) return false;
  if (roles.some(r => SECURE_ROLES.includes(r))) return true;
  if (Array.isArray(doc.read) && doc.read.length > 0) {
    return doc.read.some(r => roles.includes(r));
  }
  return doc.isPublished === true;
}

module.exports = {
  PUBLIC_ROLES,
  SECURE_ROLES,
  rolesFor,
  isAdmin,
  readFilter,
  withReadFilter,
  canRead
};
