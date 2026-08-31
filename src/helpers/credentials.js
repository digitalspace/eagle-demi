'use strict';

/**
 * Selected Credentials — the grant's rules (docs/rbac-architecture.md §1).
 *
 * A credential lets a named party SEE specified records at levels 1-3. It never changes a record,
 * never changes anyone else's access, and never touches the field plane: what attributes the
 * holder sees is still decided by the holder's own level.
 *
 * This module owns two things only — what a valid grant looks like, and whether a stored grant is
 * live right now. The predicate that reads it lives in `access-sql.js` and `access-odata.js`, and
 * the storage in `repositories/credentials.js`.
 */

/** A person logging in (BCeID Business), a realm group, or a registry API key. */
const PARTY_TYPES = Object.freeze(['user', 'group', 'apikey']);

/** What the ids in `scope.ids` name. */
const SCOPE_TYPES = Object.freeze(['document', 'project']);

/**
 * Levels a credential may grant. 0 is the sealed compartment and 4 is public: neither is something
 * a grant can hand out, and level 4 needs no credential at all.
 */
const GRANTABLE_LEVELS = Object.freeze([1, 2, 3]);

/**
 * ponytail: id-list ceiling. A grant over more records than this wants `scope.type: 'project'`,
 * which covers a whole assessment in one row; raise it only with a paged read on the scope list,
 * since every id in it is a bound SQL parameter and a literal in the OData filter.
 */
const MAX_SCOPE_IDS = 200;

/** Default window offered by the UI. `end` is required regardless — this is not a cap. */
const DEFAULT_DAYS = 90;

function isIsoDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/**
 * Why this grant body is refused, or null when it is a grant.
 *
 * Validation is on the GRANT, never on the login: an expired credential is simply not loaded, so a
 * missing or past `end` here would mean an open-ended one.
 *
 * @param {object} body   the request body
 * @param {number} [now]  epoch ms
 * @returns {string|null}
 */
function grantError(body, now = Date.now()) {
  const grant = body || {};
  const party = grant.party || {};
  const scope = grant.scope || {};

  if (!PARTY_TYPES.includes(party.type)) {
    return `party.type must be one of ${PARTY_TYPES.join(', ')}`;
  }
  if (!party.id || typeof party.id !== 'string') return 'party.id is required';

  if (!SCOPE_TYPES.includes(scope.type)) {
    return `scope.type must be one of ${SCOPE_TYPES.join(', ')}`;
  }
  if (!Array.isArray(scope.ids) || scope.ids.length === 0) {
    return 'scope.ids must be a non-empty array';
  }
  if (scope.ids.length > MAX_SCOPE_IDS) {
    return `scope.ids holds ${scope.ids.length} ids; at most ${MAX_SCOPE_IDS} per grant — ` +
      'use scope.type "project" to cover a whole assessment in one row';
  }

  if (!Array.isArray(grant.levels) || grant.levels.length === 0) {
    return 'levels must be a non-empty array';
  }
  const ungrantable = grant.levels.filter(l => !GRANTABLE_LEVELS.includes(l));
  if (ungrantable.length > 0) {
    return `levels ${ungrantable.join(', ')} cannot be granted — a credential grants ` +
      `${GRANTABLE_LEVELS.join(', ')} only (0 is sealed, 4 is public and needs no credential)`;
  }

  if (!grant.end) return 'end is required — a credential without one never expires';
  if (!isIsoDate(grant.end)) return 'end must be a date';
  if (Date.parse(grant.end) <= now) return 'end must be in the future';
  if (grant.start !== undefined && !isIsoDate(grant.start)) return 'start must be a date';

  return null;
}

/** Is this stored grant in force right now? Revoked, not yet started and expired all read false. */
function isLive(credential, now = Date.now()) {
  if (!credential || credential.revokedAt) return false;
  if (credential.start && Date.parse(credential.start) > now) return false;
  return isIsoDate(credential.end) && Date.parse(credential.end) > now;
}

/** The subset of stored rows that grants anything. Filtered in JS — see middleware/credentials.js. */
function liveCredentials(rows, now = Date.now()) {
  return (rows || []).filter(c => isLive(c, now));
}

/** The `end` the UI offers when the operator does not pick one. */
function defaultEnd(now = Date.now()) {
  return new Date(now + DEFAULT_DAYS * 86400000).toISOString();
}

module.exports = {
  PARTY_TYPES,
  SCOPE_TYPES,
  GRANTABLE_LEVELS,
  MAX_SCOPE_IDS,
  DEFAULT_DAYS,
  grantError,
  isLive,
  liveCredentials,
  defaultEnd
};
