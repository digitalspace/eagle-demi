'use strict';

// Read-only: stored row works against the container's, plus works with no project row. Exits 1 on a stored
// mismatch. Usage: scripts/demi-devbox.sh run --env test -- node src/scripts/check-works-parity.js

const { isDeepStrictEqual } = require('node:util');
const config = require('../config');
const { systemAccess } = require('../helpers/access-sql');
const projectsRepository = require('../repositories/projects');
const worksRepository = require('../repositories/works');
const { loadWorks } = require('../domain/works-derive');
const { composedRow } = require('../controllers/nosql/project-compose');
const { withoutAdded, publicWorksOf, workDocOf } = require('../seed/track-mappers');
const { mapLimit } = require('../utils/worker-pool');
const { logger } = require('../utils/logger');

const TRACK_OWNER = 'track';
/** Projects whose container is read at once, as the pull reads Track. */
const PARITY_CONCURRENCY = 8;

const listOf = (value) => (Array.isArray(value) ? value : []);
const holdsWorks = (row) => Array.isArray(row.works) && row.works.length > 0;
const isTrackWork = (work) => Boolean(work) && work.trackWorkId !== null && work.trackWorkId !== undefined;

/** The row's Track works and phases as the row stored them; sheet works are not in `row.works`. */
const comparable = (row) => withoutAdded({ works: listOf(row.works).filter(isTrackWork), phases: row.phases });

/** Whether the composed Track works and phases equal the row's; an empty container never does. */
function matches(row, worksForDerive) {
  return worksForDerive.length > 0 && isDeepStrictEqual(comparable(composedRow(row, worksForDerive)), comparable(row));
}

/** Resolves the exit code. @param {object} [deps] test seam {projects, loadWorks, workProjectIds} */
async function run(deps = {}) {
  const projects = deps.projects || projectsRepository;
  const load = deps.loadWorks || loadWorks;
  const workProjectIds = deps.workProjectIds || (() => worksRepository.liveProjectIds());
  const summary = { projects: 0, failures: 0, storedMismatch: 0, orphaned: 0 };
  try {
    const { items } = await projects.listVisible(systemAccess(), {});
    for (const row of items.filter(holdsWorks)) {
      summary.projects++;
      try {
        if (matches(row, (await load(row)).worksForDerive)) continue;
        summary.storedMismatch++;
        logger.warn(`[works-parity] storedMismatch id=${row.id}`);
      } catch (err) {
        summary.failures++;
        logger.error(`[works-parity] project ${row.id} failed`, { error: err.message, stack: err.stack });
      }
    }
    const rowIds = new Set(items.map(row => String(row.id)));
    summary.orphaned = (await workProjectIds()).filter(id => !rowIds.has(String(id))).length;
  } catch (err) {
    summary.failures++;
    logger.error('[works-parity] run failed', { error: err.message, stack: err.stack });
  }
  logger.info(`[works-parity] projects=${summary.projects} failures=${summary.failures} ` +
    `storedMismatch=${summary.storedMismatch} orphaned=${summary.orphaned}`);
  return summary.storedMismatch > 0 || summary.failures > 0 ? 1 : 0;
}

/** `same`, `trackMismatch`, or `notWritten` when the container holds no Track-owned work (the mirror skipped it). */
async function compareProject(id, nestedWorks, name) {
  const stored = await worksRepository.listForRead(id);
  const owned = stored.filter(doc => worksRepository.ownerOf(doc) === TRACK_OWNER);
  if (!owned.length) return 'notWritten';
  // Another owner holds an adopted work, so the nightly never writes its Track copy.
  const foreign = new Set(stored.filter(doc => !owned.includes(doc)).map(doc => doc.id));
  const fresh = listOf(nestedWorks).map(work => workDocOf(work, { projectId: id })).filter(doc => doc && !foreign.has(doc.id));
  const row = { sources: { track: { name } } };
  return isDeepStrictEqual(publicWorksOf(owned, row), publicWorksOf(fresh, row)) ? 'same' : 'trackMismatch';
}

/** Projects with Track-owned works that the pull lacks: skipped when the pull failed a project or hit its budget. */
async function countAbsent(pull, counts) {
  try {
    const known = new Set((await worksRepository.liveProjectIds({ owner: TRACK_OWNER })).map(String));
    const absent = [...known].filter(id => !pull.nested.has(id)).length;
    // The pull does not name the projects it failed or ran out of time on, so any of either skips them all.
    counts[pull.stats.failures > 0 || pull.stats.budgetHit ? 'skipped' : 'absentFromPull'] += absent;
  } catch (err) {
    logger.error('[works-parity] Track work projects not listed', { error: err.message, stack: err.stack });
  }
}

/** The nightly's check after a live works write: the container's Track works against the pull's ({pull} as
 *  `fetchTrackWorks` returns it). Logs; never throws. */
async function trackParity(trackProjects, pull, { live = false } = {}) {
  if (!live || !config.worksWrite || !config.trackWorksSync || !pull || !pull.stats) return null;
  const counts = { trackMismatch: 0, projects: 0, skipped: 0, absentFromPull: 0, notWritten: 0 };
  const names = new Map(listOf(trackProjects).map(project => [String(project.id), project.name]));
  await mapLimit([...pull.nested], PARITY_CONCURRENCY, async ([id, nestedWorks]) => {
    let outcome;
    try {
      outcome = await compareProject(id, nestedWorks, names.get(id));
    } catch (err) {
      counts.skipped++;
      logger.error(`[works-parity] project ${id} not compared`, { error: err.message, stack: err.stack });
      return;
    }
    if (outcome === 'notWritten') return void counts.notWritten++;
    counts.projects++;
    if (outcome === 'same') return;
    counts.trackMismatch++;
    logger.warn(`[works-parity] trackMismatch id=${id}`);
  });
  await countAbsent(pull, counts);
  logger.info(`[works-parity] trackMismatch=${counts.trackMismatch} projects=${counts.projects} ` +
    `skipped=${counts.skipped} absentFromPull=${counts.absentFromPull} notWritten=${counts.notWritten}`);
  return counts;
}

module.exports = { run, trackParity, withoutAdded };

if (require.main === module) {
  run().then(code => { process.exitCode = code; }, (err) => {
    logger.error(`[works-parity] ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
