'use strict';

/**
 * Container `edgeBans`, one row per banned prefix; Cosmos ids cannot hold `/`, so the id swaps it for `_`.
 * Each write resets the 7-day TTL, also how long a past ban counts. Only src/scripts/edge-ban.js reads it.
 */

const cosmos = require('../db/cosmos-nosql');

const CONTAINER = 'edgeBans';
const TTL_SECONDS = 7 * 24 * 60 * 60;
const FEED_ID = 'feed:crawlers';

const idOf = address => String(address).replace('/', '_');

/** Every ban row still inside its TTL, expired bans included: the detector needs both. */
async function listBans(db = cosmos) {
  const { items } = await db.query(CONTAINER, {
    query: 'SELECT * FROM c WHERE IS_DEFINED(c.address)',
    parameters: []
  });
  return items;
}

/** Whole-row write with the TTL reset. */
async function putBan(row, db = cosmos) {
  const id = idOf(row.address);
  return db.upsert(CONTAINER, { ...row, id, ttl: TTL_SECONDS });
}

/** The cached crawler ranges, or null. */
async function getFeedCache(db = cosmos) {
  return db.readItem(CONTAINER, FEED_ID, FEED_ID);
}

async function putFeedCache({ fetchedAt, ranges }, db = cosmos) {
  return db.upsert(CONTAINER, { id: FEED_ID, fetchedAt, ranges, ttl: TTL_SECONDS });
}

module.exports = { TTL_SECONDS, listBans, putBan, getFeedCache, putFeedCache };
