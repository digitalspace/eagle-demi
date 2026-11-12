'use strict';

/**
 * `POST /api/access/simulate`: data-free; every answer comes from the real access helpers, never a
 * re-encoded rule. Authenticated: the answer is the whole field catalog and a role-privilege oracle.
 */

const {
  resolveAccess, canRead, readForLevel, LEVEL_TOKENS, PROJECT_ROLE_PREFIX
} = require('../helpers/access-sql');
const { grantError, MAX_SCOPE_IDS } = require('../helpers/credentials');
const { catalogFor } = require('../vis/catalog');
const { redactForAccess } = require('../vis/redact');
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
 * Why this body is refused, or null. `grantError` is the check `POST /credentials` uses, so a grant
 * the registry would reject is refused here too; party and window are filled in, not simulated.
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

  const credentials = body.credential
    ? [{ ...body.credential, end: new Date(now + SIMULATED_END_MS).toISOString() }]
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
  // Minus `credentials`: /api/me lists the caller's OWN live grants, while the one here is the
  // hypothetical from the request body, already answered by the `rows` arms below.
  delete body.credentials;
  return body;
}

/**
 * One row per ladder level: its `read[]`, whether this caller reads it, and which arm grants it.
 * The arm is found by removing one grant at a time and asking the real `canRead` again.
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
    rows[level] = { readable: readableAt(access, level), via, read: readForLevel(level) };
  }
  return rows;
}

/**
 * Values are `1`: truthy so no key drops as empty, not `true` so `=== true` predicates read false.
 * ponytail: a predicate testing plain truthiness would widen its field; use per-field values then.
 */
function probeRecord(catalog) {
  const record = {};
  for (const key of Object.keys(catalog)) {
    const dot = key.indexOf('.');
    if (dot === -1) continue;
    const parent = key.slice(0, dot);
    record[parent] = { ...record[parent], [key.slice(dot + 1)]: 1 };
  }
  for (const key of Object.keys(catalog)) {
    if (!key.includes('.') && !(key in record)) record[key] = 1;
  }
  return record;
}

/** Did this catalog key survive redaction — a dotted key under its parent, everything else at top. */
function survives(seen, field) {
  const dot = field.indexOf('.');
  if (dot === -1) return Object.hasOwn(seen, field);

  const parent = seen[field.slice(0, dot)];
  return Boolean(parent) && typeof parent === 'object' && Object.hasOwn(parent, field.slice(dot + 1));
}

/**
 * Every catalogued field of one entity and whether this caller sees it. Asks the real redactor, so
 * rules the catalog lacks (`sources.*` gated on ENRICHMENT_SOURCES) show as the boundary applies them.
 */
function fieldsFor(entity, access) {
  const catalog = catalogFor(entity);
  const seen = redactForAccess(entity, probeRecord(catalog), access);

  return Object.entries(catalog).map(([field, entry]) => ({
    field,
    defaultVis: entry.defaultVis,
    maxVis: entry.maxVis,
    when: entry.when || null,
    visible: survives(seen, field)
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
      projects: fieldsFor('projects', access),
      documents: fieldsFor('documents', access)
    },
    predicatesAssumedFalse: true,
    notes: { sealedCompartment: 'live, /api/sealed only' }
  });
};
