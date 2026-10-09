'use strict';

/**
 * Edge ban history — Cosmos NoSQL, container `edgeBans`, partitioned by `/id`.
 *
 * One row per banned prefix (`203.0.113.7/32`, `2001:db8:1:2::/64`) holding its offences, how
 * many bans it has served and when the current one ends. Cosmos ids cannot hold `/`, so the id is
 * the prefix with `/` swapped for `_`; `address` keeps the real prefix. Every write resets the row
 * TTL to 7 days, which is also how long a past ban counts toward the next one's length.
 *
 * One more row, id `feed:crawlers`, caches the published crawler ranges so a failed fetch falls
 * back to the last good copy. No prefix id can collide with it.
 *
 * Not application data: written and read only by src/scripts/edge-ban.js, no ACL applies. Each
 * function takes the cosmos-nosql module the timer hands the detector, defaulting to this process's.
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

module.exports = { CONTAINER, TTL_SECONDS, idOf, listBans, putBan, getFeedCache, putFeedCache };
