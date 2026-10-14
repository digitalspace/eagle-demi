'use strict';

/**
 * What each Defender for Storage scan result does to an intake upload. Only a clean result releases
 * the file; anything else, including a result this table does not know, rejects it.
 */
const RESULTS = {
  'No threats found': { status: 'clean', reason: null },
  Malicious: { status: 'rejected', reason: 'malicious' },
  Error: { status: 'rejected', reason: 'scan-error' },
  'Not scanned': { status: 'rejected', reason: 'not-scanned' }
};

/** Reasons the sweep writes. An event arriving for a row rejected with one of these is late. */
const SWEEP_REASONS = ['timeout', 'no-upload'];

function decide(scanResultType) {
  return Object.hasOwn(RESULTS, scanResultType)
    ? RESULTS[scanResultType]
    : { status: 'rejected', reason: 'unknown-result' };
}

module.exports = { decide, SWEEP_REASONS };
