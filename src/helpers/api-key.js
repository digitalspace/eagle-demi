'use strict';

const crypto = require('crypto');

/**
 * Registry API keys — minting, parsing and constant-time verification.
 *
 * Format: `demi_<env>_<keyId>_<secret>`
 *
 * The keyId is PUBLIC and carried in the key itself on purpose. Without it, verifying a presented
 * key would mean scanning every stored key and comparing each hash; with it, verification is a
 * single-partition point read on the `apikeys` container. It also means a leaked key can be traced
 * back to its consumer from a log line without the secret ever being logged.
 *
 * Hashing is SHA-256, NOT bcrypt/argon2, and that is deliberate. Password KDFs exist to make
 * guessing a low-entropy human secret expensive. These secrets are 32 bytes of CSPRNG output —
 * there is nothing to guess, so a KDF would only add latency to every authenticated request. What
 * does matter is that the compare is constant-time, which is what `verify` below is for.
 *
 * Nothing here touches storage; see repositories/api-keys.js.
 */

const PREFIX = 'demi';
const SECRET_BYTES = 32;
const KEY_ID_BYTES = 8;

/** Ninety days, matching the landing zone's maximum secret lifetime. */
const DEFAULT_TTL_DAYS = 90;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/**
 * Mint a key. The plaintext is returned exactly once and never stored — only its digest is.
 *
 * @param {string} env  environment tag baked into the key, so a dev key is visibly not a prod key
 */
function generateKey(env = 'dev') {
  const keyId = crypto.randomBytes(KEY_ID_BYTES).toString('hex');
  const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');

  return {
    keyId,
    plaintext: `${PREFIX}_${env}_${keyId}_${secret}`,
    hash: sha256(secret)
  };
}

/**
 * Split a presented key. Returns null for anything that is not one of ours, which is how the
 * auth path decides whether to consult the registry at all.
 *
 * The secret is base64url, whose alphabet INCLUDES `_`, so the secret routinely contains
 * underscores and a fixed 4-part split rejects perfectly valid keys at random. Only the first
 * three separators are structural; everything after them is the secret.
 */
function parseKey(presented) {
  if (typeof presented !== 'string') return null;

  const parts = presented.split('_');
  if (parts.length < 4) return null;

  const [prefix, env, keyId] = parts;
  const secret = parts.slice(3).join('_');
  if (prefix !== PREFIX || !env || !keyId || !secret) return null;

  return { env, keyId, secret };
}

/**
 * Constant-time verification of a presented secret against a stored record.
 *
 * Checks the digest first and the lifecycle after, and returns a single boolean, so a caller
 * cannot distinguish "wrong secret" from "revoked key" by timing or by message.
 *
 * @param {object} record   the stored registry item
 * @param {string} secret   the secret half of the presented key
 * @param {number} now      injectable clock, so expiry is testable without waiting 90 days
 */
function verify(record, secret, now = Date.now()) {
  if (!record || typeof record.hash !== 'string') return false;

  const presentedBuf = Buffer.from(sha256(secret));
  const storedBuf = Buffer.from(record.hash);

  // Digests are fixed-length, so a length mismatch means a malformed record, not a wrong key.
  if (presentedBuf.length !== storedBuf.length) return false;
  if (!crypto.timingSafeEqual(presentedBuf, storedBuf)) return false;

  if (record.revokedAt) return false;
  // An unparseable date must not read as "never expires" — NaN loses every comparison.
  if (record.expiresAt && !(new Date(record.expiresAt).getTime() > now)) return false;

  return true;
}

/** Default expiry for a newly minted key, as an ISO string. */
function defaultExpiry(now = Date.now()) {
  return new Date(now + DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

module.exports = {
  PREFIX,
  DEFAULT_TTL_DAYS,
  generateKey,
  parseKey,
  verify,
  defaultExpiry,
  sha256
};
