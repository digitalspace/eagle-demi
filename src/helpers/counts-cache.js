'use strict';

/**
 * How long one caller's counts are reused: bounds a count per type per keystroke pause on a 1-SU
 * service, short enough that a newly published record shows within a page view.
 */
const COUNTS_TTL_MS = 45 * 1000;

/** Entries kept per cache. One per distinct query/access pair, evicted oldest-first. */
const COUNTS_CACHE_MAX = 200;

/**
 * Every access input the count reads read. Over-specific on purpose: an extra field costs a cache
 * miss, a missing one serves one caller's counts to another.
 */
function accessFingerprint(access) {
  return JSON.stringify({
    tier: access.tier,
    level: access.level,
    roles: [...(access.roles || [])].sort(),
    teams: [...(access.teams || [])].sort(),
    projectScope: access.projectScope ? [...access.projectScope].sort() : null,
    compartment: access.compartment || null,
    credentials: access.credentials || []
  });
}

/**
 * A keyed cache of PROMISES, not values, which is what dedupes requests in flight.
 * `read(key, compute)` answers `{ promise, cached }`.
 */
function createCountsCache() {
  const entries = new Map();

  function read(key, compute) {
    const now = Date.now();
    const hit = entries.get(key);
    if (hit && now - hit.at < COUNTS_TTL_MS) return { promise: hit.promise, cached: true };

    const entry = { at: now, promise: compute() };
    // Re-inserted so eviction order is by freshness rather than by first sighting.
    entries.delete(key);
    entries.set(key, entry);
    // A rejection must not be remembered for the whole TTL; a newer entry under the key stays.
    entry.promise.catch(() => {
      if (entries.get(key) === entry) entries.delete(key);
    });
    while (entries.size > COUNTS_CACHE_MAX) {
      entries.delete(entries.keys().next().value);
    }
    return { promise: entry.promise, cached: false };
  }

  return { read, clear: () => entries.clear() };
}

module.exports = { accessFingerprint, createCountsCache };
