'use strict';

/**
 * `intakeScanSweep`: rejects intake rows still pending after INTAKE_PENDING_TIMEOUT_HOURS. A file
 * that arrived but never got a result is moved to quarantine (`timeout`); a link never used is
 * `no-upload`. The timeout outlasts scan plus event delivery, so a later scan event is ignored.
 */

const config = require('../config');
const { logger } = require('../utils/logger');
const { moveToQuarantine } = require('./blobs');

const HOUR_MS = 60 * 60 * 1000;

function defaultDeps() {
  return { store: require('./store'), blobs: require('./blobs') };
}

/** One settled row; a failure is counted and logged so the rest of the batch still runs. */
async function sweepRow(row, { store, blobs }, summary) {
  try {
    const stat = await moveToQuarantine(blobs.quarantine(), row.id);
    const reason = stat ? 'timeout' : 'no-upload';
    const settled = await store.settle(row, {
      scanStatus: 'rejected', scanRejectReason: reason, read: [], isPublished: false
    });
    if (!settled) return;
    summary[reason === 'timeout' ? 'timedOut' : 'noUpload'] += 1;
    if (stat) logger.warn('intake quarantined', { documentId: row.id, result: null, reason, moved: true });
  } catch (err) {
    summary.failed += 1;
    logger.error('[intake] sweep could not reject a pending upload', {
      documentId: row.id, error: err.message, stack: err.stack
    });
  }
}

/** @returns {Promise<object|null>} the summary, or null when intake is not configured */
async function sweep(deps, now = Date.now()) {
  if (!config.intake.storageAccount) {
    logger.info('[intake] INTAKE_STORAGE_ACCOUNT is unset, sweep skipped');
    return null;
  }
  const resolved = deps || defaultDeps();
  const cutoff = new Date(now - config.intake.pendingTimeoutHours * HOUR_MS).toISOString();
  const rows = await resolved.store.listStalePending(cutoff);
  const summary = { stale: rows.length, timedOut: 0, noUpload: 0, failed: 0 };
  for (const row of rows) await sweepRow(row, resolved, summary);
  logger.info('intake sweep', { cutoff, ...summary });
  return summary;
}

module.exports = { sweep };
