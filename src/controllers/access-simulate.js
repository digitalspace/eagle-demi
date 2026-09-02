'use strict';

/**
 * `POST /api/access/simulate` — what THIS engine answers for a hypothetical caller.
 *
 * Anonymous and data-free: it reads no container, writes nothing, and grants nothing. Every value
 * in the response comes from the helpers the real reads compose — `resolveAccess`, `canRead`, the
 * field catalogs — so the Access Model screen renders the rules instead of a second copy of them
 * that drifts. Nothing here may re-encode a rule; if an answer is not available from a helper,
 * the helper is what needs the export.
 */

const {
  resolveAccess, canRead, readForLevel, LEVEL_TOKENS, PROJECT_ROLE_PREFIX
} = require('../helpers/access-sql');
const { grantError, liveCredentials, MAX_SCOPE_IDS } = require('../helpers/credentials');
const { catalogFor } = require('../vis/catalog');
const { effectiveVis, visible } = require('../vis/redact');
const { getMe } = require('./me');

const BODY_KEYS = ['roles', 'identityProvider', 'teams', 'projectScope', 'credential'];
const CREDENTIAL_KEYS = ['scope', 'levels'];

/** The `identity_provider` claim values the realm issues. Only `idir` moves the ladder (rolesFor). */
const IDENTITY_PROVIDERS = ['idir', 'bceid', 'github'];

/** The ladder, in the order the screen draws it. Read off the tokens so it cannot be stale. */
const LADDER = Object.keys(LEVEL_TOKENS).map(Number);

/** Stands in for the key id a `projectScope` only ever arrives on. Names no real registry row. */
const SIMULATED_KEY_ID = 'simulated';

/** Any future `end` makes the row live; the window itself is not part of the answer. */
const SIMULATED_END_MS = 86_400_000;

/** The partition id every probe row carries, so the team and credential arms have something to hit. */
function probeId(teams, credential) {
  if (teams.length > 0) return teams[0];
  // ponytail: one probe id. A caller holding teams AND a credential over DIFFERENT projects sees
  // the team arm only; give each arm its own probe row if that combination ever needs showing.
  const ids = (credential && credential.scope && credential.scope.ids) || [];
  return ids.length > 0 ? String(ids[0]) : 'simulated-project';
}

function listError(value, name) {
  if (!Array.isArray(value)) return `${name} must be an array of strings`;
  if (value.length > MAX_SCOPE_IDS) return `${name} takes at most ${MAX_SCOPE_IDS} entries`;
  if (!value.every(v => typeof v === 'string' && v.trim().length > 0)) {
    return `${name} must be an array of strings`;
  }
  return null;
}

/**
 * Why this body is refused, or null.
 *
 * The credential is validated by `grantError`, the same function `POST /credentials` refuses a real
 * grant with — a simulated grant the registry would reject must not be simulated as if it worked.
 * The party and window it also demands are supplied here: neither is something a caller simulates.
 */
function bodyError(body, now) {
  const unknown = Object.keys(body).filter(key => !BODY_KEYS.includes(key));
  if (unknown.length > 0) return `unknown field(s): ${unknown.join(', ')}`;

  for (const name of ['roles', 'teams', 'projectScope']) {
    if (body[name] === undefined || body[name] === null) continue;
    const bad = listError(body[name], name);
    if (bad) return bad;
  }

  const idp = body.identityProvider;
  if (idp !== undefined && idp !== null && !IDENTITY_PROVIDERS.includes(idp)) {
    return `identityProvider must be one of ${IDENTITY_PROVIDERS.join(', ')}`;
  }

  const credential = body.credential;
  if (credential === undefined || credential === null) return null;
  if (typeof credential !== 'object' || Array.isArray(credential)) {
    return 'credential must be an object';
  }
  const unknownCredential = Object.keys(credential).filter(key => !CREDENTIAL_KEYS.includes(key));
  if (unknownCredential.length > 0) {
    return `unknown credential field(s): ${unknownCredential.join(', ')}`;
  }
  return grantError({
    party: { type: 'user', id: SIMULATED_KEY_ID },
    scope: credential.scope,
    levels: credential.levels,
    end: new Date(now + SIMULATED_END_MS).toISOString()
  }, now);
}

/** The request the auth layer and middleware/credentials.js would have built for this caller. */
function syntheticRequest(body, now) {
  const teams = body.teams || [];
  const user = {
    realm_access: {
      roles: [...(body.roles || []), ...teams.map(id => `${PROJECT_ROLE_PREFIX}${id}`)]
    }
  };
  if (body.identityProvider) user.identity_provider = body.identityProvider;
  if (Array.isArray(body.projectScope)) {
    user.projectScope = body.projectScope;
    user.keyId = SIMULATED_KEY_ID;
  }

  // liveCredentials is the middleware's own window filter, so a grant that would not be loaded
  // cannot be simulated as if it had been.
  const credentials = body.credential
    ? liveCredentials([{ ...body.credential, end: new Date(now + SIMULATED_END_MS).toISOString() }], now)
    : [];

  return { user, credentials };
}

/**
 * What `GET /api/me` answers for this caller — the controller itself rather than a re-derivation,
 * so the simulator and the endpoint it explains cannot disagree.
 */
function meFor(request) {
  let body;
  getMe(request, { json: (data) => { body = data; } });
  return body;
}

/**
 * One row per ladder level: can this caller read a row at that level, and which arm got it there.
 *
 * The arms are separated by REMOVING one grant at a time from the resolved access and asking the
 * real `canRead` again — a caller that reads the row with neither team nor credential is there on
 * its roles.
 */
function rowsFor(access, probe) {
  const roleOnly = { ...access, teams: [], credentials: [] };
  const noCredentials = { ...access, credentials: [] };
  const noTeams = { ...access, teams: [] };
  const readableAt = (context, level) =>
    canRead({ id: probe, projectId: probe, read: readForLevel(level) }, context);

  const rows = {};
  for (const level of LADDER) {
    const via = readableAt(roleOnly, level) ? 'role'
      : readableAt(noCredentials, level) ? 'team'
        : readableAt(noTeams, level) ? 'credential'
          : null;
    rows[level] = { readable: readableAt(access, level), via };
  }
  return rows;
}

/** Every catalogued field of one entity, and whether this level sees it. Plumbing keys included. */
function fieldsFor(entity, level) {
  return Object.entries(catalogFor(entity)).map(([field, entry]) => ({
    field,
    defaultVis: entry.defaultVis,
    maxVis: entry.maxVis,
    when: entry.when || null,
    // No record is simulated, so every `when` reads false and each field sits at its defaultVis.
    visible: visible(level, effectiveVis(entry, undefined, {}))
  }));
}

exports.simulate = (req, res) => {
  const body = req.body || {};
  const now = Date.now();

  const problem = bodyError(body, now);
  if (problem) return res.status(400).json({ error: problem });

  const request = syntheticRequest(body, now);
  const me = meFor(request);
  const access = resolveAccess(request);

  return res.json({
    ...me,
    rows: rowsFor(access, probeId(body.teams || [], body.credential)),
    fields: {
      projects: fieldsFor('projects', me.level),
      documents: fieldsFor('documents', me.level)
    },
    predicatesAssumedFalse: true,
    notes: { sealedCompartment: 'designed, not built (Phase 5)' }
  });
};
