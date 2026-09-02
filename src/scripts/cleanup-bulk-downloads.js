'use strict';

/**
 * Delete the zip parts of bulk downloads past their retention window.
 *
 *   node src/scripts/cleanup-bulk-downloads.js
 *
 * In Azure it is the `cleanupBulkDownloads` Functions timer in this app (api/index.js, scheduled by
 * BULK_CLEANUP_SCHEDULE). The JOB ROW survives: `bulkJobTtlDays` is longer than
 * `bulkZipRetentionDays`, so Cosmos TTL removes it later and until then a poll answers `expired`
 * rather than a 404 that reads as "never existed".
 *
 * ponytail: if an NRS lifecycle rule on `zips/` is adopted, delete this timer and this script —
 * one deleter only, or the two race each other over the same keys.
 */

const config = require('../config');
const storage = require('../storage');
const bulkDownloads = require('../repositories/bulk-downloads');
const { logger } = require('../utils/logger');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SECONDS_PER_DAY = 24 * 60 * 60;

// A failed job holds part keys too — the worker leaves what it built so the sweeper can free it.
const SWEPT_STATUSES = ['ready', 'failed'];

// One page of rows per query. The loop below stops as soon as a page is short or expires nothing,
// so this only bounds how much a single sweep holds in memory.
const PAGE = 500;

/**
 * How much of the row's own retention is left, in seconds.
 *
 * Cosmos measures `ttl` from the LAST WRITE, so patching a row without resetting it hands the job
 * another full `bulkJobTtlDays` — the sweep would keep the row alive instead of letting it go.
 */
function remainingTtl(job, now) {
  const from = Date.parse(job.finishedAt || job.createdAt || '');
  if (!Number.isFinite(from)) return null;
  const left = config.bulkJobTtlDays * SECONDS_PER_DAY - Math.floor((now - from) / 1000);
  // Never 0: Cosmos reads that as "no expiry", which is the opposite of what a stale row wants.
  return Math.max(60, left);
}

/** Mark a job whose parts are already gone. Split out only because `run` counts the deletes. */
async function markExpired(job, now) {
  const fields = { status: 'expired', parts: [] };
  const ttl = remainingTtl(job, now);
  if (ttl !== null) fields.ttl = ttl;
  await bulkDownloads.patch(job.id, fields);

  // The worker releases the slot when it finishes and stamps `slotReleasedAt` when it does; only a
  // row still 'running' with no stamp (instance died, retries exhausted) was never released.
  if (job.status === 'running' && !job.slotReleasedAt &&
    typeof bulkDownloads.releaseSlot === 'function' && job.requesterKey) {
    await bulkDownloads.releaseSlot(job.requesterKey);
  }
}

async function run() {
  const now = Date.now();
  const cutoff = new Date(now - config.bulkZipRetentionDays * MS_PER_DAY).toISOString();

  let jobs = 0;
  let objects = 0;
  let failures = 0;

  for (;;) {
    const batch = await bulkDownloads.listExpired(cutoff, { statuses: SWEPT_STATUSES, limit: PAGE });
    if (!batch || batch.length === 0) break;

    let expired = 0;
    for (const job of batch) {
      // Per job, so one undeletable object does not park every later job behind it forever.
      try {
        for (const part of job.parts || []) {
          await storage.removeObject(part.key);
          objects += 1;
        }
        await markExpired(job, now);
        expired += 1;
      } catch (err) {
        failures += 1;
        logger.error(`[bulk] cleanup could not expire ${job.id}`, { error: err.message });
      }
    }
    jobs += batch.length;

    // A row that failed comes back on the next page unchanged, so a page that expired nothing is
    // the object store being down — not a reason to re-read the same rows until the timer dies.
    if (expired === 0 || batch.length < PAGE) break;
  }

  logger.info(
    `[bulk] cleanup removed ${objects} zip part(s) from ${jobs} job(s), ${failures} failed`
  );
  return { jobs, objects, failures };
}

module.exports = { run };

if (require.main === module) {
  const { initCosmosClient } = require('../db/cosmos-nosql');
  initCosmosClient();

  run().catch(err => {
    logger.error(`[bulk] cleanup ${err.stack || err.message}`);
    process.exit(1);
  });
}
