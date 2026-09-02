'use strict';

/**
 * Hold the `project:<id>` realm roles in `eao-epic` in step with Track's project team feed.
 *
 * Track is the source of truth for who is on a project team: `GET /api/v1/projects/team-members`
 * returns, per project, the union of the staff on its works. This script turns that into realm
 * roles — create the missing `project:<id>`, grant what the feed says, revoke what it no longer
 * says — so a level-1 record is readable by its own team and nobody else.
 *
 *   node src/scripts/sync-track-teams.js [--live]
 *
 * DRY RUN BY DEFAULT, matching close-unpublished-track-projects.js and purge-extraction.js. In
 * Azure it is the `syncTrackTeams` Functions timer in this app (api/index.js, scheduled by the
 * SYNC_TEAMS_SCHEDULE app setting), reading Track over its HTTPS API — no CronJob, no database
 * credential.
 *
 * ORDERING: a live run needs P3-2's team-grant model, because until it lands a `project:<id>` role
 * NARROWS its holder to that project (`access-sql.projectScopeFor`) instead of granting a team —
 * so `run({ live: true })` refuses while `access-sql` exports no `teamsFor`.
 *
 * THE SYNC OWNS ONLY THE ROLES TRACK NAMES. The feed lists every non-deleted Track project, so
 * `project:<id>` for an id it lists is this script's to create, grant and revoke; any other role
 * is somebody else's. That covers `staff` and `demi-admin`, granted by hand, and also
 * `project:eagle-abc` — a hand-granted scope for an Eagle-only project (access-sql.js), which has
 * no Track team to sync it from and must survive every run. The `project:` prefix is re-checked
 * after the Keycloak search rather than trusted, since `search=` is a substring match.
 *
 * IT ALSO MIRRORS THE PROJECT LIST AND CLOSES CREDENTIALS. The same run reads
 * `GET /api/v1/projects` ONCE and hands that list to two steps. `sync-track-projects.js` creates
 * and updates the DEMI project records from it — Track is the live source of project identity, not
 * the checked-in export. Then every live Selected Credential over a project Track reports closed is
 * closed out (TODO-rbac.md P3-6) — narrowed if it names other projects, revoked if it does not.
 * "Work complete" is not in the feed, so `project-closed` is the only cause acted on here.
 *
 * Two client-credentials identities, both confidential clients in the same realm:
 * `TRACK_CLIENT_ID` reads Track, `KEYCLOAK_ADMIN_CLIENT_ID` (`demi-role-sync`) holds
 * `realm-management` on the realm. Neither secret lives here; both arrive as app settings.
 */

const config = require('../config');
const { PROJECT_ROLE_PREFIX } = require('../helpers/access-sql');
const { clientToken, fetchJson, fetchTrackProjects } = require('../seed/sources');
const { syncProjects } = require('./sync-track-projects');
const { logger } = require('../utils/logger');

/** Keycloak's admin API caps a listing page; anything longer has to be walked with `first=`. */
const PAGE_MAX = 1000;

function parseArgs(argv) {
  const args = { live: false };
  for (const a of argv) {
    if (a === '--live') args.live = true;
    else if (a === '--dry-run') args.live = false;
    else throw new Error(`[track-teams] unknown argument: ${a}`);
  }
  return args;
}

const emailKey = (staff) => (staff.email ? String(staff.email).trim().toLowerCase() : '');

/** The Keycloak username for a Track staff row, or null when nothing identifies them. */
function usernameFor(staff, usernameByEmail = new Map()) {
  // Track stores the id either bare or already suffixed (`<guid>@idir`, measured on test 2026-09-02).
  if (staff.idir_user_id) return `${String(staff.idir_user_id).trim().toLowerCase().replace(/@idir$/, '')}@idir`;
  const email = emailKey(staff);
  return email ? usernameByEmail.get(email) || null : null;
}

/** Track reports a close both ways; either one closes the project (measured on test 2026-09-02). */
const isClosed = (project) => project.is_project_closed === true || project.project_state === 'Closed';

/** Cosmos is private-endpoint-only, so a CLI dry run off-platform has no repository to ask. */
function credentialsRepository() {
  if (process.env.COSMOS_ENDPOINT) return require('../repositories/credentials');
  logger.warn('[track-teams] COSMOS_ENDPOINT not set: credential auto-revoke reported as 0');
  return { listLiveProjectScoped: async () => [], revokeForProject: async () => [] };
}

const countRoles = (entries) => entries.reduce((n, e) => n + e.roles.length, 0);
const byUsername = (a, b) => a.username.localeCompare(b.username);

/**
 * The whole decision, with no I/O in it.
 *
 * @param {Array}  trackTeams     [{ project_id, staff: [{ staff_id, idir_user_id, email, is_active }] }]
 * @param {object} keycloakState  {current: Map<username, Set<role>>, roles: Set<role>,
 *                                 usernameByEmail: Map<email, username>} — `current` holds only
 *                                 the `project:` roles, since only those were enumerated.
 */
function plan(trackTeams, keycloakState = {}) {
  const current = keycloakState.current || new Map();
  const existingRoles = keycloakState.roles || new Set();
  const usernameByEmail = keycloakState.usernameByEmail || new Map();

  const desired = new Map();
  const unmatched = new Set();
  // The roles this sync owns: one per project in the feed, empty team or not. A `project:` role
  // outside this set belongs to whoever granted it by hand.
  const owned = new Set();

  for (const team of trackTeams) {
    const role = `${PROJECT_ROLE_PREFIX}${team.project_id}`;
    owned.add(role);
    for (const staff of team.staff || []) {
      // A departed staff member earns no role here and so falls out under the revokes below.
      if (staff.is_active === false) continue;
      const username = usernameFor(staff, usernameByEmail);
      if (!username) {
        unmatched.add(String(staff.staff_id ?? emailKey(staff)) || 'unknown');
        continue;
      }
      if (!desired.has(username)) desired.set(username, new Set());
      desired.get(username).add(role);
    }
  }

  const wanted = new Set([...desired.values()].flatMap(roles => [...roles]));

  const grants = [];
  for (const [username, roles] of desired) {
    const held = current.get(username) || new Set();
    const add = [...roles].filter(r => !held.has(r)).sort();
    if (add.length) grants.push({ username, roles: add });
  }

  const revokes = [];
  for (const [username, held] of current) {
    const roles = desired.get(username) || new Set();
    const drop = [...held].filter(r => owned.has(r) && !roles.has(r)).sort();
    if (drop.length) revokes.push({ username, roles: drop });
  }

  return {
    projects: trackTeams.length,
    users: desired.size,
    rolesToCreate: [...wanted].filter(r => !existingRoles.has(r)).sort(),
    grants: grants.sort(byUsername),
    revokes: revokes.sort(byUsername),
    unmatched: [...unmatched].sort()
  };
}

/** Every Keycloak call this script makes, in one object so a test can replace the lot. */
function keycloakClient() {
  const adminBase = `${config.keycloakUrl}/admin/realms/${config.keycloakRealm}`;
  let adminToken;

  const mintAdminToken = async () => {
    adminToken = await clientToken(config.keycloakAdminClientId, config.keycloakAdminClientSecret);
  };

  async function admin(path, { method = 'GET', body, tolerate = [] } = {}) {
    if (!adminToken) await mintAdminToken();
    const call = () => fetch(`${adminBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    let res = await call();
    // A run over a large realm outlives the token it started with; re-mint once, then a 401 is real.
    if (res.status === 401) {
      await mintAdminToken();
      res = await call();
    }
    if (!res.ok && !tolerate.includes(res.status)) {
      throw new Error(`[track-teams] ${method} ${path}: HTTP ${res.status}`);
    }
    return res.status === 200 ? res.json() : null;
  }

  const first = async (query) => (await admin(`/users?${query}`))[0] || null;

  /** A realm with more than PAGE_MAX project roles, or a role held by more users, is silently
   *  truncated by one call, so walk until a page comes back short. */
  async function pages(path, query = '') {
    const all = [];
    for (let offset = 0; ; offset += PAGE_MAX) {
      const page = await admin(`${path}?${query}first=${offset}&max=${PAGE_MAX}`) || [];
      all.push(...page);
      if (page.length < PAGE_MAX) return all;
    }
  }

  return {
    clientToken,
    listProjectRoles: () => pages('/roles', `search=${encodeURIComponent(PROJECT_ROLE_PREFIX)}&`),
    roleUsers: (name) => pages(`/roles/${encodeURIComponent(name)}/users`),
    findByUsername: (username) => first(`username=${encodeURIComponent(username)}&exact=true`),
    findByEmail: (email) => first(`email=${encodeURIComponent(email)}&exact=true`),
    // 409 is another run, or another hand, having created the role already — read it back either way.
    createRole: async (name) => {
      await admin('/roles', { method: 'POST', body: { name }, tolerate: [409] });
      return admin(`/roles/${encodeURIComponent(name)}`);
    },
    grant: (userId, roles) =>
      admin(`/users/${userId}/role-mappings/realm`, { method: 'POST', body: roles }),
    revoke: (userId, roles) =>
      admin(`/users/${userId}/role-mappings/realm`, { method: 'DELETE', body: roles })
  };
}

/**
 * @param {string[]} argv
 * @param {object} [deps] test seam: {fetchJson, kc, credentials}
 */
async function sync(argv = [], deps = {}) {
  const args = parseArgs(argv);
  const get = deps.fetchJson || fetchJson;
  const kc = deps.kc || keycloakClient();
  const credentials = deps.credentials || credentialsRepository();

  const trackToken = await kc.clientToken(config.trackClientId, config.trackClientSecret);
  const teams = await get(`${config.trackApiBase}/api/v1/projects/team-members`,
    { Authorization: `Bearer ${trackToken}` });

  const roles = (await kc.listProjectRoles()).filter(r => r.name.startsWith(PROJECT_ROLE_PREFIX));
  const roleByName = new Map(roles.map(r => [r.name, r]));
  const userByUsername = new Map();
  const current = new Map();
  for (const role of roles) {
    for (const user of await kc.roleUsers(role.name)) {
      userByUsername.set(user.username, user);
      if (!current.has(user.username)) current.set(user.username, new Set());
      current.get(user.username).add(role.name);
    }
  }

  // The email fallback is a Keycloak read, so it is resolved here and handed to the pure plan().
  const usernameByEmail = new Map();
  for (const team of teams) {
    for (const staff of team.staff || []) {
      const email = emailKey(staff);
      if (staff.idir_user_id || !email || usernameByEmail.has(email)) continue;
      const user = await kc.findByEmail(email);
      if (user) {
        usernameByEmail.set(email, user.username);
        userByUsername.set(user.username, user);
      }
    }
  }

  const decided = plan(teams, { current, roles: new Set(roleByName.keys()), usernameByEmail });
  const summary = {
    mode: args.live ? 'live' : 'dry-run',
    projects: decided.projects,
    users: decided.users,
    grants: countRoles(decided.grants),
    revokes: countRoles(decided.revokes),
    unmatched: decided.unmatched.length,
    closedProjects: 0,
    credentialsRevoked: 0,
    trackProjects: 0,
    created: 0,
    updated: 0,
    orphaned: 0,
    failures: 0,
    plan: decided
  };

  const idFor = async (username) => {
    if (!userByUsername.has(username)) {
      const found = await kc.findByUsername(username);
      if (found) userByUsername.set(username, found);
    }
    const user = userByUsername.get(username);
    return user ? user.id : null;
  };

  for (const name of decided.rolesToCreate) {
    if (!args.live) continue;
    try {
      roleByName.set(name, await kc.createRole(name));
    } catch (err) {
      summary.failures++;
      logger.error(`[track-teams] create ${name} failed`, { error: err.message });
    }
  }

  const noUser = [];
  const apply = async (entries, write, label) => {
    for (const { username, roles: names } of entries) {
      const id = await idFor(username);
      if (!id) {
        summary.unmatched++;
        noUser.push(username);
        continue;
      }
      if (!args.live) continue;
      const reps = names.map(n => roleByName.get(n)).filter(Boolean);
      if (!reps.length) continue;
      try {
        await write(id, reps);
      } catch (err) {
        summary.failures++;
        logger.error(`[track-teams] ${label} ${username} failed`, { error: err.message });
      }
    }
  };
  await apply(decided.grants, kc.grant, 'grant');
  await apply(decided.revokes, kc.revoke, 'revoke');

  // Project state, not team membership: a closed project keeps its `project:<id>` role, because
  // that role follows Track staff. Only the credentials granted over the project end here.
  // Guarded end to end: a throw here must not swallow the grants/revokes already applied above,
  // or the summary line that reports them.
  try {
    const projects = await fetchTrackProjects(trackToken, get);

    // Its own try: a Cosmos outage in the mirror must not cost the credential sweep, which needs
    // no repository of its own.
    try {
      const mirrored = await syncProjects(projects, { live: args.live, deps });
      Object.assign(summary, {
        trackProjects: mirrored.trackProjects,
        created: mirrored.created,
        updated: mirrored.updated,
        orphaned: mirrored.orphaned
      });
      summary.failures += mirrored.failures;
    } catch (err) {
      summary.failures++;
      logger.error('[track-teams] project mirror failed', { error: err.message });
    }

    const closed = new Set((projects || []).filter(isClosed).map(p => String(p.id)));
    summary.closedProjects = closed.size;

    // One cross-partition read for the whole sweep, intersected here: the closed set only grows,
    // and a query per closed project re-asked every night about projects closed years ago.
    const liveGrants = await credentials.listLiveProjectScoped();
    const grantsOver = (id) => liveGrants.filter(row =>
      (row.scope && row.scope.ids || []).some(one => String(one) === id));

    for (const id of closed) {
      const grants = grantsOver(id);
      if (!grants.length) continue;
      try {
        // A grant over several projects is narrowed, not revoked; the count is the rows touched.
        const rows = args.live ? await credentials.revokeForProject(id, 'project-closed') : grants;
        summary.credentialsRevoked += rows.length;
      } catch (err) {
        summary.failures++;
        logger.error(`[track-teams] credential revoke for project ${id} failed`,
          { error: err.message });
      }
    }
  } catch (err) {
    summary.failures++;
    logger.error(`[track-teams] credential close-out failed`, { error: err.message });
  }

  // Without the names, `unmatched=N` is a number nobody can act on.
  if (noUser.length) {
    logger.warn(`[track-teams] no realm user for ${noUser.slice(0, 20).join(', ')}` +
      (noUser.length > 20 ? `, and ${noUser.length - 20} more` : ''));
  }

  return summary;
}

/** The line a log alert matches. */
function summaryLine(s) {
  return `[track-teams] mode=${s.mode} projects=${s.projects} users=${s.users} ` +
    `grants=${s.grants} revokes=${s.revokes} unmatched=${s.unmatched} ` +
    `closedProjects=${s.closedProjects} credentialsRevoked=${s.credentialsRevoked} ` +
    `trackProjects=${s.trackProjects} created=${s.created} updated=${s.updated} ` +
    `orphaned=${s.orphaned} failures=${s.failures}`;
}

/**
 * One run, logging exactly what the CLI logs — the nightly timer and the CLI must not be able to
 * produce different output, because the alert matches only one of the two lines.
 *
 * @param {object} [opts] {live} write, {deps} the same test seam `sync` takes
 */
async function run({ live = false, deps } = {}) {
  // See ORDERING at the top: `teamsFor` is the marker that a `project:<id>` role grants a team
  // rather than narrowing its holder. Required here so the check reads the module as loaded now.
  const refused = live && typeof require('../helpers/access-sql').teamsFor !== 'function';
  if (refused) logger.error('[track-teams] live sync refused: P3-2 team-grant model not present');

  const summary = await sync(live && !refused ? ['--live'] : [], deps);
  if (refused) summary.mode = 'refused';
  logger.info(summaryLine(summary));
  return summary;
}

/** 1 on any failed write, matching close-unpublished-track-projects.js. */
const exitCodeFor = (summary) => (summary.failures > 0 ? 1 : 0);

/**
 * credentials.revokeForProject audits through src/repositories/credentials.js; the audit buffer
 * flushes on an unref'd timer, so a CLI process.exit would drop rows still queued. Split out from
 * the exit call itself so a test can drive it without killing the test process.
 *
 * @param {object} [auditModule] test seam, defaults to the real src/utils/audit
 */
async function drainAudit(auditModule = require('../utils/audit')) {
  await auditModule.flush().catch(err => logger.error(`[track-teams] audit flush: ${err.message}`));
}

module.exports = {
  parseArgs, usernameFor, plan, keycloakClient, sync, summaryLine, run, exitCodeFor, drainAudit
};

if (require.main === module) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    logger.error(err.message);
    process.exit(1);
  }

  run({ live: args.live })
    .then(async summary => {
      await drainAudit();
      process.exit(exitCodeFor(summary));
    })
    .catch(err => {
      logger.error(`[track-teams] ${err.stack || err.message}`);
      process.exit(1);
    });
}
