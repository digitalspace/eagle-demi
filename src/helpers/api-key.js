'use strict';

const crypto = require('crypto');

/**
 * Registry API keys `demi_<env>_<keyId>_<secret>`. The keyId is public so verify is one point read on `apikeys`.
 * SHA-256, not a password KDF: the secret is 32 random bytes with nothing to guess; the compare is constant-time.
 */

const PREFIX = 'demi';
const SECRET_BYTES = 32;
const KEY_ID_BYTES = 8;

/** Ninety days, matching the landing zone's maximum secret lifetime. */
const DEFAULT_TTL_DAYS = 90;

/** Allow-list: the SDK throws on some ids (no status code) and rewrites `.` and `..` as paths. */
function isStorableId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9:-]{1,255}$/.test(id);
}

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
 * Null for anything not ours, so auth skips the registry. The base64url secret can contain `_`, so
 * only the first three separators are structural.
 */
function parseKey(presented) {
  if (typeof presented !== 'string') return null;

  const parts = presented.split('_');
  if (parts.length < 4) return null;

  const [prefix, env, keyId] = parts;
  const secret = parts.slice(3).join('_');
  if (prefix !== PREFIX || !env || !isStorableId(keyId) || !secret) return null;

  return { env, keyId, secret };
}

/**
 * Digest first, lifecycle after, one boolean: "wrong secret" and "revoked key" look the same by
 * timing and by message.
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

  return isLive(record, now);
}

/**
 * Lifecycle half of `verify`: not revoked, not expired. Split out for the APIM path, where the
 * gateway has already proven the caller and there is no secret of ours to check.
 */
function isLive(record, now = Date.now()) {
  if (!record) return false;
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
  generateKey,
  parseKey,
  verify,
  isLive,
  defaultExpiry,
  isStorableId,
  sha256
};
