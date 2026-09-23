'use strict';

/**
 * Give every `updates` row a `publishDate`: its `dateAdded`, where it has none.
 *
 *   node src/scripts/backfill-update-publish-date.js [--live]
 *
 * WHY. The publish gate and every sort on `publishDate` read that field alone, so its index serves
 * them. mirrorItem fills it from `dateAdded` on every push; this fills the rows written before it
 * did. Until a dry run reports `undated=0`, keep `updatesPublishDateFallback` on (main.bicep): an
 * ORDER BY leaves out every row without its field.
 *
 * **DRY RUN BY DEFAULT.** `--live` patches. Cosmos is private-endpoint-only and keyless, so a live
 * run executes on the devbox (`demi-devbox-<env>`) via `demi-run` — see README "Running anything
 * against the database".
 *
 * Each patch is conditional on the row still having no `publishDate`, so a push that fills it
 * first wins. Patched rows leave the query as it pages, so a live run can step over some: run it
 * again until a dry run reports `undated=0`.
 */

const updates = require('../repositories/updates');
const { logger } = require('../utils/logger');

const PAGE = 100;

function parseArgs(argv) {
  const args = { live: false };
  for (const a of argv) {
    if (a === '--live') args.live = true;
    else throw new Error(`[publish-date-backfill] unknown argument: ${a}`);
  }
  return args;
}

/** The one line an operator reads. `noDate` rows have no `dateAdded` either: look at those by hand. */
function summaryLine(s) {
  return `[publish-date-backfill] mode=${s.mode} undated=${s.undated} patched=${s.patched} ` +
    `raced=${s.raced} noDate=${s.noDate} failed=${s.failed}`;
}

/**
 * @param {string[]} argv
 * @param {object} [deps] test seam: {updates}
 */
async function backfillUpdatePublishDate(argv = [], deps = {}) {
  const args = parseArgs(argv);
  const repo = deps.updates || updates;
  const summary = { mode: args.live ? 'live' : 'dry-run', undated: 0, patched: 0, raced: 0, noDate: 0, failed: 0 };

  let continuationToken;
  do {
    const page = await repo.listUndated({ pageSize: PAGE, continuationToken });
    continuationToken = page.continuationToken;
    for (const row of page.items) {
      summary.undated++;
      if (typeof row.dateAdded !== 'string' || !row.dateAdded) {
        summary.noDate++;
        continue;
      }
      if (!args.live) continue;
      try {
        if (await repo.fillPublishDate(row.id, row.dateAdded)) summary.patched++;
        else summary.raced++;
      } catch (err) {
        summary.failed++;
        logger.error(`[publish-date-backfill] FAILED ${row.id}: ${err.message}`);
      }
    }
  } while (continuationToken);

  logger.info(summaryLine(summary));
  return summary;
}

/** 1 on a failed patch only. */
function exitCodeFor(summary) {
  return summary.failed > 0 ? 1 : 0;
}

module.exports = { backfillUpdatePublishDate, summaryLine, exitCodeFor, parseArgs };

if (require.main === module) {
  backfillUpdatePublishDate(process.argv.slice(2))
    .then(summary => process.exit(exitCodeFor(summary)))
    .catch((err) => {
      logger.error(`[publish-date-backfill] ${err.stack || err.message}`);
      process.exit(1);
    });
}
