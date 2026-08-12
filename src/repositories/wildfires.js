'use strict';

/**
 * Active wildfires — Cosmos NoSQL.
 *
 * Container `wildfires`, partitioned by `/id` (the DataBC fire number) with a 7-day TTL. The
 * sync re-upserts every fire still in the feed, refreshing `_ts`, so anything that drops out of
 * the feed expires itself — there is no stale-fire purge to run.
 *
 * Reference data with no `read[]`, like `boundaries`: no visibility predicate applies, and its
 * absence here is deliberate rather than forgotten. Fire locations are public.
 *
 * There is no read endpoint. The frontend draws its fire layer straight from the DataBC WFS,
 * and what DEMI actually serves is the bounded `sources.wildfire` aggregate the sync patches
 * onto each project. This repository exists for the sync's own writes.
 */

const cosmos = require('../db/cosmos-nosql');

const CONTAINER = 'wildfires';
const PARTITION_FIELD = 'id';

async function upsert(wildfire) {
  return cosmos.upsert(CONTAINER, wildfire);
}

module.exports = {
  CONTAINER,
  PARTITION_FIELD,
  upsert
};
