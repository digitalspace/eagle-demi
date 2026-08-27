'use strict';

/**
 * Short links, Cosmos NoSQL. Partitioned by `/id` (id IS the code): the redirect is a single-
 * partition point read, and a code clash on create is a 409 from Cosmos, not a read-then-write race.
 */

const cosmos = require('../db/cosmos-nosql');

const CONTAINER = 'links';

/** Point read by code. Returns null on 404. */
async function getById(code) {
  return cosmos.readItem(CONTAINER, String(code), String(code));
}

/**
 * Null (no container configured) is thrown as an error so it never looks like a stored link.
 * A 409 (code already taken) propagates uncaught; the controller decides retry vs. surface.
 */
async function create(record) {
  const saved = await cosmos.create(CONTAINER, record);
  if (!saved) throw new Error('links container not configured');
  return saved;
}

/**
 * `patch`, not `upsert` (see `repositories/api-keys.js:76-82`). patch has no 404 catch, so one is
 * added here: a missing code returns null so the controller 404s rather than 500s.
 */
async function repoint(code, url) {
  try {
    return await cosmos.patch(CONTAINER, String(code), String(code), [
      { op: 'set', path: '/url', value: url },
      { op: 'set', path: '/updatedAt', value: new Date().toISOString() }
    ]);
  } catch (err) {
    if (err.code === 404) return null;
    throw err;
  }
}

/** `cosmos.remove` already returns false on 404; passed through as-is. */
async function remove(code) {
  return cosmos.remove(CONTAINER, String(code), String(code));
}

/** Every link, newest first. Cross-partition; the container holds one row per link, not per click. */
async function list() {
  const { items } = await cosmos.query(CONTAINER, {
    query: 'SELECT * FROM c ORDER BY c.createdAt DESC',
    parameters: []
  });
  return items || [];
}

module.exports = {
  CONTAINER,
  getById,
  create,
  repoint,
  remove,
  list
};
