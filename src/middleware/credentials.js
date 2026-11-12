'use strict';

/**
 * Parties come only from the verified credential (`sub`, realm groups, registry key id), never a header
 * or query param. Grants land on `req`, not `access`, because `resolveAccess` is synchronous.
 */

const credentials = require('../repositories/credentials');
const { liveCredentials } = require('../helpers/credentials');
const { logger } = require('../utils/logger');

/**
 * ponytail: a revoke takes effect within the TTL; drop the TTL if that is ever too slow.
 * Same shape and same bound as the API-key cache in helpers/auth.js.
 */
const CREDENTIAL_CACHE_TTL_MS = 60_000;
const cache = new Map();

async function loadForParty(partyId, now) {
  const cached = cache.get(partyId);
  if (cached && now - cached.at < CREDENTIAL_CACHE_TTL_MS) return cached.rows;

  const rows = await credentials.listForParty(partyId);
  // ponytail: whole-cache flush at 10k parties bounds heap; per-entry LRU if churn ever matters.
  if (cache.size >= 10000) cache.clear();
  cache.set(partyId, { rows, at: now });
  return rows;
}

/** Every party identity this caller holds. Empty for an anonymous one, which does no read at all. */
function partiesFor(user) {
  if (!user) return [];
  const parties = [user.sub, user.keyId, ...(Array.isArray(user.groups) ? user.groups : [])];
  return Array.from(new Set(parties.filter(Boolean).map(String)));
}

/**
 * Set `req.credentials` to the live grants this caller holds. Never throws and never rejects: a
 * lookup that fails leaves the caller with none, which is the fail-closed direction.
 */
async function attachCredentials(req, now = Date.now()) {
  const parties = partiesFor(req && req.user);
  if (parties.length === 0) {
    if (req) req.credentials = [];
    return [];
  }

  try {
    const rows = (await Promise.all(parties.map(p => loadForParty(p, now)))).flat();
    // Revoke and time window filter here, not in SQL, so no time-dependent predicate reaches every read.
    req.credentials = liveCredentials(rows, now);
  } catch (err) {
    logger.error(`[credentials] lookup failed, continuing with none: ${err.message}`);
    req.credentials = [];
  }
  return req.credentials;
}

/**
 * Mounted AFTER `authMiddleware` or `passiveAuthMiddleware` on every read route where a grant can
 * matter — it reads `req.user`, so on its own it attaches nothing.
 */
function credentialsMiddleware(req, _res, next) {
  attachCredentials(req).then(() => next());
}

/** Test seam and revoke path: forget one party's cached grants on this instance. */
function forgetCachedParty(partyId) {
  cache.delete(String(partyId));
}

module.exports = {
  credentialsMiddleware,
  attachCredentials,
  partiesFor,
  forgetCachedParty,
  CREDENTIAL_CACHE_TTL_MS
};
