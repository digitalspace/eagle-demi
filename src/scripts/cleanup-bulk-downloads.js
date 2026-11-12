'use strict';

/**
 * Delete zip parts past retention. The job row stays until Cosmos TTL, so a poll answers `expired`.
 * ponytail: one deleter only; adopting an NRS lifecycle rule on `zips/` means deleting this script.
 */

const config = require('../config');
const storage = require('../storage');
const bulkDownloads = require('../repositories/bulk-downloads');
const { logger } = require('../utils/logger');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SECONDS_PER_DAY = 24 * 60 * 60;

// A failed job holds part keys too — the worker leaves what it built so the sweeper can free it.
// A cancelled one is swept because its worker may have died before it could delete its own parts.
const SWEPT_STATUSES = ['ready', 'failed', 'cancelled'];

// One page of rows per query. The loop below stops as soon as a page is short or expires nothing,
// so this only bounds how much a single sweep holds in memory.
const PAGE = 500;

/**
 * Seconds of the row's retention left. Cosmos counts `ttl` from the last write, so a patch without
 * it would hand the job another full `bulkJobTtlDays`.
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
  // `cancelled` says why the parts went, so only a ready or failed job becomes `expired`.
  const fields = job.status === 'cancelled' ? { parts: [] } : { status: 'expired', parts: [] };
  const ttl = remainingTtl(job, now);
  if (ttl !== null) fields.ttl = ttl;
  await bulkDownloads.patch(job.id, fields);

  // Only a row still 'running' (instance died, retries exhausted) was never released, and the
  // stamp is the claim: the worker writes the same one, so the counter moves once.
  if (job.status === 'running' && !job.slotReleasedAt &&
    typeof bulkDownloads.releaseSlot === 'function' && job.requesterKey &&
    await bulkDownloads.claimSlotRelease(job.id, new Date(now).toISOString())) {
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
          // A key the worker already deleted is not an error: both backends treat removing a
          // missing object as success, which is the usual case for a cancelled job.
          await storage.removeObject(part.key);
          objects += 1;
        }
        await markExpired(job, now);
        expired += 1;
      } catch (err) {
        failures += 1;
        logger.error(`[bulk] cleanup could not expire ${job.id}`, { error: err.message, stack: err.stack });
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
