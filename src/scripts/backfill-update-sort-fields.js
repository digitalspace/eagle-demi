'use strict';

/**
 * Give every `updates` row the sort and filter fields mirrorItem now always writes: `pinned`,
 * `complianceAndEnforcement` and `status`.
 *
 *   node src/scripts/backfill-update-sort-fields.js [--live]
 *
 * WHY. A Cosmos ORDER BY drops a row that lacks the sort field, so rows written before mirrorItem
 * filled these leave a `pinned` or `status` sort. `pinned` and `complianceAndEnforcement` come from
 * the Eagle record kept in `sources.eagle`, else false; `status` is null (`updates.sortFieldFills`).
 *
 * **DRY RUN BY DEFAULT.** `--live` patches. Cosmos is private-endpoint-only and keyless, so a live
 * run executes on the devbox (`demi-devbox-<env>`) via `demi-run`; see README "Running anything
 * against the database".
 *
 * Each patch holds only while the row still lacks every field it sets, so a push that lands first
 * wins. Patched rows leave the query as it pages, so a live run can step over some: run it again
 * until a dry run reports `changed=0`.
 */

const updates = require('../repositories/updates');
const { logger } = require('../utils/logger');

const PAGE = 100;

function parseArgs(argv) {
  const args = { live: false };
  for (const a of argv) {
    if (a === '--live') args.live = true;
    else throw new Error(`[update-sort-fields] unknown argument: ${a}`);
  }
  return args;
}

function summaryLine(s) {
  const fields = Object.entries(s.fields).map(([field, n]) => `${field}=${n}`).join(' ') || 'none';
  return `[update-sort-fields] mode=${s.mode} changed=${s.changed} patched=${s.patched} ` +
    `raced=${s.raced} failed=${s.failed} missing: ${fields}`;
}

/**
 * @param {string[]} argv
 * @param {object} [deps] test seam: {updates}
 */
async function backfillUpdateSortFields(argv = [], deps = {}) {
  const args = parseArgs(argv);
  const repo = deps.updates || updates;
  const summary = { mode: args.live ? 'live' : 'dry-run', changed: 0, patched: 0, raced: 0, failed: 0, fields: {} };

  let continuationToken;
  do {
    const page = await repo.listMissingSortFields({ pageSize: PAGE, continuationToken });
    continuationToken = page.continuationToken;
    for (const row of page.items) {
      const fills = updates.sortFieldFills(row);
      if (!Object.keys(fills).length) continue;
      summary.changed++;
      for (const field of Object.keys(fills)) summary.fields[field] = (summary.fields[field] || 0) + 1;
      if (!args.live) continue;
      try {
        if (await repo.fillSortFields(row.id, fills)) summary.patched++;
        else summary.raced++;
      } catch (err) {
        summary.failed++;
        logger.error(`[update-sort-fields] FAILED ${row.id}: ${err.message}`);
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

module.exports = { backfillUpdateSortFields, summaryLine, exitCodeFor, parseArgs };

if (require.main === module) {
  backfillUpdateSortFields(process.argv.slice(2))
    .then(summary => process.exit(exitCodeFor(summary)))
    .catch((err) => {
      logger.error(`[update-sort-fields] ${err.stack || err.message}`);
      process.exit(1);
    });
}
