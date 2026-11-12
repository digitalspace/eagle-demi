'use strict';

/**
 * Container `config`: 'config' overlays GET /api/config, 'public' backs GET /api/config/public. Both
 * serve anonymous callers, so no read ACL; the controller's key allowlists decide what is published.
 */

const cosmos = require('../db/cosmos-nosql');

const CONTAINER = 'config';
const ITEM_ID = 'config';
const PUBLIC_ITEM_ID = 'public';

/**
 * Null, not a throw, when the container is empty: the controller then falls back to its
 * environment variables.
 */
async function get() {
  return cosmos.readItem(CONTAINER, ITEM_ID, ITEM_ID);
}

async function upsert(record) {
  return cosmos.upsert(CONTAINER, Object.assign({}, record, { id: ITEM_ID }));
}

/**
 * Null when unseeded, and unlike `get()` not a degrade: the controller answers 503, since a
 * defaulted public payload would open the access curtain.
 */
async function getPublic() {
  return cosmos.readItem(CONTAINER, PUBLIC_ITEM_ID, PUBLIC_ITEM_ID);
}

async function upsertPublic(record) {
  return cosmos.upsert(CONTAINER, Object.assign({}, record, { id: PUBLIC_ITEM_ID }));
}

module.exports = {
  CONTAINER,
  ITEM_ID,
  PUBLIC_ITEM_ID,
  get,
  upsert,
  getPublic,
  upsertPublic
};
