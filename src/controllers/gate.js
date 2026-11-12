'use strict';

/**
 * POST /api/gate, eagle-api's contract: 404 no curtain, 401 wrong password, 204 match. The password
 * is only compared here, never shipped in a bundle, never in `PUBLIC_KEYS`.
 */

const config = require('../config');
const configRepository = require('../repositories/config');
const { matchesConfiguredKey } = require('../helpers/auth');
const { callerIp } = require('../utils/caller-ip');
const { isKeyVaultReference } = require('../utils/key-vault-reference');
const { logger } = require('../utils/logger');

/** The `ACCESS_GATE` the site boots on, so showing and answering cannot disagree; null if unread. */
async function accessGateEnabled() {
  const stored = await configRepository.getPublic();
  if (!stored) return null;
  return stored.ACCESS_GATE === true;
}

// ponytail: no per-caller throttle (APIM Consumption lacks rate-limit-by-key); needs a higher APIM tier.
exports.postGate = async (req, res) => {
  // Flag before password, always: a password left in app settings after the curtain lifts must
  // never read as "gate is on".
  let enabled;
  try {
    enabled = await accessGateEnabled();
  } catch (err) {
    logger.error(`[gate] public config read failed: ${err.message}`);
    enabled = null;
  }

  // Unreadable or unseeded is NOT "gate off": a 404 would tell eagle-public this environment runs
  // ungated. Same 503 as getPublicConfig.
  if (enabled === null) {
    logger.warn('[gate] attempt refused as 503 — public config document is unavailable');
    return res.set('Cache-Control', 'no-store').status(503)
      .json({ error: 'Public configuration is unavailable.' });
  }

  if (!enabled) {
    logger.info(`[gate] attempt rejected as 404 (ACCESS_GATE is false) from ${callerIp(req)}`);
    return res.status(404).json({ message: 'Not Found' });
  }

  // src/config.js already empties an unresolved Key Vault reference; re-checked because that
  // literal is public in this repo and must never double as the password.
  const password = config.accessGatePassword;
  const expected = isKeyVaultReference(password) ? '' : password;

  // Flag on with no password is a misconfiguration, not "no gate": a 404 here would tell
  // eagle-public this environment runs ungated when eagle-api's flag says the opposite.
  if (!expected) {
    logger.error('[gate] misconfigured: ACCESS_GATE is true but no password is configured');
    return res.set('Cache-Control', 'no-store').status(503)
      .json({ error: 'Gate misconfigured' });
  }

  const supplied = req.body && req.body.password;

  // helpers/auth.js: length check before `timingSafeEqual`, which throws on unequal buffers. So a
  // length mismatch is a 401 like any other wrong password, not a 500.
  if (typeof supplied === 'string' && matchesConfiguredKey(supplied, [expected])) {
    logger.info(`[gate] access granted to ${callerIp(req)}`);
    return res.status(204).send('');
  }

  logger.warn(`[gate] access attempt rejected from ${callerIp(req)}`);
  return res.status(401).json({ error: 'Invalid password' });
};
