'use strict';

/**
 * Selected Credentials (docs/rbac-architecture.md §1): a grant lets a named party see records, never
 * changes one, anyone else's access, or the field plane; read predicate: access-sql.js, access-odata.js.
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

// ponytail: each id is a bound SQL parameter and OData literal; raise only with a paged scope read.
const MAX_SCOPE_IDS = 200;

/** Default window offered by the UI. `end` is required regardless — this is not a cap. */
const DEFAULT_DAYS = 90;

function isIsoDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/**
 * Why this grant body is refused, or null. Expired credentials are never loaded, so a missing or
 * past `end` would mean an open-ended grant.
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

  return windowError(grant, now);
}

/** Why the grant's `start`/`end` window is refused, or null. */
function windowError(grant, now) {
  if (!grant.end) return 'end is required — a credential without one never expires';
  if (!isIsoDate(grant.end)) return 'end must be a date';
  if (Date.parse(grant.end) <= now) return 'end must be in the future';
  if (grant.start === undefined) return null;
  if (!isIsoDate(grant.start)) return 'start must be a date';
  if (Date.parse(grant.start) >= Date.parse(grant.end)) return 'start must be before end';
  return null;
}

/** Is this stored grant in force right now? Revoked, not yet started and expired all read false. */
function isLive(credential, now = Date.now()) {
  if (!credential || credential.revokedAt) return false;
  // NaN fails every comparison, so `> now` would let a start that does not parse grant.
  if (credential.start && !(Date.parse(credential.start) <= now)) return false;
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
  MAX_SCOPE_IDS,
  grantError,
  isLive,
  liveCredentials,
  defaultEnd
};
