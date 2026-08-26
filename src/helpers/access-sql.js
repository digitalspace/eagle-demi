'use strict';

/**
 * Visibility for the Cosmos NoSQL API. The single place a read predicate is built.
 *
 * Two ORTHOGONAL dimensions — this is the scaling decision, see the wiki's Architecture page:
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

/**
 * Roles that grant PRIVILEGED visibility — i.e. read everything, ACL predicate collapses to `true`.
 *
 * `demi-service-read` is the least-privilege tier for machine consumers. It reads like staff and
 * writes nothing: it is deliberately absent from WRITE_ROLES below. Adding it here rather than
 * inventing a parallel mechanism means no row's `read[]` array has to change — existing documents
 * carry ['public','sysadmin','staff','demi-admin'] and a service reader sees them because
 * readClause short-circuits for any privileged caller.
 */
const SECURE_ROLES = ['sysadmin', 'staff', 'demi-admin', 'demi-service-read'];

/**
 * Roles permitted to MUTATE. Exactly the pre-existing SECURE_ROLES set, so no caller that could
 * write yesterday loses the ability today — the only thing this adds is a tier that cannot.
 *
 * Read privilege and write privilege were the same check until now (`authMiddleware` guarded
 * `GET /db/stats` and `DELETE /projects/:id` identically), which made "read-only consumer"
 * inexpressible. See middleware/require-roles.js.
 */
const WRITE_ROLES = ['sysadmin', 'staff', 'demi-admin'];

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
      // `project:*` roles are the OTHER dimension — they scope the partition key, not read[].
      // Leaving them in would put project ids into the read[] IN list, which is exactly the
      // conflation of the two dimensions this module exists to prevent.
      if (r && !String(r).startsWith(PROJECT_ROLE_PREFIX)) roles.add(r);
    }
  }
  return Array.from(roles);
}

function isPrivileged(roles) {
  return roles.some(r => SECURE_ROLES.includes(r));
}

/** Privileged for READS does not imply permitted to WRITE — see WRITE_ROLES. */
function canWrite(roles) {
  return roles.some(r => WRITE_ROLES.includes(r));
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
  const projectScope = projectScopeFor(req);

  // Scope is resolved BEFORE the privilege check, and the order is the whole point. The reverse
  // returned PRIVILEGED with `projectScope: null` and threw the scope away, so a key minted as
  // `roles: ['staff'], projectScope: ['207']` read the entire corpus — the restriction its issuer
  // asked for did nothing at all, silently.
  //
  // The two dimensions are orthogonal: roles say WHICH ROWS, scope says WHICH PROJECTS. A
  // privileged credential carrying a scope is privileged WITHIN those projects. `readClause` and
  // `canRead` both key privilege off the ROLES, never off the tier, so a SCOPED tier still lifts
  // the role predicate for a privileged role set.
  if (Array.isArray(projectScope)) {
    return { tier: TIER.SCOPED, roles, projectScope };
  }

  if (isPrivileged(roles)) {
    return { tier: TIER.PRIVILEGED, roles, projectScope: null };
  }

  return { tier: TIER.PUBLIC, roles, projectScope: null };
}

/**
 * Prefix marking a Keycloak role as a project scope rather than a role type.
 *
 * Keycloak dictates all roles, so scope has to arrive in the token — there is no separate
 * membership store. But a BARE role name cannot be classified: given `ajax`, nothing
 * distinguishes "scoped to the Ajax project" from a role type like `staff` or `compliance`.
 * Guessing would be a security bug in whichever direction it guessed. So scope is explicit:
 *
 *   project:207        -> scoped to project 207
 *   project:eagle-abc  -> scoped to an Eagle-only project
 *   staff, compliance  -> role types, land in read[] matching
 *
 * The value after the prefix is a CANONICAL project id (the partition key), not a name. That
 * keeps this synchronous and lookup-free, which matters because it runs on every request.
 * ponytail: id-only. Accepting a project NAME would need a slug→id map loaded from the
 * registry; add a cached lookup here if operators find ids unusable.
 */
const PROJECT_ROLE_PREFIX = 'project:';

/**
 * Project ids this caller is scoped to, or null for "not project-scoped".
 *
 * An empty array is meaningful and distinct from null: scoped to nothing, which `scopeClause`
 * renders as `false`. That only arises from an explicit `projectScope: []`, never from a token
 * that simply carries no project roles — that caller is not scoped at all.
 */
function projectScopeFor(req) {
  const user = req && req.user;
  if (!user) return null;

  // An explicit projectScope on the verified token wins — the seam for a future claim that
  // carries ids directly rather than encoding them in role names.
  if (Array.isArray(user.projectScope)) return user.projectScope.map(String);

  const tokenRoles = user.realm_access && user.realm_access.roles;
  if (!Array.isArray(tokenRoles)) return null;

  const scope = [];
  for (const role of tokenRoles) {
    if (typeof role !== 'string' || !role.startsWith(PROJECT_ROLE_PREFIX)) continue;
    const id = role.slice(PROJECT_ROLE_PREFIX.length).trim();
    if (id && !scope.includes(id)) scope.push(id);
  }

  return scope.length > 0 ? scope : null;
}

/**
 * Access context for an internal job that must read EVERY item regardless of ACL — the extraction
 * worker, the purge, and whole-corpus passes.
 *
 * Deliberately built from the normal privileged tier rather than a bypass flag: it goes through
 * `readClause` like every other caller and simply resolves to `true`. A separate "skip the
 * predicate" path is exactly the shape that let a half-working translator disable access control
 * in this codebase, and it would not be covered by the SQL-asserting tests.
 *
 * Safe for the search index because visibility is enforced at QUERY time, not at index time: the
 * index holds every row's `read[]` verbatim, and `access-odata.js` translates the caller's resolved
 * access context into the OData `$filter` on each search. An indexing job therefore has to read
 * rows it will never itself return — copying an ACL it was not allowed to see is impossible.
 * This is why widening here does not widen what anyone can find.
 *
 * NEVER derive this from a request. It takes no arguments for that reason.
 */
function systemAccess() {
  return { tier: TIER.PRIVILEGED, roles: [...PUBLIC_ROLES, ...SECURE_ROLES], projectScope: null };
}

/**
 * Rows one list page may return. MAX_PAGE_SIZE is also what `repositories/_sql.pageOptions`
 * clamps `maxItemCount` to, and is imported from here so the two cannot drift.
 *
 * An anonymous caller gets a tenth of it. The list routes are reachable with no credential at
 * all, and a 1000-row cross-partition page is the cheapest way for one to cost real RU.
 */
const MAX_PAGE_SIZE = 1000;
const ANON_MAX_PAGE_SIZE = 100;

/**
 * Page size for a list read: `{ pageSize }`, or `{ error }` when an anonymous caller asked for
 * more than its cap.
 *
 * Refused, not truncated — quietly returning 100 of the 500 rows asked for answers a different
 * question than the one asked, and the caller has no way to tell. Same rule as controllers/search.js.
 */
function pageSizeFor(access, raw) {
  const anonymous = !access || access.tier === TIER.PUBLIC;
  const max = anonymous ? ANON_MAX_PAGE_SIZE : MAX_PAGE_SIZE;

  // `>= 1`, so absent, junk, zero and negative all land on the default rather than on a one-row
  // page — the same idiom the search controller documents.
  const requested = parseInt(raw, 10);
  if (!(requested >= 1)) return { pageSize: max };

  if (anonymous && requested > max) {
    return { error: `pageSize above ${ANON_MAX_PAGE_SIZE} is not supported for an unauthenticated request` };
  }
  return { pageSize: Math.min(requested, max) };
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
  // The second branch is the isPublished mirror for rows with no explicit ACL.
  //
  // `unsetIsPublic` drops the isPublished half of that branch, so a row carrying NEITHER `read[]`
  // nor `isPublished` is visible. Exactly one container needs it: `boundaries`, whose 281 seeded
  // rows predate having an ACL at all and carry neither field. Without it every one of them
  // evaluates FALSE for an anonymous caller — `c.isPublished = true` against an undefined field is
  // not true — and the map goes blank on deploy, silently and everywhere.
  //
  // It does not weaken the gate: a RESTRICTED boundary carries an explicit `read[]`, so the first
  // branch governs it and this one cannot match. The rule it encodes is "reference geography with
  // no ACL is public", which is a statement about that container, not a general fallback.
  const unsetArm = opts.unsetIsPublic
    ? `(NOT IS_DEFINED(${alias}.read) OR ARRAY_LENGTH(${alias}.read) = 0)`
    : `((NOT IS_DEFINED(${alias}.read) OR ARRAY_LENGTH(${alias}.read) = 0)` +
      ` AND ${alias}.isPublished = true)`;

  const clause =
    `(EXISTS(SELECT VALUE r FROM r IN ${alias}.read WHERE r IN (${names.join(', ')}))` +
    ` OR ${unsetArm})`;

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

  // No partition field means the container has no project axis at all — boundaries are
  // administrative geography, not project data. Scoping them on a field the items do not carry
  // would match nothing, so a project-scoped caller would lose every public boundary and the map
  // would silently go blank. Role ACL still applies; only the project narrowing is skipped.
  if (!field) {
    return { clause: 'true', params: [] };
  }

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
function canRead(doc, access, partitionField = 'projectId', opts = {}) {
  if (!doc || !access) return false;

  // Scope FIRST, and it narrows a privileged caller too — otherwise a scoped staff key would
  // point-read its way out of its own scope, which is the leak `resolveAccess` was just fixed to
  // prevent on the query path. A falsy partitionField means the container has no project axis
  // (boundaries); see scopeClause.
  if (access.tier === TIER.SCOPED && partitionField) {
    const scope = access.projectScope || [];
    if (!scope.includes(String(doc[partitionField]))) return false;
  }

  // Privilege is a property of the ROLES, not of the tier — this mirrors readClause(), which
  // collapses to `true` for a privileged role set whatever the tier happens to be. Keying it off
  // the tier would deny a scoped-but-privileged caller its own in-scope private rows.
  if (isPrivileged(access.roles || [])) return true;

  if (Array.isArray(doc.read) && doc.read.length > 0) {
    return doc.read.some(r => access.roles.includes(r));
  }
  // Same allowance as readClause's `unsetIsPublic` arm, for the same rows: a boundary seeded
  // before the container had an ACL carries neither field, and a point read must not withhold
  // what the list returns.
  if (opts.unsetIsPublic) return true;
  return doc.isPublished === true;
}

module.exports = {
  PUBLIC_ROLES,
  SECURE_ROLES,
  WRITE_ROLES,
  TIER,
  PROJECT_ROLE_PREFIX,
  MAX_PAGE_SIZE,
  ANON_MAX_PAGE_SIZE,
  pageSizeFor,
  rolesFor,
  isPrivileged,
  canWrite,
  resolveAccess,
  systemAccess,
  projectScopeFor,
  readClause,
  scopeClause,
  andClauses,
  visibilityFor,
  canRead
};
