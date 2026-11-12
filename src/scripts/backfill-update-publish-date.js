'use strict';

/**
 * Give each `updates` row without `publishDate` its `dateAdded`. Dry run unless `--live`; a live run
 * can step over rows as they leave the query, so repeat until a dry run reports `undated=0`.
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
