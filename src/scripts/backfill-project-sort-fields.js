'use strict';

/**
 * Write every native sort field on the project rows already in Cosmos.
 *
 * A Cosmos ORDER BY drops a row that lacks the sort field, so `projects.upsert` writes each
 * `SORTABLE` field (`sortFieldFills` in `repositories/projects.js`). Rows written before that lack
 * some of them (66 lack `dateUpdated` on test). This sets only the absent fields, with the same
 * values the upsert writes; a field the row already holds, null included, is never touched.
 *
 *   node src/scripts/backfill-project-sort-fields.js [--live]
 *
 * **DRY RUN BY DEFAULT.** `--live` is the mutating flag, matching the sibling scripts. Cosmos is
 * private-endpoint-only and keyless, so a live run executes on the devbox (`demi-devbox-<env>`)
 * via `demi-run`; see README "Running anything against the database".
 */

const projects = require('../repositories/projects');
const cosmos = require('../db/cosmos-nosql');
const { systemAccess } = require('../helpers/access-sql');
const { logger } = require('../utils/logger');

function parseArgs(argv) {
  const args = { live: false };
  for (const a of argv) {
    if (a === '--live') args.live = true;
    else throw new Error(`[sort-fields] unknown argument: ${a}`);
  }
  return args;
}

/** The patch ops that set each fill; empty when the row already holds every sort field. */
function fillOps(fills) {
  return Object.entries(fills).map(([field, value]) => ({ op: 'set', path: `/${field}`, value }));
}

function summaryLine(s) {
  const fields = Object.entries(s.fields).map(([field, n]) => `${field}=${n}`).join(' ') || 'none';
  return `[sort-fields] mode=${s.mode} total=${s.total} changed=${s.changed} ` +
    `patched=${s.patched} failed=${s.failed} missing: ${fields}`;
}

/**
 * @param {string[]} argv
 * @param {object} [deps] test seam: {projects, patch}
 */
async function backfillProjectSortFields(argv = [], deps = {}) {
  const args = parseArgs(argv);
  const projectsRepo = deps.projects || projects;
  const patch = deps.patch ||
    ((id, ops) => cosmos.patch(projectsRepo.CONTAINER, String(id), String(id), ops));

  // systemAccess(): a scoped context lists only the rows it can read and would skip the rest.
  const { items } = await projectsRepo.listVisible(systemAccess(), {});
  const summary = {
    mode: args.live ? 'live' : 'dry-run',
    total: items.length,
    changed: 0,
    patched: 0,
    failed: 0,
    fields: {}
  };

  for (const row of items) {
    const fills = projects.sortFieldFills(row);
    const ops = fillOps(fills);
    if (!ops.length) continue;
    summary.changed++;
    for (const field of Object.keys(fills)) summary.fields[field] = (summary.fields[field] || 0) + 1;
    if (!args.live) continue;

    try {
      await patch(row.id, ops);
      summary.patched++;
    } catch (err) {
      summary.failed++;
      logger.error(`[sort-fields] FAILED ${row.id}: ${err.message}`);
    }
  }

  logger.info(summaryLine(summary));
  return summary;
}

function exitCodeFor(summary) {
  return summary.failed > 0 ? 1 : 0;
}

module.exports = { backfillProjectSortFields, fillOps, summaryLine, exitCodeFor, parseArgs };

if (require.main === module) {
  backfillProjectSortFields(process.argv.slice(2))
    .then(summary => process.exit(exitCodeFor(summary)))
    .catch((err) => {
      logger.error(`[sort-fields] ${err.stack || err.message}`);
      process.exit(1);
    });
}
