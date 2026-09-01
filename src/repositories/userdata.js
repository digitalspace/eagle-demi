'use strict';

/**
 * Per-user data, Cosmos NoSQL. Partitioned by `/userId` (the owner's IDIR username), id is
 * `<type>:<key>` — so every read and write is single-partition and a new stored type is a new id
 * prefix rather than a new container.
 */

const cosmos = require('../db/cosmos-nosql');

const CONTAINER = 'userdata';

/** Point read within one owner's partition. Returns null on 404. */
async function getItem(userId, id) {
  return cosmos.readItem(CONTAINER, String(id), String(userId));
}

/** One owner's rows of every type — the single read behind GET /me/data. */
async function listAll(userId) {
  const { items } = await cosmos.query(CONTAINER, {
    query: 'SELECT * FROM c WHERE c.userId = @me',
    parameters: [{ name: '@me', value: String(userId) }]
  }, { partitionKey: String(userId) });
  return items || [];
}

async function countByType(userId, type) {
  const count = await cosmos.queryValue(CONTAINER, {
    query: 'SELECT VALUE COUNT(1) FROM c WHERE c.userId = @me AND c.type = @type',
    parameters: [
      { name: '@me', value: String(userId) },
      { name: '@type', value: String(type) }
    ]
  }, { partitionKey: String(userId) });
  return count || 0;
}

/**
 * Upsert. `userId` is stamped here from the caller's argument, so a record body can never carry
 * its own owner. Null (no container configured) is thrown so an unsaved row never looks stored —
 * same fail-soft as `links.create`.
 */
async function put(userId, record) {
  const saved = await cosmos.upsert(CONTAINER, { ...record, userId: String(userId) });
  if (!saved) throw new Error('userdata container not configured');
  return saved;
}

/** `cosmos.remove` already returns false on 404; passed through as-is. */
async function remove(userId, id) {
  return cosmos.remove(CONTAINER, String(id), String(userId));
}

module.exports = {
  CONTAINER,
  getItem,
  listAll,
  countByType,
  put,
  remove
};
