'use strict';

/**
 * Rows of one kind holding a version a consumer has not sent, lapsed create claims included; a kind's
 * reconcile hook. `{ repair: true }` re-queues them. It keeps no report, so `store` is ignored.
 */

const { logger } = require('../utils/logger');

const TAG = '[sync-out pending]';

// Required on call, here and below: index.js requires kinds.js, which will register this hook per kind.
const kinds = () => require('./kinds');

/** The repository, consumers and enqueue of `kind`, as the sync-out worker uses them. */
function depsFor(kind) {
  const syncOut = require('./index');
  const { repo, consumers } = kinds().kindOf(kind);
  return { kind, repo, consumers: syncOut.consumers.filter(c => consumers.includes(c.name)), enqueue: syncOut.enqueue };
}

/** The app setting that turns a consumer on, e.g. SYNC_OUT_EAGLE_ENABLED. */
const enableSetting = (consumer) => `SYNC_OUT_${consumer.name.toUpperCase()}_ENABLED`;

/** True when `consumer` wants `row`, has not sent its version, and no live delivery holds a create claim on it. */
function owes(consumer, row) {
  const entry = (row.syncOut && row.syncOut[consumer.name]) || {};
  const sent = Number.isInteger(entry.sentVersion) && entry.sentVersion >= kinds().versionOf(row);
  return !sent && consumer.wants(row) && !(consumer.inFlight && consumer.inFlight(entry));
}

/**
 * List pending rows, re-queue each on `repair`; resolves to `{ kind, listed, queued, failed }` (row ids).
 * A kind registers it as `(options) => reconcile(options, depsFor(kind))`; tests pass stub deps.
 */
async function reconcile({ repair = false, log = logger } = {}, { kind, repo, consumers, enqueue }) {
  const rows = (await repo.listSyncPending()).filter(row => consumers.some(c => owes(c, row)));
  const report = { kind, listed: rows.map(row => String(row.id)), queued: 0, failed: [] };
  if (repair && !consumers.some(c => c.enabled())) {
    // enqueue skips disabled consumers, so a repair run would queue nothing and still look clean.
    report.failed = [...report.listed];
    log.warn(`${TAG} ${kind}: ${consumers.map(enableSetting).join(', ')} not true: --repair queued nothing`,
      { kind, listed: report.listed.length });
  } else if (repair) {
    for (const row of rows) {
      try {
        if ((await enqueue(row, { repair: true, kind })).length) report.queued++;
      } catch (err) {
        report.failed.push(String(row.id));
        log.warn(`${TAG} ${kind}: could not re-queue row ${row.id}`, { kind, id: row.id, error: err.message });
      }
    }
  }
  log.info(`${TAG} ${kind}: ${report.listed.length} pending, ${report.queued} queued`,
    { kind, listed: report.listed.length, queued: report.queued, repair });
  return report;
}

module.exports = { depsFor, reconcile };
