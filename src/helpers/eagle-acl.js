'use strict';

/**
 * The `read[]` every Eagle mirror derives from Eagle's own. Apart from `seed/transform` so the
 * document repository's cascade can use it: transform already requires that repository.
 */

const { readForLevel, capRead, SEALED_TOKEN } = require('./access-sql');

/**
 * ACL for a seeded or pushed Eagle item, the one rule every Eagle mirror derives `read[]` through.
 *
 * Upstream `read[]` is preserved when present — Eagle carries role types already (`project-team`,
 * `admin:nrced`, `public`), and rewriting them would either widen an upstream restriction or
 * silently drop a role. Privileged DEMI callers do not need to appear in the list: `readClause`
 * short-circuits them to `true`. No token is added: Eagle matches roles literally, so its
 * `['sysadmin']` row stays `['sysadmin']` here (docs/rbac-architecture.md §1).
 *
 * Two things are dropped: blank entries, and the sealed token. Eagle has no sealed compartment, so
 * kept, `compliance` would seal the copy and hide it from every ladder caller.
 *
 * With no `read[]` at all (a legacy row) the item lands at level 2 (All EAO). An empty list, or one
 * left empty once blanks and compliance are dropped, lands at `['sysadmin']`: Eagle hides
 * `read: []` from everyone. Every item gets an explicit `read[]`, which is the condition for
 * deleting the legacy no-ACL tier from the visibility predicate. Under a parent, derive through
 * `eagleReadUnder`.
 */
function eagleBaseAcl(upstreamRead) {
  if (!Array.isArray(upstreamRead)) return readForLevel(2);
  const open = upstreamRead.filter(r => typeof r === 'string' && r.trim() !== '' && r !== SEALED_TOKEN);
  return open.length === 0 ? ['sysadmin'] : open;
}

/**
 * An Eagle read under a parent's `cap`, the one rule for every capped Eagle mirror: `eagleBaseAcl`,
 * then `capRead`, so the row lets in no caller its parent keeps out and never becomes `team`.
 */
function eagleReadUnder(upstreamRead, cap) {
  return capRead(eagleBaseAcl(upstreamRead), cap);
}

module.exports = { eagleBaseAcl, eagleReadUnder };
