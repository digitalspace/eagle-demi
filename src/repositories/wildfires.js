'use strict';

/**
 * Container `wildfires`, id = DataBC fire number, 7-day TTL: the sync re-upserts every fire in the feed,
 * so a dropped fire expires. Public data with no `read[]` and no read endpoint; only the sync writes here.
 */

const cosmos = require('../db/cosmos-nosql');

const CONTAINER = 'wildfires';

async function upsert(wildfire) {
  return cosmos.upsert(CONTAINER, wildfire);
}

module.exports = {
  upsert
};
