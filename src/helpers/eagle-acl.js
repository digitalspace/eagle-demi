'use strict';

/**
 * The `read[]` every Eagle mirror derives from Eagle's own. Apart from `seed/transform` so the
 * document repository's cascade can use it: transform already requires that repository.
 */

const { readForLevel, capRead, SEALED_TOKEN } = require('./access-sql');

/**
 * Upstream roles kept as-is (rewriting widens or drops one); the sealed token goes, Eagle has none.
 * No `read[]` lands at level 2; an empty list lands at `['sysadmin']`, as Eagle hides `read: []`.
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
