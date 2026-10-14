'use strict';

/**
 * `intakeScanSweep`, two passes per tick. The result pass reads Defender's scan result from each
 * pending upload's blob index tags, oldest first, and releases or rejects it; a link never used is
 * rejected `no-upload` once the link has expired. The timeout pass then rejects rows still pending
 * after INTAKE_PENDING_TIMEOUT_HOURS (`timeout`, or `no-upload`). Each tick also logs the month's
 * scanned bytes against Defender's monthly cap, for the cap alerts.
 */

const config = require('../config');
const { logger } = require('../utils/logger');
const { moveToQuarantine } = require('./blobs');
const { applyScanResult } = require('./handler');
const { UPLOAD_LINK_SECONDS } = require('./decision');

const HOUR_MS = 60 * 60 * 1000;
const GIB = 1073741824;
const PAGE_SIZE = 100;
const MAX_ROWS = 500;
// host.json functionTimeout is 30 minutes; the timeout pass and month line need the rest.
const RESULT_BUDGET_MS = 20 * 60 * 1000;
const UPLOAD_GRACE_MS = (UPLOAD_LINK_SECONDS + 5 * 60) * 1000;
const RESULT_TAG = 'malware scanning scan result';
const TIME_TAG = 'malware scanning scan time';

let resultKeyLogged = false;

/** Log the current UTC calendar month's scanned bytes. Plain text: the alerts parse the message only. */
async function logMonthToDate(store, now) {
  const at = new Date(now);
  // Date-only bounds: Defender writes 7 fraction digits, which sort below a `.000Z` bound.
  const monthStart = (offset) =>
    new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + offset, 1)).toISOString().slice(0, 10);
  const from = monthStart(0);
  const to = monthStart(1);
  const scannedBytes = await store.scannedBytesBetween(from, to);
  const capBytes = config.intake.capGBPerMonth * GIB;
  logger.info(`[intake] month-to-date scannedBytes=${scannedBytes} capBytes=${capBytes}`);
}

function defaultDeps() {
  return {
    store: require('./store'), blobs: require('./blobs'), nrs: require('../storage'),
    projects: require('../repositories/projects')
  };
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

/** The tag named `name`, matched case-insensitively, as `{ key, value }`, or null. */
function findTag(tags, name) {
  const key = Object.keys(tags).find(k => k.toLowerCase() === name);
  return key === undefined ? null : { key, value: tags[key] };
}

/** Read one pending row's scan result and apply it. Anything that throws leaves the row pending. */
async function pollRow(row, deps, summary, now) {
  try {
    // The quarantine identity: the app identity cannot even stat a blob not yet tagged clean.
    const client = deps.blobs.quarantine();
    const stat = await client.statObject(row.id);
    if (!stat) {
      // An unparsable createdAt waits for the timeout pass rather than rejecting early.
      const linkExpired = now - Date.parse(row.createdAt) >= UPLOAD_GRACE_MS;
      if (linkExpired) await sweepRow(row, deps, summary);
      else summary.notUploaded += 1;
      return;
    }
    const tags = await client.getTags(row.id);
    const result = tags && findTag(tags, RESULT_TAG);
    if (!result) {
      summary.awaiting += 1;
      return;
    }
    if (!resultKeyLogged) {
      resultKeyLogged = true;
      logger.info('[intake] scan result tag key', { key: result.key });
    }

    const time = findTag(tags, TIME_TAG);
    const scannedAt = Date.parse(time ? time.value : '');
    const blobAt = stat.lastModified ? new Date(stat.lastModified).getTime() : NaN;
    // A clean tag older than the bytes is for an overwritten upload; the new bytes get their own scan.
    if (!(scannedAt >= blobAt)) {
      summary.awaiting += 1;
      logger.warn(Number.isNaN(scannedAt) ? '[intake] scan time unreadable' : '[intake] scan older than blob', {
        documentId: row.id, scanTime: time ? time.value : null, lastModified: stat.lastModified || null
      });
      return;
    }

    const outcome = await applyScanResult(row, {
      result: result.value, scannedAt: new Date(now).toISOString(), eTag: stat.etag, malwareNames: []
    }, deps);
    summary[outcome] += 1;
  } catch (err) {
    summary.failed += 1;
    logger.error('[intake] could not apply a scan result', {
      documentId: row.id, error: err.message, stack: err.stack
    });
  }
}

/**
 * Poll pending rows oldest first, up to MAX_ROWS or RESULT_BUDGET_MS, whichever comes first; the
 * rest wait for the next tick. Never throws, so the timeout pass always runs.
 */
async function resultPass(deps, now, clock) {
  const started = clock();
  const summary = {
    polled: 0, clean: 0, rejected: 0, raced: 0, missing: 0, stale: 0,
    notUploaded: 0, noUpload: 0, timedOut: 0, awaiting: 0, failed: 0
  };
  const limit = () => {
    if (summary.polled >= MAX_ROWS) return 'row cap';
    return clock() - started >= RESULT_BUDGET_MS ? 'time budget' : null;
  };
  try {
    let token;
    let last = null;
    let stop = null;
    do {
      const page = await deps.store.listPending({ pageSize: PAGE_SIZE, continuationToken: token });
      token = page.continuationToken;
      for (const row of page.items) {
        stop = limit();
        if (stop) break;
        summary.polled += 1;
        last = row;
        await pollRow(row, deps, summary, now);
      }
      if (!stop && token) stop = limit();
    } while (!stop && token);

    if (stop) {
      // '' sorts below every timestamp, so nothing polled counts every pending row.
      const rowsLeft = await deps.store.countPendingAfter(last ? last.createdAt : '');
      logger.warn('[intake] result pass stopped early', { reason: stop, polled: summary.polled, rowsLeft });
    }
  } catch (err) {
    logger.error('[intake] result pass failed', { error: err.message, stack: err.stack });
  }
  logger.info('intake results', summary);
  return summary;
}

/**
 * @param {number} [now] the tick time; scan results are stamped with it
 * @param {() => number} [clock] reads elapsed time for the result pass budget
 * @returns {Promise<object|null>} the summary, or null when intake is not configured
 */
async function sweep(deps, now = Date.now(), clock = Date.now) {
  if (!config.intake.storageAccount) {
    logger.info('[intake] INTAKE_STORAGE_ACCOUNT is unset, sweep skipped');
    return null;
  }
  const resolved = deps || defaultDeps();
  const results = await resultPass(resolved, now, clock);
  const cutoff = new Date(now - config.intake.pendingTimeoutHours * HOUR_MS).toISOString();
  const rows = await resolved.store.listStalePending(cutoff);
  const summary = { stale: rows.length, timedOut: 0, noUpload: 0, failed: 0 };
  for (const row of rows) await sweepRow(row, resolved, summary);
  logger.info('intake sweep', { cutoff, ...summary });
  await logMonthToDate(resolved.store, now);
  return { results, ...summary };
}

module.exports = { sweep };
