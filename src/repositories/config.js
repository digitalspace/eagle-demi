'use strict';

/**
 * Runtime configuration for the frontend — Cosmos NoSQL.
 *
 * Container `config`, partitioned by `/id`, holding exactly two items. Every read is a point read
 * in a single partition.
 *
 *   'config'  what GET /api/config overlays on the app settings — the DEMI admin frontend's own
 *             runtime configuration.
 *   'public'  what GET /api/config/public serves to the PUBLIC site (eagle-public), pushed by
 *             eagle-api on every Config write (PUT /eagle/config/public) and bootstrapped by
 *             src/scripts/seed-public-config.js. A separate document
 *             rather than more keys on the first one: the two have different audiences, different
 *             key sets and different failure behaviour, and neither should be able to change the
 *             other by accident.
 *
 * NO read ACL applies here, and — as with `apikeys` — that is deliberate rather than an oversight,
 * though for the opposite reason: these documents are served to anonymous callers by
 * GET /api/config and GET /api/config/public, so there is nothing to withhold. Neither is wired
 * into the ACL-driven read paths, so this composes neither `visibilityFor()` nor `systemAccess()`;
 * there is no predicate here to bypass. Stated so nobody later "fixes" the missing visibility
 * clause.
 *
 * What protects this container is the controller's explicit key allowlists, not a permission
 * field. A key added to a document is not published until it is added to the matching list too.
 */

const cosmos = require('../db/cosmos-nosql');

const CONTAINER = 'config';
const ITEM_ID = 'config';
const PUBLIC_ITEM_ID = 'public';

/**
 * The single configuration document, or null when the container is empty.
 *
 * Returning null rather than throwing is what lets the controller fall back to its environment
 * variables — an unseeded container degrades to the previous behaviour instead of taking the
 * frontend down.
 */
async function get() {
  return cosmos.readItem(CONTAINER, ITEM_ID, ITEM_ID);
}

async function upsert(record) {
  return cosmos.upsert(CONTAINER, Object.assign({}, record, { id: ITEM_ID }));
}

/**
 * The public site's configuration document, or null when it has not been seeded.
 *
 * Unlike `get()`, null here is NOT a degrade signal: the controller answers 503 rather than
 * inventing defaults, because a defaulted public payload would open the access curtain. See
 * `getPublicConfig` in controllers/config.js.
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
