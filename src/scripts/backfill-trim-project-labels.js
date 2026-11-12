'use strict';

/**
 * Trim `sector` and `projectSubType` on stored projects; the index filters them by exact match.
 * Dry run unless `--live`. Run before the projects indexer reset.
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

/**
 * The patch ops one row needs; empty when every label is already trimmed. A whitespace-only label
 * is removed, as the merge leaves a blank label out rather than storing ''.
 */
function trimOps(row) {
  return TRIMMED_FIELDS
    .filter(field => typeof row[field] === 'string' && row[field].trim() !== row[field])
    .map((field) => {
      const value = row[field].trim();
      return value ? { op: 'set', path: `/${field}`, value } : { op: 'remove', path: `/${field}` };
    });
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
