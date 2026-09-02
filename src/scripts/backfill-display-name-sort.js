'use strict';

/**
 * Stamp `displayNameSort` onto the documents already in Cosmos.
 *
 * WHY. AI Search orders strings by codepoint, so `sortBy=displayName` puts "Item 10" before
 * "Item 2". The four write sites now derive the padded key (src/helpers/natural-sort.js), but the
 * ~61,600 rows seeded before that carry none, and a null sort field orders every one of them ahead
 * of the named rows. A re-seed is not the fix: `transformDocument` resets `contentExtracted`, which
 * sends the whole corpus back through the GPU. Same argument as backfill-document-list-ids.js.
 *
 *   node src/scripts/backfill-display-name-sort.js [--live]
 *
 * **DRY RUN BY DEFAULT**, matching the sibling scripts; `--dry-run` says so explicitly. Cosmos is
 * private-endpoint-only and keyless, so a live run executes on the devbox (`demi-devbox-<env>`) via
 * `demi-run` — see README "Running anything against the database".
 *
 * ORDER. index PUT -> datasource PUT -> app deploy -> this backfill -> indexer cycle
 * (azure/search/README.md). Patching moves `_ts`, so the PT5M indexer re-pulls the patched rows on
 * its own — no indexer reset. Rows this script leaves alone are rows that already agree, so they
 * need no re-pull.
 *
 * Sealed (level-0) rows are not scanned: systemAccess() carries the sealed exclusion the same as
 * every other ladder read. That's fine — a sealed row never appears in a sortable result either.
 */

const documents = require('../repositories/documents');
const projects = require('../repositories/projects');
const cosmos = require('../db/cosmos-nosql');
const { systemAccess } = require('../helpers/access-sql');
const { naturalSortKey } = require('../helpers/natural-sort');
const { logger } = require('../utils/logger');

function parseArgs(argv) {
  const args = { live: false };
  for (const a of argv) {
    if (a === '--live') args.live = true;
    else if (a === '--dry-run') args.live = false;
    else throw new Error(`[sort-key-backfill] unknown argument: ${a}`);
  }
  return args;
}

/**
 * The patch one row needs, or null when it already agrees.
 *
 * `?? null`, so an untitled row is stamped with `''` ONCE rather than left without the property —
 * which is what the write sites store for it, and what makes a second run plan nothing at all.
 */
function planPatch(doc, now) {
  const key = naturalSortKey(doc.displayName);
  if ((doc.displayNameSort ?? null) === key) return null;
  return [
    { op: 'set', path: '/displayNameSort', value: key },
    { op: 'set', path: '/updatedAt', value: now }
  ];
}

function summaryLine(s) {
  return `[sort-key-backfill] mode=${s.mode} scanned=${s.scanned} of ${s.expected} ` +
    `current=${s.current} planned=${s.planned} patched=${s.patched} failed=${s.failed} ` +
    `${s.requestCharge.toFixed(0)} RU`;
}

/**
 * @param {string[]} argv
 * @param {object} [deps] test seam: {documents, projects, bulkVerified, now}
 */
async function backfillDisplayNameSort(argv = [], deps = {}) {
  const args = parseArgs(argv);
  const documentsRepo = deps.documents || documents;
  const projectsRepo = deps.projects || projects;
  // documentsRepo, not the module: a caller who injects a read seam and not a write seam would
  // otherwise read the double and write the real container.
  const write = deps.bulkVerified ||
    ((operations) => cosmos.bulkVerified(documentsRepo.CONTAINER, operations));
  const now = deps.now || new Date().toISOString();

  // systemAccess(), because a scoped context lists only the rows it can SEE and would leave the
  // rest unsorted — a partial backfill that reports success is worse than none, since nobody
  // re-runs it.
  const access = systemAccess();

  const summary = {
    mode: args.live ? 'live' : 'dry-run',
    scanned: 0, current: 0, planned: 0, patched: 0, failed: 0,
    statusCounts: {}, requestCharge: 0
  };

  const flush = async (operations) => {
    if (operations.length === 0) return;
    const result = await write(operations);
    summary.patched += result.succeeded || 0;
    summary.failed += result.failed || 0;
    summary.requestCharge += result.requestCharge || 0;
    for (const [status, n] of Object.entries(result.statusCounts || {})) {
      summary.statusCounts[status] = (summary.statusCounts[status] || 0) + n;
    }
  };

  // ONE QUERY PER PARTITION, not one paged cross-partition read: measured 2026-08-22, the
  // cross-partition `ORDER BY c.id ASC` read returns its first page with NO continuation token, so
  // a paging loop stops after one page and reports success (backfill-document-list-ids.js).
  // A bulk write cannot span partition keys either, so the writes are grouped this way regardless.
  // `''` is a real partition: documents with no project live there.
  const projectPage = await projectsRepo.listVisible(access, {});
  const partitions = ['', ...projectPage.items.map(p => String(p.id))];
  summary.expected = await documentsRepo.countVisible(access, {});

  for (const partition of partitions) {
    const page = await documentsRepo.listVisible(access, { projectId: partition });
    let pending = [];

    for (const doc of page.items) {
      summary.scanned++;
      const ops = planPatch(doc, now);
      if (!ops) { summary.current++; continue; }
      summary.planned++;
      if (!args.live) continue;

      pending.push({
        operationType: 'Patch',
        partitionKey: String(doc.projectId ?? ''),
        id: String(doc.id),
        resourceBody: { operations: ops }
      });
      if (pending.length >= cosmos.BULK_MAX_OPERATIONS) {
        await flush(pending);
        pending = [];
      }
    }

    if (args.live) await flush(pending);
  }

  logger.info(summaryLine(summary));
  // THE COVERAGE CHECK: a partition that was never walked is invisible in every other number here,
  // and a run that reports success is one nobody repeats.
  if (summary.scanned !== summary.expected) {
    logger.warn(`[sort-key-backfill] INCOMPLETE: scanned ${summary.scanned} of ` +
      `${summary.expected} documents — do NOT treat this run as done.`);
  }
  if (summary.failed) {
    logger.error(`[sort-key-backfill] statuses: ${JSON.stringify(summary.statusCounts)}`);
  }

  return summary;
}

/** Partial is not success: a rejected write and an unwalked partition both exit 1. */
function exitCodeFor(summary) {
  return summary.failed > 0 || summary.scanned !== summary.expected ? 1 : 0;
}

module.exports = { parseArgs, planPatch, backfillDisplayNameSort, exitCodeFor, summaryLine };

if (require.main === module) {
  const { initCosmosClient } = require('../db/cosmos-nosql');
  initCosmosClient();

  backfillDisplayNameSort(process.argv.slice(2))
    .then(summary => process.exit(exitCodeFor(summary)))
    .catch(err => {
      logger.error('[sort-key-backfill] Fatal', { error: err.message, stack: err.stack });
      process.exit(1);
    });
}
