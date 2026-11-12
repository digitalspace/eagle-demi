'use strict';

/**
 * Cross-instance cache in the `config` container, for upstream figures rate-limited per tenant: Flex
 * runs up to 20 instances, reset on each deploy. Nothing queries that container, so extra ids are safe.
 */

const cosmos = require('../db/cosmos-nosql');
const { CONTAINER } = require('./config');

/**
 * The scheduled Eagle reconcile's last report, stored as `{ body: report }` and served by
 * GET /admin/reconcile. One row, replaced on every run.
 */
const RECONCILE_REPORT_ID = 'reconcile-report';
/** The same for the ENGAGE reconcile, served by GET /admin/reconcile-engage. */
const RECONCILE_ENGAGE_REPORT_ID = 'reconcile-engage-report';

/** The stored document, or null when nothing is cached (or Cosmos is unavailable). */
async function get(id) {
  return cosmos.readItem(CONTAINER, id, id);
}

async function put(id, doc) {
  return cosmos.upsert(CONTAINER, { ...doc, id, type: 'cache', storedAt: new Date().toISOString() });
}

module.exports = { get, put, RECONCILE_REPORT_ID, RECONCILE_ENGAGE_REPORT_ID };
