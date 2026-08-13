'use strict';

/**
 * Runtime configuration for the frontend — Cosmos NoSQL.
 *
 * Container `config`, partitioned by `/id`, holding exactly one item with id 'config'. Every read
 * is a point read in a single partition.
 *
 * NO read ACL applies here, and — as with `apikeys` — that is deliberate rather than an oversight,
 * though for the opposite reason: this document is served verbatim to anonymous callers by
 * GET /api/config, so there is nothing to withhold. It is never wired into the ACL-driven read
 * paths, so it composes neither `visibilityFor()` nor `systemAccess()`; there is no predicate here
 * to bypass. Stated so nobody later "fixes" the missing visibility clause.
 *
 * What protects this container is the controller's explicit key allowlist, not a permission field.
 * A key added to the document is not published until it is added there too.
 */

const cosmos = require('../db/cosmos-nosql');

const CONTAINER = 'config';
const ITEM_ID = 'config';

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

module.exports = {
  CONTAINER,
  ITEM_ID,
  get,
  upsert
};
