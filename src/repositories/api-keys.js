'use strict';

/**
 * Container `apikeys`, partitioned by `/id` = public keyId, so each verification is a point read.
 * No read ACL: only `helpers/auth.js` and gated admin routes reach it; never wire it into a public read.
 */

const cosmos = require('../db/cosmos-nosql');

const CONTAINER = 'apikeys';

/** Strip the secret digest before anything is returned to a caller. */
function redact(record) {
  if (!record) return null;
  const { hash: _hash, ...rest } = record;
  return rest;
}

/** Point read by public key id. Returns the RAW record — callers inside auth need `hash`. */
async function getById(keyId) {
  return cosmos.readItem(CONTAINER, String(keyId), String(keyId));
}

async function upsert(record) {
  return cosmos.upsert(CONTAINER, record);
}

/**
 * Cross-partition, but one item per consumer keeps it tiny. Revoked keys stay listed on purpose, so
 * an operator sees that a key existed.
 */
async function listRedacted() {
  const { items } = await cosmos.query(CONTAINER, {
    query: 'SELECT * FROM c ORDER BY c.createdAt DESC',
    parameters: []
  });
  return (items || []).map(redact);
}

/**
 * Stamps `revokedAt`, never deletes: the row is the audit trail for a leaked key. Null for an
 * unknown key; `revoked` is false when the key was already revoked.
 */
async function revoke(keyId, at = new Date().toISOString()) {
  const existing = await getById(keyId);
  if (!existing) return null;
  if (existing.revokedAt) return { key: redact(existing), revoked: false };

  const saved = await cosmos.upsert(CONTAINER, { ...existing, revokedAt: at });
  return { key: redact(saved), revoked: true };
}

/**
 * Best effort. `patch`, never `upsert`: an upsert writes the auth-cache copy, which on another
 * instance is pre-revoke, so the key's next request would un-revoke it.
 */
async function touchLastUsed(keyId, at = new Date().toISOString()) {
  try {
    await cosmos.patch(CONTAINER, String(keyId), String(keyId), [
      { op: 'set', path: '/lastUsedAt', value: at }
    ]);
  } catch (_err) {
    // Intentionally swallowed — see the caller in helpers/auth.js.
  }
}

module.exports = {
  redact,
  getById,
  upsert,
  listRedacted,
  revoke,
  touchLastUsed
};
