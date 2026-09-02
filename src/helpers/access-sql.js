'use strict';

/**
 * Visibility for the Cosmos NoSQL API. The single place a read predicate is built.
 *
 * Two ORTHOGONAL dimensions — this is the scaling decision, see the wiki's Architecture page:
 *
 *   1. WHAT KIND of access  -> `read[]` holds role TYPES only — the ladder tokens
 *      'team', 'staff', 'idir', 'public'. Bounded and indexed at /read/[]/?.
 *   2. WHICH PROJECTS       -> the partition key (/id on projects, /projectId elsewhere).
 *
 * Putting project identity into read[] instead would mean a user in 50 projects carrying 150
 * roles, and every read becoming a cross-partition ACL scan. Project scope is already the
 * partition boundary, so scoping by it costs nothing.
 *
 * Nothing here interpolates a caller value into SQL. Every value is a bound parameter.
 */

const { levelFromRoles } = require('../vis/level');

const PUBLIC_ROLES = Object.freeze(['public']);

/**
 * The ladder's `read[]` vocabulary, one token per level (docs/rbac-architecture.md §1, "Ladder").
 * Role TYPES, never ids: which projects a `team` row belongs to is the partition key's job.
 */
const LEVEL_TOKENS = Object.freeze({ 1: 'team', 2: 'staff', 3: 'idir', 4: 'public' });

/**
 * The sealed compartment's token — level 0, off the ladder (docs/rbac-architecture.md §1,
 * "Level 0"). It is a role name like any other, so a sealed row needs no separate store; what makes
 * it sealed is that every caller NOT holding it carries an exclusion, privileged callers included.
 */
const SEALED_TOKEN = 'compliance';

/**
 * The `read[]` a row carries at `level`.
 *
 * Levels 2-4 nest, so staff reads every row at level 2 or above with one token. Level 1 shares
 * NOTHING with them and is reached only through the team arm: a level-2 row carrying `team` would
 * hand a team-only caller every All-EAO row of its own project.
 *
 * 0 is the sealed compartment, the one non-ladder level this accepts. It shares no token with the
 * ladder, so no ladder caller reaches it and the exclusion below keeps privileged ones out too.
 */
function readForLevel(level) {
  if (level === 0) return [SEALED_TOKEN];
  if (!Number.isInteger(level) || !LEVEL_TOKENS[level]) {
    throw new RangeError(`[access] ${level} is not a ladder level`);
  }
  if (level === 1) return [LEVEL_TOKENS[1]];
  return [2, 3, 4].filter(l => l <= level).map(l => LEVEL_TOKENS[l]);
}

/**
 * A row's level: the widest ladder token in its `read[]`, 1 when it carries none, 0 when sealed.
 *
 * Legacy ACLs (`['sysadmin','staff','demi-admin']`, plus `'public'` when published) therefore read
 * as level 2 and 4 — today's meaning. Admin role names are ignored: they only ever matched callers
 * that short-circuit anyway. No stored ACL is rewritten.
 */
function levelOfRead(read) {
  const tokens = Array.isArray(read) ? read : [];
  if (tokens.includes(SEALED_TOKEN)) return 0;
  let level = 1;
  for (const [ladder, token] of Object.entries(LEVEL_TOKENS)) {
    if (tokens.includes(token) && Number(ladder) > level) level = Number(ladder);
  }
  return level;
}

/**
 * The tokens a credential's `levels` admit, and the tokens that prove a row sits ABOVE them
 * (docs/rbac-architecture.md §1, "Selected Credentials").
 *
 * Levels 2-4 nest in `read[]`, so "carries a granted token" alone is not "is at a granted level":
 * a level-3 row carries `staff` too, and a `levels: [2]` credential would reach it. The second set
 * is the ceiling that makes the arm mean `levelOfRead(read) ∈ levels` exactly, with no SQL shape
 * the role arm does not already use.
 *
 * A row carrying NO ladder token matches neither set, so it stays privileged-only — `levelOfRead`
 * reads it as 1, and a `levels: [1]` credential must not be a way in.
 */
function levelTokens(levels) {
  const granted = (levels || []).map(l => LEVEL_TOKENS[l]).filter(Boolean);
  const ceiling = Math.max(...(levels || [0]));
  return { granted, wider: [2, 3, 4].filter(l => l > ceiling).map(l => LEVEL_TOKENS[l]) };
}

/** Does this row sit at one of the levels a credential grants? The JS twin of the arm's SQL. */
function matchesLevels(read, levels) {
  const tokens = Array.isArray(read) ? read : [];
  const { granted, wider } = levelTokens(levels);
  return tokens.some(t => granted.includes(t)) && !tokens.some(t => wider.includes(t));
}

/**
 * The field a credential's `scope.ids` are compared against in THIS container, or null when the
 * grant says nothing about it.
 *
 * A project-scoped grant names project ids, which is the partition field — `id` on projects,
 * `projectId` everywhere else, the same choice the team arm makes.
 *
 * A document-scoped grant names the records themselves. In a Cosmos container that is `id`, and on
 * projects it is nothing at all: sight of a document is not sight of its project. A SEARCH INDEX
 * names the field instead of inferring it — a chunk carries its document as `documentId`, and the
 * chunk index's own `id` is not filterable, so the inferred field would be a 400 rather than a
 * narrower result.
 */
function credentialField(credential, partitionField, documentField) {
  const scope = (credential && credential.scope) || {};
  if (scope.type === 'project') return partitionField;
  if (scope.type !== 'document') return null;
  if (documentField !== undefined) return documentField;
  return partitionField === 'id' ? null : 'id';
}

/**
 * Roles that grant PRIVILEGED visibility — read everything, ACL predicate collapses to `true`.
 * `staff` is deliberately NOT here: that's what makes level 1 real. Session eligibility is
 * AUTHENTICATED_ROLES below, a separate question.
 */
const SECURE_ROLES = Object.freeze([
  'sysadmin', 'demi-admin', 'demi-service-read', 'demi-service-write'
]);

/**
 * Roles permitted to administer the SERVICE ITSELF — mint and revoke registry keys, run an
 * operator sync. Exactly the pre-existing WRITE_ROLES set, so nothing a human role could do
 * yesterday is refused today.
 *
 * This is the set `/admin/*` is gated on, and it is why `demi-service-write` exists: a machine
 * writer must be able to mirror data without being able to mint itself a wider credential.
 */
const ADMIN_ROLES = Object.freeze(['sysadmin', 'staff', 'demi-admin']);

/**
 * Roles permitted to MUTATE APPLICATION DATA — projects, documents, chunks, boundaries and the
 * Eagle mirror. A superset of ADMIN_ROLES, so no caller that could write yesterday loses the
 * ability today.
 *
 * `demi-service-write` is here and NOT in ADMIN_ROLES. That difference is the whole point: it is
 * what eagle-api's push and the extractor hold instead of `demi-admin`.
 *
 * Read privilege and write privilege were the same check until `requireWrite` (`authMiddleware`
 * guarded `GET /db/stats` and `DELETE /projects/:id` identically), which made "read-only consumer"
 * inexpressible. See middleware/require-roles.js.
 */
const WRITE_ROLES = Object.freeze([...ADMIN_ROLES, 'demi-service-write']);

/**
 * Roles permitted to HOLD A SESSION on the routes behind `middleware/auth.js` — a separate set
 * from SECURE_ROLES so `staff` isn't locked out once it left the privileged set. `compliance` is
 * deliberately out: those four routes mount their own gate.
 */
const AUTHENTICATED_ROLES = Object.freeze([...new Set([...SECURE_ROLES, ...WRITE_ROLES])]);

/**
 * Access tiers. 'scoped' comes from an API key's own `projectScope` and from nothing else — a realm
 * `project:<id>` role grants a team instead, which is a different question. See `teamsFor`.
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
  const user = req && req.user;
  const tokenRoles = user && user.realm_access && user.realm_access.roles;
  if (Array.isArray(tokenRoles)) {
    for (const r of tokenRoles) {
      if (!r) continue;
      const name = String(r);
      // `project:*` roles are the OTHER dimension — they grant a team, not a role type; see teamsFor.
      if (name.startsWith(PROJECT_ROLE_PREFIX)) continue;
      // A realm role must not FORGE a ladder token; team/idir enter only through their own paths.
      if (name === LEVEL_TOKENS[1] || name === LEVEL_TOKENS[3]) continue;
      roles.add(r);
    }
  }

  // Level 3 is "any IDIR login", which arrives as a token claim rather than as a realm role.
  if (user && user.identity_provider === 'idir') roles.add(LEVEL_TOKENS[3]);

  return Array.from(roles);
}

function isPrivileged(roles) {
  return roles.some(r => SECURE_ROLES.includes(r));
}

/** Does this caller hold the sealed compartment's role? Nothing else opens a level-0 row. */
function holdsSealed(roles) {
  return (roles || []).includes(SEALED_TOKEN);
}

/** May this role set hold a session on an authenticated route? See AUTHENTICATED_ROLES. */
function isAuthenticatedRole(roles) {
  return (roles || []).some(r => AUTHENTICATED_ROLES.includes(r));
}

/** Privileged for READS does not imply permitted to WRITE — see WRITE_ROLES. */
function canWrite(roles) {
  return roles.some(r => WRITE_ROLES.includes(r));
}

/** Permitted to WRITE DATA does not imply permitted to administer the service — see ADMIN_ROLES. */
function canAdmin(roles) {
  return roles.some(r => ADMIN_ROLES.includes(r));
}

/**
 * Resolve the full access context for a request.
 *
 * `teams` GRANTS (the team OR arm) and `projectScope` RESTRICTS (an AND on every read). Two
 * different project facts that must not be merged — see `teamsFor`.
 */
function resolveAccess(req) {
  const roles = rolesFor(req);
  const projectScope = projectScopeFor(req);
  const teams = teamsFor(req);
  // Whether a credential was PRESENTED, which is not the same question as the tier: `req.user` is
  // set only by verified auth (an API key or a Keycloak token), and a `compliance` key resolves to
  // TIER.PUBLIC while still being an identified caller.
  const authenticated = Boolean(req && req.user);
  // Live grants for this caller, loaded and window-filtered by middleware/credentials.js. A GRANT
  // like `teams`, never a restriction; absent (an unmounted route, a failed load) means none.
  const credentials = Array.isArray(req && req.credentials) ? req.credentials : [];
  // Field visibility is a THIRD dimension: rows and partitions say which records, level says which
  // attributes of one. Carried here so every response boundary has it without re-deriving.
  const level = levelFromRoles(roles);

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
    return { tier: TIER.SCOPED, roles, projectScope, teams, credentials, authenticated, level };
  }

  if (isPrivileged(roles)) {
    return {
      tier: TIER.PRIVILEGED, roles, projectScope: null, teams, credentials, authenticated, level
    };
  }

  return { tier: TIER.PUBLIC, roles, projectScope: null, teams, credentials, authenticated, level };
}

/**
 * Prefix marking a Keycloak role as a project scope rather than a role type.
 *
 * Keycloak dictates all roles, so scope has to arrive in the token — there is no separate
 * membership store. But a BARE role name cannot be classified: given `ajax`, nothing
 * distinguishes "scoped to the Ajax project" from a role type like `staff` or `compliance`.
 * Guessing would be a security bug in whichever direction it guessed. So scope is explicit:
 *
 *   project:207        -> member of project 207's team
 *   project:eagle-abc  -> member of an Eagle-only project's team
 *   staff, compliance  -> role types, land in read[] matching
 *
 * The value after the prefix is a CANONICAL project id (the partition key), not a name. That
 * keeps this synchronous and lookup-free, which matters because it runs on every request.
 * ponytail: id-only. Accepting a project NAME would need a slug→id map loaded from the
 * registry; add a cached lookup here if operators find ids unusable.
 */
const PROJECT_ROLE_PREFIX = 'project:';

/**
 * Project ids whose teams this caller belongs to, from `project:<id>` realm roles. A GRANT read
 * only by the team OR arm of `readClause`/`canRead` — it never narrows a read, unlike projectScope.
 */
function teamsFor(req) {
  const tokenRoles = req && req.user && req.user.realm_access && req.user.realm_access.roles;
  if (!Array.isArray(tokenRoles)) return [];

  const teams = [];
  for (const role of tokenRoles) {
    if (typeof role !== 'string' || !role.startsWith(PROJECT_ROLE_PREFIX)) continue;
    const id = role.slice(PROJECT_ROLE_PREFIX.length).trim();
    if (id && !teams.includes(id)) teams.push(id);
  }
  return teams;
}

/**
 * Project ids this caller is RESTRICTED to, or null for "not project-scoped".
 *
 * Only the explicit `projectScope` an API key was minted with (`controllers/nosql/api-key.js`). It
 * is the key issuer's restriction, so it is ANDed into every read and sets TIER.SCOPED.
 *
 * An empty array is meaningful and distinct from null: scoped to nothing, which `scopeClause`
 * renders as `false`.
 */
function projectScopeFor(req) {
  const user = req && req.user;
  if (!user || !Array.isArray(user.projectScope)) return null;
  return user.projectScope.map(String);
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
  return {
    tier: TIER.PRIVILEGED,
    roles: [...PUBLIC_ROLES, ...SECURE_ROLES],
    projectScope: null,
    teams: [],
    credentials: [],
    authenticated: true,
    level: 0
  };
}

/**
 * Rows one list page may return. MAX_PAGE_SIZE is also what `repositories/_sql.pageOptions`
 * clamps `maxItemCount` to, and is imported from here so the two cannot drift.
 *
 * A caller that presented no credential gets a tenth of it. The list routes are reachable with no
 * credential at all, and a 1000-row cross-partition page is the cheapest way for one to cost real
 * RU. Any verified credential keeps the full ceiling, privileged or not: the cap is about whether
 * the spend can be attributed to someone, not about what the caller may see.
 */
const MAX_PAGE_SIZE = 1000;
const ANON_MAX_PAGE_SIZE = 100;

/**
 * Page size for a list read: `{ pageSize }`, or `{ error }` when a caller that presented no
 * credential asked for more than its cap.
 *
 * Refused, not truncated — quietly returning 100 of the 500 rows asked for answers a different
 * question than the one asked, and the caller has no way to tell. Same rule as controllers/search.js.
 */
function pageSizeFor(access, raw) {
  const anonymous = !access || !access.authenticated;
  const max = anonymous ? ANON_MAX_PAGE_SIZE : MAX_PAGE_SIZE;

  // `>= 1`, so absent, junk, zero and negative all land on the default rather than on a one-row
  // page — the same idiom the search controller documents.
  const requested = parseInt(raw, 10);
  if (!(requested >= 1)) return { pageSize: max };

  if (anonymous && requested > max) {
    return { error: `pageSize above ${ANON_MAX_PAGE_SIZE} requires an authenticated request` };
  }
  return { pageSize: Math.min(requested, max) };
}

/** Partition-key fields the team arm may compare — `id` on projects, `projectId` everywhere else. */
const TEAM_PARTITION_FIELDS = Object.freeze(['projectId', 'id']);

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
 * @param {string[]} [opts.teams]           caller's team project ids — the level-1 OR arm
 * @param {string}   [opts.partitionField='projectId']  field the team arm compares, 'id' on projects
 * @returns {{clause: string, params: {name: string, value: any}[]}}
 */
function readClause(roles, opts = {}) {
  const alias = opts.alias || 'c';
  const prefix = opts.prefix || '@role';

  // The sealed compartment, and the reason a privileged caller no longer gets a bare `true`: the
  // short-circuit is what would hand `sysadmin` a level-0 row. Literal, not a parameter, because
  // it is our own token and never a caller value.
  const sealed = holdsSealed(roles)
    ? null
    : `NOT ARRAY_CONTAINS(${alias}.read, '${SEALED_TOKEN}')`;

  if (isPrivileged(roles)) {
    return { clause: sealed || 'true', params: [] };
  }

  const effective = Array.from(new Set([...roles, ...PUBLIC_ROLES]));
  const names = effective.map((_, i) => `${prefix}${i}`);
  const params = names.map((name, i) => ({ name, value: effective[i] }));

  // EXISTS with a subquery, NOT ARRAY_CONTAINS_ANY: the latter does not use the index, which
  // on the security path turns every gated read into a full scan. This form is one clause
  // regardless of how many roles the caller has, and uses the /read/[]/? range index.
  //
  // There is no third arm. A row carrying no ladder token is visible to privileged callers only —
  // `isPublished` MIRRORS `read.includes('public')` and never grants on its own.
  const arms = [
    `EXISTS(SELECT VALUE r FROM r IN ${alias}.read WHERE r IN (${names.join(', ')}))`
  ];

  // The team arm: level 1. An OR, never an AND — team membership GRANTS the caller its own
  // project's narrowest rows; ANDing it would hide every other level-2 row from the same caller.
  const teams = Array.isArray(opts.teams) ? opts.teams : [];
  const field = opts.partitionField === undefined ? 'projectId' : opts.partitionField;
  // The field name is the one value here that reaches SQL uninterpolated, so it comes off an
  // allow-list rather than from the caller. An unknown field (or null) skips the arm.
  if (teams.length > 0 && TEAM_PARTITION_FIELDS.includes(field)) {
    // `T`, not `Team`: `@roleTeam0` is also what a clause built with `prefix: '@roleTeam'` calls
    // its first role, and andClauses rejects that pair rather than running.
    const teamNames = teams.map((_, i) => `${prefix}T${i}`);
    arms.push(
      `(ARRAY_CONTAINS(${alias}.read, '${LEVEL_TOKENS[1]}')` +
      ` AND ${alias}.${field} IN (${teamNames.join(', ')}))`
    );
    params.push(...teamNames.map((name, i) => ({ name, value: String(teams[i]) })));
  }

  // The credential arm: a named party's sight of named records at named levels, for a fixed window
  // (docs/rbac-architecture.md §1, "Selected Credentials"). An OR like the team arm — it GRANTS,
  // and it changes nothing about the row it matches. One arm however many grants the caller holds.
  const credentials = Array.isArray(opts.credentials) ? opts.credentials : [];
  const credArms = [];
  credentials.forEach((cred, i) => {
    const credField = credentialField(cred, field);
    // Same allow-list as the team arm, for the same reason: this is the one value reaching SQL
    // uninterpolated.
    if (!TEAM_PARTITION_FIELDS.includes(credField)) return;

    const ids = (cred.scope && cred.scope.ids) || [];
    const { granted, wider } = levelTokens(cred.levels);
    if (ids.length === 0 || granted.length === 0) return;

    const idNames = ids.map((_, j) => `${prefix}C${i}_${j}`);
    const grantNames = granted.map((_, j) => `${prefix}CG${i}_${j}`);
    const widerNames = wider.map((_, j) => `${prefix}CW${i}_${j}`);

    credArms.push(
      `(${alias}.${credField} IN (${idNames.join(', ')})` +
      ` AND EXISTS(SELECT VALUE r FROM r IN ${alias}.read WHERE r IN (${grantNames.join(', ')}))` +
      (widerNames.length
        ? ` AND NOT EXISTS(SELECT VALUE r FROM r IN ${alias}.read` +
          ` WHERE r IN (${widerNames.join(', ')}))`
        : '') +
      ')'
    );
    params.push(
      ...idNames.map((name, j) => ({ name, value: String(ids[j]) })),
      ...grantNames.map((name, j) => ({ name, value: granted[j] })),
      ...widerNames.map((name, j) => ({ name, value: wider[j] }))
    );
  });

  if (credArms.length > 0) arms.push(`(${credArms.join(' OR ')})`);

  // ANDed onto the grants, not folded into one of them: no arm above can match a sealed row today,
  // and this is what keeps that true when the next arm is added.
  const clause = `(${arms.join(' OR ')})`;
  return { clause: sealed ? `${clause} AND ${sealed}` : clause, params };
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
    readClause(access.roles, {
      ...opts, teams: access.teams, credentials: access.credentials, partitionField
    }),
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

  // Scope FIRST, and it narrows a privileged caller too — otherwise a scoped staff key would
  // point-read its way out of its own scope, which is the leak `resolveAccess` was just fixed to
  // prevent on the query path. A falsy partitionField means the container has no project axis
  // (boundaries); see scopeClause.
  if (access.tier === TIER.SCOPED && partitionField) {
    const scope = access.projectScope || [];
    if (!scope.includes(String(doc[partitionField]))) return false;
  }

  // No `read[]` at all: the SQL twin's `NOT ARRAY_CONTAINS` is undefined on such a row and drops
  // it from every list, so the point read drops it too — same answer from both paths.
  if (!Array.isArray(doc.read)) return false;
  const read = doc.read;

  // BEFORE the privilege short-circuit, which is the whole leak: `sysadmin` returning early here
  // reads a sealed row. The SQL twin is readClause's `NOT ARRAY_CONTAINS`.
  if (read.includes(SEALED_TOKEN) && !holdsSealed(access.roles)) return false;

  // Privilege is a property of the ROLES, not of the tier — this mirrors readClause(), which
  // collapses to `true` for a privileged role set whatever the tier happens to be. Keying it off
  // the tier would deny a scoped-but-privileged caller its own in-scope private rows.
  if (isPrivileged(access.roles || [])) return true;

  if (read.some(r => (access.roles || []).includes(r))) return true;

  // The team arm's JS twin — see readClause. A row with no ladder token at all reaches no
  // unprivileged caller: `isPublished` mirrors `read`, it never grants.
  if (TEAM_PARTITION_FIELDS.includes(partitionField) &&
    read.includes(LEVEL_TOKENS[1]) &&
    (access.teams || []).includes(String(doc[partitionField]))) {
    return true;
  }

  // The credential arm's JS twin — see readClause. Reads the row, never writes it.
  return (access.credentials || []).some((cred) => {
    const field = credentialField(cred, partitionField);
    if (!TEAM_PARTITION_FIELDS.includes(field)) return false;
    const ids = ((cred.scope && cred.scope.ids) || []).map(String);
    return ids.includes(String(doc[field])) && matchesLevels(read, cred.levels);
  });
}

module.exports = {
  PUBLIC_ROLES,
  SECURE_ROLES,
  ADMIN_ROLES,
  WRITE_ROLES,
  AUTHENTICATED_ROLES,
  LEVEL_TOKENS,
  SEALED_TOKEN,
  TIER,
  PROJECT_ROLE_PREFIX,
  MAX_PAGE_SIZE,
  ANON_MAX_PAGE_SIZE,
  pageSizeFor,
  readForLevel,
  levelOfRead,
  levelTokens,
  matchesLevels,
  credentialField,
  rolesFor,
  isPrivileged,
  holdsSealed,
  isAuthenticatedRole,
  canWrite,
  canAdmin,
  resolveAccess,
  systemAccess,
  teamsFor,
  projectScopeFor,
  readClause,
  scopeClause,
  andClauses,
  visibilityFor,
  canRead
};
