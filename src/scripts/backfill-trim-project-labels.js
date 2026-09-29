'use strict';

/**
 * Trim `sector` and `projectSubType` on the project rows already in Cosmos.
 *
 * The merge stores both trimmed (`TRIMMED_FIELDS` in `merge/project.js`), but rows written before
 * that still carry a trailing space ("Groundwater Extraction ", 9 rows), and the index filters them
 * by exact match. This patches only the fields that change; no re-seed.
 *
 *   node src/scripts/backfill-trim-project-labels.js [--live]
 *
 * **DRY RUN BY DEFAULT.** `--live` is the mutating flag, matching the sibling scripts. Cosmos is
 * private-endpoint-only and keyless, so a live run executes on the devbox (`demi-devbox-<env>`)
 * via `demi-run` — see README "Running anything against the database". Run it before the projects
 * indexer reset, or the index keeps the untrimmed values until each row is next written.
 */

const projects = require('../repositories/projects');
const cosmos = require('../db/cosmos-nosql');
const { systemAccess } = require('../helpers/access-sql');
const { TRIMMED_FIELDS } = require('../merge/project');
const { logger } = require('../utils/logger');

function parseArgs(argv) {
  const args = { live: false };
  for (const a of argv) {
    if (a === '--live') args.live = true;
    else throw new Error(`[trim-labels] unknown argument: ${a}`);
  }
  return args;
}

/** The patch ops one row needs; empty when every label is already trimmed. */
function trimOps(row) {
  return TRIMMED_FIELDS
    .filter(field => typeof row[field] === 'string' && row[field].trim() !== row[field])
    .map(field => ({ op: 'set', path: `/${field}`, value: row[field].trim() }));
}

function summaryLine(s) {
  return `[trim-labels] mode=${s.mode} total=${s.total} changed=${s.changed} ` +
    `patched=${s.patched} failed=${s.failed}`;
}

/**
 * @param {string[]} argv
 * @param {object} [deps] test seam: {projects, patch}
 */
async function backfillTrimProjectLabels(argv = [], deps = {}) {
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
    failed: 0
  };

  for (const row of items) {
    const ops = trimOps(row);
    if (!ops.length) continue;
    summary.changed++;
    if (!args.live) continue;

    try {
      await patch(row.id, ops);
      summary.patched++;
    } catch (err) {
      summary.failed++;
      logger.error(`[trim-labels] FAILED ${row.id}: ${err.message}`);
    }
  }

  logger.info(summaryLine(summary));
  return summary;
}

function exitCodeFor(summary) {
  return summary.failed > 0 ? 1 : 0;
}

module.exports = { backfillTrimProjectLabels, trimOps, summaryLine, exitCodeFor, parseArgs };

if (require.main === module) {
  backfillTrimProjectLabels(process.argv.slice(2))
    .then(summary => process.exit(exitCodeFor(summary)))
    .catch((err) => {
      logger.error(`[trim-labels] ${err.stack || err.message}`);
      process.exit(1);
    });
}
