'use strict';

/**
 * The single place a Cosmos read predicate is built. `read[]` holds role types only; project scope
 * rides the partition key, never `read[]`. Every caller value is a bound parameter.
 */

const { levelFromRoles } = require('../vis/level');

const PUBLIC_ROLES = Object.freeze(['public']);

/**
 * The ladder's `read[]` vocabulary, one token per level (docs/rbac-architecture.md §1, "Ladder").
 * Role TYPES, never ids: which projects a `team` row belongs to is the partition key's job.
 */
const LEVEL_TOKENS = Object.freeze({ 1: 'team', 2: 'staff', 3: 'idir', 4: 'public' });
const LADDER_TOKENS = Object.freeze(Object.values(LEVEL_TOKENS));

/**
 * Level 0, off the ladder. A plain role name; a row is sealed because every read excludes it,
 * privileged callers included, except the compartment routes' own (see `opensSealed`).
 */
const SEALED_TOKEN = 'compliance';

/**
 * Levels 2-4 nest. Level 1 shares no token with them and is reached only through the team arm, else
 * a team-only caller would read every All-EAO row of its project. Level 0 is the sealed compartment.
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
 * Widest ladder token in `read[]`, 1 when none, 0 when sealed. Admin role names are ignored, so
 * legacy ACLs read as level 2, or 4 when published, with no stored ACL rewritten.
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
 * `own` narrowed to `cap`'s level, never widened. At level 1 a read with no ladder token keeps only
 * names the cap also admits and never becomes `team`; an empty result is `['sysadmin']`, never `[]`.
 */
function capRead(own, cap) {
  const level = Math.min(levelOfRead(own), levelOfRead(cap));
  if (level !== 1) return readForLevel(level);
  const capList = Array.isArray(cap) ? cap : [];
  const orSysadmin = read => (read.length > 0 ? read : ['sysadmin']);
  if (noLadderToken(own)) {
    return orSysadmin(own.filter(r => SECURE_ROLES.includes(r) || capList.includes(r) || capList.includes(LEVEL_TOKENS[4])));
  }
  if (noLadderToken(cap) && cap.length > 0) return orSysadmin(cap.filter(r => SECURE_ROLES.includes(r)));
  return readForLevel(1);
}

/** A `read[]` list carrying none of `team`, `staff`, `idir`, `public`. */
function noLadderToken(read) {
  return Array.isArray(read) && !read.some(r => LADDER_TOKENS.includes(r));
}

/**
 * Same callers under `readClause`? Level 4 always matches; 2 and 3 ignore privileged names. Levels 0
 * and 1 compare exactly, since `['team']` and `['sysadmin','inspector']` are both level 1.
 */
function sameAccess(a, b) {
  const level = levelOfRead(a);
  if (level !== levelOfRead(b)) return false;
  if (level === 4) return true;
  const kept = level < 2 ? read => read || [] : read => read.filter(r => !SECURE_ROLES.includes(r));
  const left = new Set(kept(a));
  const right = new Set(kept(b));
  return left.size === right.size && [...left].every(r => right.has(r));
}

/**
 * A level-0 row DEMI sealed itself (`POST /sealed` stamps `sealedAt`). A level-0 row without it
 * was sealed by an Eagle push carrying `compliance`, which is not a seal: the next push heals it.
 */
function isDemiSeal(row) {
  return Boolean(row && row.sealedAt);
}

/** A row DEMI holds sealed: level 0 AND `isDemiSeal`. No Eagle push reopens it. */
function heldSealed(row) {
  return Boolean(row) && levelOfRead(row.read) === 0 && isDemiSeal(row);
}

/**
 * Granted tokens plus `wider`, the ceiling: levels nest, so a level-3 row also carries `staff`. A row
 * with no ladder token matches neither set and stays privileged-only, even for `levels: [1]`.
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
 * Field `scope.ids` compare against here, or null. A document grant never opens its project; search
 * indexes pass `documentField` because the chunk index's `id` is not filterable.
 */
function credentialField(credential, partitionField, documentField) {
  const scope = (credential && credential.scope) || {};
  if (scope.type === 'project') return partitionField;
  if (scope.type !== 'document') return null;
  if (documentField !== undefined) return documentField;
  return partitionField === 'id' ? null : 'id';
}

/**
 * Privileged: the ACL predicate collapses to `true`. `staff` is deliberately not here, which is what
 * makes level 1 real.
 */
const SECURE_ROLES = Object.freeze([
  'sysadmin', 'demi-admin', 'demi-service-read', 'demi-service-write'
]);

/** Gate for `/admin/*`: mint and revoke registry keys, run an operator sync. */
const ADMIN_ROLES = Object.freeze(['sysadmin', 'staff', 'demi-admin']);

/**
 * Data writes. `demi-service-write` is here and not in ADMIN_ROLES on purpose: machine writers
 * (eagle-api push, extractor) mirror data but cannot mint themselves a wider key.
 */
const WRITE_ROLES = Object.freeze([...ADMIN_ROLES, 'demi-service-write']);

/**
 * Session on routes behind `middleware/auth.js`; separate from SECURE_ROLES so `staff` gets in.
 * `compliance` is deliberately out: the sealed routes mount their own gate.
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
 * Always includes 'public'. Read only from `req.user`, set by verified auth, never from headers or
 * query params: a caller must not name their own roles.
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

/**
 * Needs `compliance` and a compartment read, a flag only the sealed controller sets (never
 * `systemAccess()`), so sealed rows are reached only through audited `/api/sealed`.
 */
function opensSealed(roles, compartment) {
  return compartment === true && holdsSealed(roles);
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
 * `teams` grants (the team OR arm) and `projectScope` restricts (an AND on every read); never merge
 * them.
 */
function resolveAccess(req) {
  const roles = rolesFor(req);
  const projectScope = projectScopeFor(req);
  const teams = teamsFor(req);
  // Credential presented, not the tier: a `compliance` key is TIER.PUBLIC yet identified.
  const authenticated = Boolean(req && req.user);
  // Live grants for this caller, loaded and window-filtered by middleware/credentials.js. A GRANT
  // like `teams`, never a restriction; absent (an unmounted route, a failed load) means none.
  const credentials = Array.isArray(req && req.credentials) ? req.credentials : [];
  // Field visibility is a THIRD dimension: rows and partitions say which records, level says which
  // attributes of one. Carried here so every response boundary has it without re-deriving.
  const level = levelFromRoles(roles);

  // Scope before privilege, else a scoped privileged key drops its scope and reads everything.
  // `readClause` and `canRead` key privilege off roles, not tier, so it stays privileged in scope.
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

/** Anonymous: no credential was presented at all, so every such caller sees the same rows. */
function isAnonymous(access) {
  return access.authenticated === false && access.tier === TIER.PUBLIC;
}

/**
 * `project:<canonical id>` marks team membership; a bare role name cannot be told from a role type.
 * ponytail: id-only, no lookup per request; add a cached name-to-id map if ids prove unusable.
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
 * The `projectScope` an API key was minted with, ANDed into every read, or null. An empty array
 * means scoped to nothing (`false` in `scopeClause`), not unscoped.
 */
function projectScopeFor(req) {
  const user = req && req.user;
  if (!user || !Array.isArray(user.projectScope)) return null;
  return user.projectScope.map(String);
}

/**
 * Internal jobs only, via the normal privileged tier, never a bypass flag. No arguments, so it can
 * never be derived from a request.
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
 * `repositories/_sql.pageOptions` imports MAX_PAGE_SIZE. Anonymous callers get a tenth: the cap is
 * about whether RU spend can be attributed to someone, not about what the caller may see.
 */
const MAX_PAGE_SIZE = 1000;
const ANON_MAX_PAGE_SIZE = 100;

/**
 * Deepest row (`pageNum * pageSize + pageSize`) a page may reach: Cosmos has no offset, so a page
 * costs every row before it. Largest data seen: 2,510 updates, 802 comments in one period.
 */
const MAX_PAGE_DEPTH = 20000;

/**
 * `{ pageSize }`, or `{ error }` when an anonymous caller asks above its cap. Refused, not
 * truncated, since a short page is silently a different answer. Same rule as controllers/search.js.
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
 * Privileged callers get `true` from this same path, not a bypass branch that could drift.
 * @param {string[]} roles
 * @param {object}   [opts]
 * @param {string}   [opts.alias='c']       table alias in the query
 * @param {string}   [opts.prefix='@role']  parameter-name prefix, so clauses in one query cannot collide
 * @param {string[]} [opts.teams]           caller's team project ids — the level-1 OR arm
 * @param {string}   [opts.partitionField='projectId']  field the team arm compares, 'id' on projects
 * @param {boolean}  [opts.compartment]     this read is a compartment route's — see opensSealed
 * @returns {{clause: string, params: {name: string, value: any}[]}}
 */
function readClause(roles, opts = {}) {
  const alias = opts.alias || 'c';
  const prefix = opts.prefix || '@role';

  // Privileged callers get this exclusion, not a bare `true`, so `sysadmin` never sees level 0.
  // A literal, not a parameter: our own token, never a caller value.
  const sealed = opensSealed(roles, opts.compartment)
    ? null
    : `NOT ARRAY_CONTAINS(${alias}.read, '${SEALED_TOKEN}')`;

  if (isPrivileged(roles)) {
    return { clause: sealed || 'true', params: [] };
  }

  const effective = Array.from(new Set([...roles, ...PUBLIC_ROLES]));
  const names = effective.map((_, i) => `${prefix}${i}`);
  const params = names.map((name, i) => ({ name, value: effective[i] }));

  // EXISTS subquery, not ARRAY_CONTAINS_ANY, which skips the /read/[]/? index and full-scans.
  // No third arm: `isPublished` mirrors `read.includes('public')` and never grants on its own.
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

  // Credential arm: a named party's sight of named records at named levels. An OR that grants,
  // one arm however many grants the caller holds.
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

  // No partition field = no project axis (boundaries). Scoping on it would blank the map for scoped
  // callers; role ACL still applies.
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
 * `true` fragments drop out; one `false` collapses all. A duplicate parameter name throws, since
 * dropping one would change who can see what.
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
      ...opts,
      teams: access.teams,
      credentials: access.credentials,
      partitionField,
      compartment: access.compartment
    }),
    scopeClause(access, partitionField, opts)
  );
}

/** Required on every point read: `container.item(id, pk).read()` skips the query predicate. */
function canRead(doc, access, partitionField = 'projectId') {
  if (!doc || !access) return false;

  // Scope first, narrowing privileged callers too, else a scoped key point-reads out of scope.
  // Falsy partitionField = no project axis (boundaries).
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
  if (read.includes(SEALED_TOKEN) && !opensSealed(access.roles, access.compartment)) return false;

  // Privilege keys off roles, not tier, as in readClause, so a scoped privileged caller keeps its
  // in-scope private rows.
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
  MAX_PAGE_DEPTH,
  pageSizeFor,
  readForLevel,
  levelOfRead,
  capRead,
  noLadderToken,
  sameAccess,
  isDemiSeal,
  heldSealed,
  levelTokens,
  matchesLevels,
  credentialField,
  rolesFor,
  isPrivileged,
  holdsSealed,
  opensSealed,
  isAuthenticatedRole,
  canWrite,
  canAdmin,
  resolveAccess,
  isAnonymous,
  systemAccess,
  teamsFor,
  projectScopeFor,
  readClause,
  scopeClause,
  andClauses,
  visibilityFor,
  canRead
};
