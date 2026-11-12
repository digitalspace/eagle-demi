'use strict';

// Read-only: each project row holding Track works against its works composed from the container.
// Usage: scripts/demi-devbox.sh run --env test -- node src/scripts/check-works-parity.js; exits 1 on any mismatch.

const { isDeepStrictEqual } = require('node:util');
const { systemAccess } = require('../helpers/access-sql');
const projectsRepository = require('../repositories/projects');
const { loadWorks } = require('../domain/works-derive');
const { composedRow } = require('../controllers/nosql/project-compose');
const { logger } = require('../utils/logger');

/** Keys the container adds to `works[].phases[]`, `works[].milestones[]` and `phases[]`; nothing else may differ. */
const ADDED_KEYS = new Set([
  'catalogId', 'catalogName', 'stage', 'order', 'trackPhaseId', 'phaseCodeId', 'trackEventId',
  'isSuspended', 'suspendedDate', 'startPlanned', 'endPlanned'
]);

/** `value` with every `ADDED_KEYS` key dropped at any depth. */
function withoutAdded(value) {
  if (Array.isArray(value)) return value.map(withoutAdded);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !ADDED_KEYS.has(key))
    .map(([key, inner]) => [key, withoutAdded(inner)]));
}

const holdsWorks = (row) => Array.isArray(row.works) && row.works.length > 0;

/** Whether the composed `works` and `phases` equal the row's; an empty container never does. */
function matches(row, worksForDerive) {
  const composed = composedRow(row, worksForDerive);
  return worksForDerive.length > 0 &&
    isDeepStrictEqual(withoutAdded(composed.works), withoutAdded(row.works)) &&
    isDeepStrictEqual(withoutAdded(composed.phases), withoutAdded(row.phases));
}

/** Resolves the exit code. @param {object} [deps] test seam {projects, loadWorks} */
async function run(deps = {}) {
  const projects = deps.projects || projectsRepository;
  const load = deps.loadWorks || loadWorks;
  const summary = { projects: 0, failures: 0, mismatch: 0 };
  try {
    const { items } = await projects.listVisible(systemAccess(), {});
    for (const row of items.filter(holdsWorks)) {
      summary.projects++;
      try {
        if (matches(row, (await load(row)).worksForDerive)) continue;
        summary.mismatch++;
        logger.warn(`[works-parity] mismatch id=${row.id}`);
      } catch (err) {
        summary.failures++;
        logger.error(`[works-parity] project ${row.id} failed`, { error: err.message, stack: err.stack });
      }
    }
  } catch (err) {
    summary.failures++;
    logger.error('[works-parity] run failed', { error: err.message, stack: err.stack });
  }
  logger.info(`[works-parity] projects=${summary.projects} failures=${summary.failures} mismatch=${summary.mismatch}`);
  return summary.mismatch > 0 || summary.failures > 0 ? 1 : 0;
}

module.exports = { run, withoutAdded, ADDED_KEYS };

if (require.main === module) {
  run().then(code => { process.exitCode = code; }, (err) => {
    logger.error(`[works-parity] ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
