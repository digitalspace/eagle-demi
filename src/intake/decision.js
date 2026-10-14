'use strict';

/**
 * What each Defender for Storage scan result does to an intake upload. Only the exact clean string
 * releases the file, because the release read's ABAC condition matches that string exactly; any
 * other result, including one this table does not know, rejects it.
 */

const CLEAN = 'No threats found';
// Defender appends detail to some results ("Not scanned - blob size exceeded"), so these match by prefix.
const REJECT_PREFIXES = [
  ['Malicious', 'malicious'],
  ['Not scanned', 'not-scanned'],
  ['Scan failed', 'scan-error'],
  ['Error', 'scan-error']
];

/** How long an upload link lives; the controller signs with it and the sweep waits it out. */
const UPLOAD_LINK_SECONDS = 15 * 60;

function decide(result) {
  if (result === CLEAN) return { status: 'clean', reason: null };
  const match = REJECT_PREFIXES.find(([prefix]) => String(result).startsWith(prefix));
  return { status: 'rejected', reason: match ? match[1] : 'unknown-result' };
}

module.exports = { decide, UPLOAD_LINK_SECONDS };
