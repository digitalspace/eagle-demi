'use strict';

// Read-only: stored row works against the container's, plus works with no project row. Exits 1 on a stored
// mismatch. Usage: scripts/demi-devbox.sh run --env test -- node src/scripts/check-works-parity.js

const { isDeepStrictEqual } = require('node:util');
const config = require('../config');
const { systemAccess } = require('../helpers/access-sql');
const projectsRepository = require('../repositories/projects');
const worksRepository = require('../repositories/works');
const { fetchAll } = require('../repositories/_sql');
const { loadWorks } = require('../domain/works-derive');
const { composedRow } = require('../controllers/nosql/project-compose');
const { ADDED_KEYS, withoutAdded, isTrackDoc, publicWorksOf } = require('../seed/track-mappers');
const { logger } = require('../utils/logger');

const holdsWorks = (row) => Array.isArray(row.works) && row.works.length > 0;

/** Whether the composed `works` and `phases` equal the row's; an empty container never does. */
function matches(row, worksForDerive) {
  const composed = composedRow(row, worksForDerive);
  return worksForDerive.length > 0 &&
    isDeepStrictEqual(withoutAdded(composed.works), withoutAdded(row.works)) &&
    isDeepStrictEqual(withoutAdded(composed.phases), withoutAdded(row.phases));
}

/** The project id of every live work; the override marker is not a work. */
const liveWorkProjectIds = () => fetchAll('works', {
  query: 'SELECT VALUE c.projectId FROM c WHERE NOT (IS_BOOL(c.deleted) AND c.deleted = true) AND NOT IS_DEFINED(c.kind)',
  parameters: []
});

/** Resolves the exit code. @param {object} [deps] test seam {projects, loadWorks, workProjectIds} */
async function run(deps = {}) {
  const projects = deps.projects || projectsRepository;
  const load = deps.loadWorks || loadWorks;
  const workProjectIds = deps.workProjectIds || liveWorkProjectIds;
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

/** The nightly's check: each project's container Track works against {pulled}, the pull's works by project id.
 *  A project the pull lacks (a failed read or the time budget) is skipped. Logs; never throws. */
async function trackParity(trackProjects, pulled) {
  if (!config.worksWrite || !config.trackWorksSync) return null;
  const counts = { trackMismatch: 0, projects: 0, skipped: 0 };
  for (const project of trackProjects || []) {
    const id = String(project.id);
    try {
      const stored = (await worksRepository.listForRead(id)).filter(isTrackDoc);
      if (!pulled.has(id)) {
        if (stored.length) counts.skipped++;
        continue;
      }
      counts.projects++;
      const container = publicWorksOf(stored, { sources: { track: { name: project.name } } });
      if (isDeepStrictEqual(withoutAdded(container), withoutAdded(pulled.get(id)))) continue;
      counts.trackMismatch++;
      logger.warn(`[works-parity] trackMismatch id=${id}`);
    } catch (err) {
      counts.skipped++;
      logger.error(`[works-parity] project ${id} not compared`, { error: err.message, stack: err.stack });
    }
  }
  logger.info(`[works-parity] trackMismatch=${counts.trackMismatch} projects=${counts.projects} skipped=${counts.skipped}`);
  return counts;
}

module.exports = { run, trackParity, withoutAdded, ADDED_KEYS };

if (require.main === module) {
  run().then(code => { process.exitCode = code; }, (err) => {
    logger.error(`[works-parity] ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
