'use strict';

/**
 * Set Track's `eaCertificate` on stored project rows without a re-seed, which re-extracts every document.
 * Dry run unless `--live`; a row whose certificate staff saved is skipped (`held`), as a re-seed keeps it.
 */

const sources = require('../seed/sources');
const projects = require('../repositories/projects');
const cosmos = require('../db/cosmos-nosql');
const { systemAccess } = require('../helpers/access-sql');
const { mergeTrackProject, hasValue } = require('../merge/project');
const { STAFF_EDITED_AT } = require('../ownership/project');
const { logger } = require('../utils/logger');

function parseArgs(argv) {
  const args = { live: false };
  for (const a of argv) {
    if (a === '--live') args.live = true;
    else throw new Error(`[eac-backfill] unknown argument: ${a}`);
  }
  return args;
}

/** What a re-seed stores on a row staff have not saved, asked of the merge so the two agree; null for none. */
function certificateOf(track) {
  const { eaCertificate } = mergeTrackProject(track, null);
  return hasValue(eaCertificate) ? eaCertificate : null;
}

/** The one line an operator reads. `missingRow` is drift to look at, not a failure — see below. */
function summaryLine(s) {
  return `[eac-backfill] mode=${s.mode} total=${s.total} withCert=${s.withCert} ` +
    `patched=${s.patched} held=${s.held} missingRow=${s.missingRow}`;
}

/**
 * @param {string[]} argv
 * @param {object} [deps] test seam: {sources, projects, patch}
 */
async function backfillEacNumbers(argv = [], deps = {}) {
  const args = parseArgs(argv);
  const src = deps.sources || sources;
  const projectsRepo = deps.projects || projects;
  const patch = deps.patch ||
    ((id, ops) => cosmos.patch(projectsRepo.CONTAINER, String(id), String(id), ops));

  // systemAccess(), because a scoped context lists only the rows it can read and would report every
  // other one as missingRow — a partial run that looks like upstream drift.
  const access = systemAccess();
  const { items } = await projectsRepo.listVisible(access, {});
  const storedIds = new Set(items.map(p => String(p.id)));
  const heldIds = new Set(items.filter(p => hasValue(p[STAFF_EDITED_AT] && p[STAFF_EDITED_AT].eaCertificate))
    .map(p => String(p.id)));

  const trackProjects = await src.loadTrackProjects();
  const summary = {
    mode: args.live ? 'live' : 'dry-run',
    total: trackProjects.length,
    withCert: 0,
    patched: 0,
    held: 0,
    missingRow: 0,
    failed: 0
  };

  for (const track of trackProjects) {
    const certificate = certificateOf(track);
    if (certificate === null) continue;
    summary.withCert++;

    const id = String(track.track_project_id);
    if (!storedIds.has(id)) {
      // A Track project that was never seeded. Counted, not fatal: seeding it is a re-seed, and
      // this script has no business inventing a project row from one column.
      summary.missingRow++;
      continue;
    }
    if (heldIds.has(id)) {
      summary.held++;
      continue;
    }

    if (!args.live) continue;

    try {
      await patch(id, [{ op: 'set', path: '/eaCertificate', value: certificate }]);
      summary.patched++;
    } catch (err) {
      summary.failed++;
      logger.error(`[eac-backfill] FAILED ${id}: ${err.message}`);
    }
  }

  logger.info(summaryLine(summary));
  return summary;
}

/** 1 on a failed patch only. `missingRow` is upstream drift the summary reports, not work skipped. */
function exitCodeFor(summary) {
  return summary.failed > 0 ? 1 : 0;
}

module.exports = { backfillEacNumbers, certificateOf, summaryLine, exitCodeFor, parseArgs };

if (require.main === module) {
  backfillEacNumbers(process.argv.slice(2))
    .then(summary => process.exit(exitCodeFor(summary)))
    .catch((err) => {
      logger.error(`[eac-backfill] ${err.stack || err.message}`);
      process.exit(1);
    });
}
