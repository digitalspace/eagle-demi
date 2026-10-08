'use strict';

/**
 * Cross-instance cache, on the `config` container (partitioned by `/id`, so every read is a point
 * read in its own partition).
 *
 * It shares that container rather than owning one because the config controller point-reads a
 * fixed id and nothing queries the container, so a second document is invisible to it. What this
 * is for: a figure whose upstream rate-limits per tenant, which an in-memory cache cannot hold —
 * Flex Consumption runs up to 20 instances and resets them on every deploy, so each probe was a
 * fresh call to the same tenant quota.
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
