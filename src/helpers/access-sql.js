'use strict';

/**
 * Visibility for the Cosmos NoSQL API. The single place a read predicate is built.
 *
 * Replaces helpers/access.js (MongoDB filter objects) during the NoSQL migration. Both exist
 * until the cutover; this one has no Mongo dependency.
 *
 * Two ORTHOGONAL dimensions — this is the scaling decision, see MIGRATION.md:
 *
 *   1. WHAT KIND of access  -> `read[]` holds role TYPES only ('public', 'sysadmin',
 *      'staff', 'project-team'…). Bounded (~6 values) and indexed at /read/[]/?.
 *   2. WHICH PROJECTS       -> the partition key (/id on projects, /projectId elsewhere).
 *
 * Putting project identity into read[] instead would mean a user in 50 projects carrying 150
 * roles, and every read becoming a cross-partition ACL scan. Project scope is already the
 * partition boundary, so scoping by it costs nothing.
 *
 * Nothing here interpolates a caller value into SQL. Every value is a bound parameter.
 */

const PUBLIC_ROLES = ['public'];
const SECURE_ROLES = ['sysadmin', 'staff', 'demi-admin'];

/**
 * Access tiers. 'scoped' is built now although no project-scoped role exists yet — the point
 * is that introducing one later is data, not a redesign.
 */
const TIER = {
  PRIVILEGED: 'privileged',
  SCOPED: 'scoped',
  PUBLIC: 'public'
};

/**
 * Above this many projects, a single cross-partition query with `projectId IN (...)` beats
 * issuing one single-partition query per project. Both branches are correct; the crossover is
 * a measurement, not a law.
 * ponytail: arbitrary until measured — tune from RU metrics, don't guess again.
 */
const PARTITION_FANOUT_LIMIT = 10;

/**
 * Roles for this request. Always includes 'public'.
 *
 * Read ONLY from req.user, which is populated exclusively by verified auth (helpers/auth.js).
 * Never from headers or query params — a caller must not be able to name their own roles.
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

function isPrivileged(roles) {
  return roles.some(r => SECURE_ROLES.includes(r));
}

/**
 * Resolve the full access context for a request.
 *
 * `projectScope` is the seam for project-scoped access. It is null today; when project
 * membership lands (a Keycloak claim, a membership container, or Track), populate it here and
 * every query inherits the restriction without changing.
 */
function resolveAccess(req) {
  const roles = rolesFor(req);

  if (isPrivileged(roles)) {
    return { tier: TIER.PRIVILEGED, roles, projectScope: null };
  }

  const projectScope = projectScopeFor(req);
  if (Array.isArray(projectScope)) {
    return { tier: TIER.SCOPED, roles, projectScope };
  }

  return { tier: TIER.PUBLIC, roles, projectScope: null };
}

/**
 * Project ids this caller is scoped to, or null for "not project-scoped".
 *
 * Returns null today. Deliberately a separate function so wiring up membership is a one-place
 * change. An empty array is meaningful and distinct from null: scoped to nothing.
 */
function projectScopeFor(req) {
  const scope = req && req.user && req.user.projectScope;
  return Array.isArray(scope) ? scope.map(String) : null;
}

/**
 * The visibility predicate for these roles, as a SQL fragment plus bound parameters.
 *
 * Privileged callers short-circuit to `true` — the same code path returning a wider filter,
 * not a bypass branch that could drift.
 *
 * @param {string[]} roles
 * @param {object}   [opts]
 * @param {string}   [opts.alias='c']       table alias in the query
 * @param {string}   [opts.prefix='@role']  parameter-name prefix, so multiple clauses in one
 *                                          query cannot collide
 * @returns {{clause: string, params: {name: string, value: any}[]}}
 */
function readClause(roles, opts = {}) {
  const alias = opts.alias || 'c';
  const prefix = opts.prefix || '@role';

  if (isPrivileged(roles)) {
    return { clause: 'true', params: [] };
  }

  const effective = Array.from(new Set([...roles, ...PUBLIC_ROLES]));
  const names = effective.map((_, i) => `${prefix}${i}`);

  // EXISTS with a subquery, NOT ARRAY_CONTAINS_ANY: the latter does not use the index, which
  // on the security path turns every gated read into a full scan. This form is one clause
  // regardless of how many roles the caller has, and uses the /read/[]/? range index.
  //
  // The second branch is the isPublished mirror for rows with no explicit ACL. There is no
  // third "no read[] AND no isPublished" tier: the old Mongo filter had one for pre-ACL rows,
  // and it is deleted rather than translated because every seeder writes read[] explicitly.
  const clause =
    `(EXISTS(SELECT VALUE r FROM r IN ${alias}.read WHERE r IN (${names.join(', ')}))` +
    ` OR ((NOT IS_DEFINED(${alias}.read) OR ARRAY_LENGTH(${alias}.read) = 0)` +
    ` AND ${alias}.isPublished = true))`;

  return {
    clause,
    params: names.map((name, i) => ({ name, value: effective[i] }))
  };
}

/**
 * Restrict a query to the caller's project scope, as a SQL fragment plus parameters.
 * Returns `true` (no restriction) for privileged and unscoped callers.
 *
 * @param {object} access  from resolveAccess()
 * @param {string} field   partition-key field — 'id' on projects, 'projectId' elsewhere
 */
function scopeClause(access, field, opts = {}) {
  const alias = opts.alias || 'c';
  const prefix = opts.prefix || '@scope';

  if (!access || access.tier !== TIER.SCOPED || !Array.isArray(access.projectScope)) {
    return { clause: 'true', params: [] };
  }

  // Scoped to nothing must match nothing — never fall through to unrestricted.
  if (access.projectScope.length === 0) {
    return { clause: 'false', params: [] };
  }

  const names = access.projectScope.map((_, i) => `${prefix}${i}`);
  return {
    clause: `${alias}.${field} IN (${names.join(', ')})`,
    params: names.map((name, i) => ({ name, value: access.projectScope[i] }))
  };
}

/**
 * AND several fragments together and merge their parameters.
 * `true` fragments are dropped; a single `false` collapses the whole predicate.
 *
 * Throws on a duplicate parameter name — silently dropping one would change the meaning of
 * the query, which on this path means changing who can see what.
 */
function andClauses(...fragments) {
  const parts = [];
  const params = [];
  const seen = new Set();

  for (const frag of fragments) {
    if (!frag || !frag.clause || frag.clause === 'true') continue;
    if (frag.clause === 'false') return { clause: 'false', params: [] };

    parts.push(frag.clause);
    for (const p of frag.params || []) {
      if (seen.has(p.name)) {
        throw new Error(
          `[access] duplicate SQL parameter "${p.name}" — pass a distinct prefix per clause`
        );
      }
      seen.add(p.name);
      params.push(p);
    }
  }

  if (parts.length === 0) return { clause: 'true', params: [] };
  return { clause: parts.map(p => `(${p})`).join(' AND '), params };
}

/**
 * Build the full visibility predicate for a container read: role ACL AND project scope.
 *
 * @param {object} access  from resolveAccess()
 * @param {string} [partitionField='projectId']  'id' on the projects container
 */
function visibilityFor(access, partitionField = 'projectId', opts = {}) {
  return andClauses(
    readClause(access.roles, opts),
    scopeClause(access, partitionField, opts)
  );
}

/**
 * Is an already-fetched item visible to this caller?
 *
 * Required on every point read — `container.item(id, pk).read()` bypasses the query
 * predicate entirely, so without this a by-id fetch would leak what a list would not.
 */
function canRead(doc, access, partitionField = 'projectId') {
  if (!doc || !access) return false;
  if (access.tier === TIER.PRIVILEGED) return true;

  if (access.tier === TIER.SCOPED) {
    const scope = access.projectScope || [];
    if (!scope.includes(String(doc[partitionField]))) return false;
  }

  if (Array.isArray(doc.read) && doc.read.length > 0) {
    return doc.read.some(r => access.roles.includes(r));
  }
  return doc.isPublished === true;
}

module.exports = {
  PUBLIC_ROLES,
  SECURE_ROLES,
  TIER,
  PARTITION_FANOUT_LIMIT,
  rolesFor,
  isPrivileged,
  resolveAccess,
  projectScopeFor,
  readClause,
  scopeClause,
  andClauses,
  visibilityFor,
  canRead
};
