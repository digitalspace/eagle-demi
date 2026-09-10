'use strict';

/**
 * POST /api/gate — the public site's access curtain.
 *
 * Ported from eagle-api `api/controllers/gate.js` so eagle-public stops calling eagle-api for it.
 * Same contract, same three answers: 404 where no curtain is in use, 401 wrong password, 204 match.
 *
 * UNAUTHENTICATED, and it has to be: the caller is a visitor who holds nothing yet. The password is
 * only ever compared here, so it never ships in a bundle and must never enter `PUBLIC_KEYS`.
 *
 * ponytail: no per-caller throttle — APIM Consumption has no `rate-limit-by-key` (same limitation
 * noted on /health/search-schema), so password entropy is the only bound; needs a higher APIM tier.
 */

const config = require('../config');
const configRepository = require('../repositories/config');
const { matchesConfiguredKey } = require('../helpers/auth');
const { callerIp } = require('../utils/caller-ip');
const { logger } = require('../utils/logger');

/**
 * The `ACCESS_GATE` the site itself boots on, so the flag that shows the gate and the flag that
 * makes it answer cannot disagree. Null where the document could not be read.
 */
async function accessGateEnabled() {
  const stored = await configRepository.getPublic();
  if (!stored) return null;
  return stored.ACCESS_GATE === true;
}

exports.postGate = async (req, res) => {
  // The flag is checked before the password on every request now, so a password left in app
  // settings after the curtain was lifted can never leak through as a false "gate is on": no
  // Cosmos-skip shortcut for the empty-password case anymore.
  let enabled;
  try {
    enabled = await accessGateEnabled();
  } catch (err) {
    logger.error(`[gate] public config read failed: ${err.message}`);
    enabled = null;
  }

  // An unreadable or unseeded document is NOT "the gate is off". 503 for the same reason
  // GET /config/public answers 503 rather than defaulting — see getPublicConfig. A 404 here would
  // tell eagle-public this environment runs ungated, which is the one wrong answer available.
  if (enabled === null) {
    logger.warn('[gate] attempt refused as 503 — public config document is unavailable');
    return res.set('Cache-Control', 'no-store').status(503)
      .json({ error: 'Public configuration is unavailable.' });
  }

  if (!enabled) {
    logger.info(`[gate] attempt rejected as 404 (ACCESS_GATE is false) from ${callerIp(req)}`);
    return res.status(404).json({ message: 'Not Found' });
  }

  const expected = config.accessGatePassword;

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
