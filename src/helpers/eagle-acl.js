'use strict';

/**
 * The `read[]` every Eagle mirror derives from Eagle's own. Apart from `seed/transform` so the
 * document repository's cascade can use it: transform already requires that repository.
 */

const { readForLevel, capRead, SEALED_TOKEN, LEVEL_TOKENS } = require('./access-sql');

/**
 * ACL for a seeded or pushed Eagle item, the one rule every Eagle mirror derives `read[]` through.
 *
 * Upstream `read[]` is preserved when present — Eagle carries role types already (`project-team`,
 * `admin:nrced`, `public`), and rewriting them would either widen an upstream restriction or
 * silently drop a role. Privileged DEMI callers do not need to appear in the list: `readClause`
 * short-circuits them to `true`.
 *
 * Two things are dropped: blank entries, and the sealed token. Eagle has no sealed compartment, so
 * kept, `compliance` would seal the copy and hide it from every ladder caller.
 *
 * With no upstream ACL the item lands at level 2 (All EAO). With only compliance left after the
 * blanks it lands at `['sysadmin']` before `withEagleStaff`. Every item gets an explicit `read[]`,
 * which is the condition for deleting the legacy no-ACL tier from the visibility predicate. Under a
 * parent, derive through `eagleReadUnder`, never `capRead(seedAcl(...))`.
 */
function seedAcl(upstreamRead) {
  return withEagleStaff(eagleBaseAcl(upstreamRead));
}

/** `seedAcl` without `withEagleStaff`: what the mirrors wrote before 2026-10-05. */
function eagleBaseAcl(upstreamRead) {
  if (!Array.isArray(upstreamRead) || upstreamRead.length === 0) return readForLevel(2);
  const kept = upstreamRead.filter(r => typeof r === 'string' && r.trim() !== '');
  const open = kept.filter(r => r !== SEALED_TOKEN);
  return open.length === 0 && kept.length > 0 ? ['sysadmin'] : open;
}

const LADDER_TOKENS = Object.freeze(Object.values(LEVEL_TOKENS));

/**
 * Eagle's `staff` role skips every read check, so an Eagle read with no ladder token (`['sysadmin']`,
 * `['sysadmin','inspector']`) gains `staff`: level 2. Approved 2026-10-05; remove here to drop it
 * (docs/rbac-architecture.md §1). Under a parent it gives way to `eagleReadUnder`.
 */
function withEagleStaff(read) {
  if (read.includes(SEALED_TOKEN) || read.some(r => LADDER_TOKENS.includes(r))) return read;
  return [...read, LEVEL_TOKENS[2]];
}

/**
 * An Eagle read under a parent's `cap`, the one rule for every capped Eagle mirror: `seedAcl`, then
 * `under` (default `capRead`). Where that lands at `team`, the read without `withEagleStaff` is
 * capped instead, so the added `staff` never opens a row to the project's team members.
 */
function eagleReadUnder(upstreamRead, cap, under = capRead) {
  const base = eagleBaseAcl(upstreamRead);
  const read = under(withEagleStaff(base), cap);
  // `capRead`'s only level-1 result that is not privileged-only is `readForLevel(1)`.
  return read.includes(LEVEL_TOKENS[1]) ? under(base, cap) : read;
}

module.exports = { seedAcl, eagleBaseAcl, withEagleStaff, eagleReadUnder };
