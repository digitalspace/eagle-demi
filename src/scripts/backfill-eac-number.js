'use strict';

/**
 * Stamp `eaCertificate` onto the project rows already in Cosmos, from the checked-in Track export.
 *
 * WHY A SCRIPT. `merge/project.js` carries `ea_certificate` through as `eaCertificate`, but the
 * merge only runs on a re-seed, and `seed-nosql.js` rewrites the whole corpus including documents —
 * `transformDocument` resets `contentExtracted`, sending ~60,578 documents back through the GPU.
 * This touches one field on the project rows. Same argument as close-unpublished-track-projects.js.
 *
 * THE EXPORT DOES NOT CARRY THE COLUMN YET. `src/data/track_projects_enriched.json` (382 records,
 * 2026-07-29) has no `ea_certificate`, so a run today reports `withCert=0` and patches nothing.
 * That is the expected result until the next Track pull adds it; nothing here needs changing then.
 *
 *   node src/scripts/backfill-eac-number.js [--live]
 *
 * **DRY RUN BY DEFAULT.** `--live` is the mutating flag, matching the sibling scripts. Cosmos is
 * private-endpoint-only and keyless, so a live run executes on the devbox (`demi-devbox-<env>`)
 * via `demi-run` — see README "Running anything against the database".
 *
 * VERBATIM. Track uses the column for certificate STATE as well as numbers — "E98-05" and
 * "WD09-01", but also "Withdrawn", "In progress", "REFUSED", "N/A". Nothing here parses, filters or
 * normalises it; whatever Track says is what the row gets.
 *
 * NOT INDEXED. `eaCertificate` is not a column of the `projects` search index and is not in
 * `PROJECT_SELECT`, so this changes what `GET /api/projects/:id` and the keywordless project list
 * return, and nothing a keyword search returns.
 */

const sources = require('../seed/sources');
const projects = require('../repositories/projects');
const cosmos = require('../db/cosmos-nosql');
const { systemAccess } = require('../helpers/access-sql');
const { mergeTrackProject, hasValue } = require('../merge/project');
const { logger } = require('../utils/logger');

function parseArgs(argv) {
  const args = { live: false };
  for (const a of argv) {
    if (a === '--live') args.live = true;
    else throw new Error(`[eac-backfill] unknown argument: ${a}`);
  }
  return args;
}

/**
 * The value a re-seed would store — asked of the merge itself rather than read off the raw column,
 * so the backfill cannot write something a later re-seed then overwrites. `null` for a Track record
 * carrying no certificate.
 */
function certificateOf(track) {
  const { eaCertificate } = mergeTrackProject(track, null);
  return hasValue(eaCertificate) ? eaCertificate : null;
}

/** The one line an operator reads. `missingRow` is drift to look at, not a failure — see below. */
function summaryLine(s) {
  return `[eac-backfill] mode=${s.mode} total=${s.total} withCert=${s.withCert} ` +
    `patched=${s.patched} missingRow=${s.missingRow}`;
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

  const trackProjects = await src.loadTrackProjects();
  const summary = {
    mode: args.live ? 'live' : 'dry-run',
    total: trackProjects.length,
    withCert: 0,
    patched: 0,
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
