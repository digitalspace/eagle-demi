'use strict';

/**
 * Registry API keys — Cosmos NoSQL.
 *
 * Container `apikeys`, partitioned by `/id` where the id IS the public keyId. That makes every
 * verification a point read in a single partition, on the hot path of every API-key request. It
 * also means the container never needs a cross-partition query for auth — only the admin listing
 * does, and that is rare and small.
 *
 * NO read ACL applies here, and unlike `boundaries` that is not because the data is public — it is
 * because this container is never exposed through the ACL-driven read paths at all. It is reachable
 * only from `helpers/auth.js` (by id, internally) and the admin routes (which authMiddleware has
 * already gated). Deliberately stated so nobody later "fixes" the missing visibility predicate by
 * wiring this into a public read.
 *
 * `hash` never leaves this module in a caller-facing shape — see `redact`.
 */

const cosmos = require('../db/cosmos-nosql');

const CONTAINER = 'apikeys';
const PARTITION_FIELD = 'id';

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
 * Every key, secret digests removed. Cross-partition by necessity; the container holds one item
 * per consumer, so this stays tiny. Revoked keys are included on purpose — an operator needs to
 * see that a key existed and was revoked, not have it silently vanish.
 */
async function listRedacted() {
  const { items } = await cosmos.query(CONTAINER, {
    query: 'SELECT * FROM c ORDER BY c.createdAt DESC',
    parameters: []
  });
  return (items || []).map(redact);
}

/**
 * Revoke by stamping `revokedAt`, never by deleting.
 *
 * The row is the only record that the key existed; deleting it would erase the audit trail and
 * make a leaked-key investigation impossible. `helpers/api-key.js:verify` treats any `revokedAt`
 * as fatal.
 */
async function revoke(keyId, at = new Date().toISOString()) {
  const existing = await getById(keyId);
  if (!existing) return null;
  if (existing.revokedAt) return redact(existing);

  const saved = await cosmos.upsert(CONTAINER, { ...existing, revokedAt: at });
  return redact(saved);
}

/** Best-effort usage stamp. Never let a bookkeeping failure break an authenticated request. */
async function touchLastUsed(record, at = new Date().toISOString()) {
  try {
    await cosmos.upsert(CONTAINER, { ...record, lastUsedAt: at });
  } catch (_err) {
    // Intentionally swallowed — see the caller in helpers/auth.js.
  }
}

module.exports = {
  CONTAINER,
  PARTITION_FIELD,
  redact,
  getById,
  upsert,
  listRedacted,
  revoke,
  touchLastUsed
};
