'use strict';

// Stores `documentPhases`, dated from public documents and periods, and what derives from it.
// `node src/scripts/date-assessment-phases.js [--live]`; dry run by default.

const { systemAccess } = require('../helpers/access-sql');
const { writeGuarded } = require('../helpers/etag-write');
const { actBlocks, datePhasesFromDocuments, deriveAssessments } = require('../merge/assessments');
const { LEVELS } = require('../vis/level');
const projectsRepository = require('../repositories/projects');
const documentsRepository = require('../repositories/documents');
const periodsRepository = require('../repositories/comment-periods');
const listsRepository = require('../repositories/lists');
const { logger } = require('../utils/logger');

const DERIVED_FIELDS = ['documentPhases', 'assessments', 'phaseIds', 'activeWork'];
const DOCUMENT_FIELDS = ['projectPhaseId', 'projectPhase', 'datePosted'];
const PERIOD_FIELDS = ['dateStarted', 'dateCompleted', 'informationLabel'];
const ANONYMOUS_LEVEL = 4;

/** Public, and no field the dating reads is dialled below the anonymous level. */
function isPublicFor(row, fields) {
  if (!row || !Array.isArray(row.read) || !row.read.includes('public')) return false;
  const dials = row.vis && typeof row.vis === 'object' ? row.vis : {};
  return fields.every(field => !(LEVELS.includes(dials[field]) && dials[field] < ANONYMOUS_LEVEL));
}

const derivedJson = (row) => JSON.stringify(DERIVED_FIELDS.map(field => row[field] ?? null));

function parseArgs(argv) {
  const args = { live: false };
  for (const arg of argv) {
    if (arg === '--live') args.live = true;
    else throw new Error(`[assessment-phases] unknown argument: ${arg}`);
  }
  return args;
}

const summaryLine = (s) => `[assessment-phases] mode=${s.mode} projects=${s.projects} ` +
  `written=${s.written} unchanged=${s.unchanged} failures=${s.failures}`;

/** @param {object} [opts] {live} write, {deps} test seam {projects, documents, periods, lists} */
async function run({ live = false, deps = {} } = {}) {
  const projects = deps.projects || projectsRepository;
  const documents = deps.documents || documentsRepository;
  const periods = deps.periods || periodsRepository;
  const lists = deps.lists || listsRepository;
  // systemAccess(): a scoped read would miss rows, and the filter below decides what is public.
  const access = systemAccess();
  const summary = { mode: live ? 'live' : 'dry-run', projects: 0, written: 0, unchanged: 0, failures: 0 };

  try {
    const listRows = await lists.listEveryOfKind('List', access);
    const phaseRows = listRows.filter(row => row && row.type === 'projectPhase');
    const { items } = await projects.listVisible(access, {});
    summary.projects = items.length;

    for (const project of items) {
      const id = String(project.id);
      try {
        const [docs, cps] = await Promise.all([
          documents.projectedRowsForProject(access, id, ['projectPhaseId', 'datePosted', 'read', 'vis']),
          periods.listEveryByProject(id, access)
        ]);
        const documentPhases = datePhasesFromDocuments(
          docs.filter(row => isPublicFor(row, DOCUMENT_FIELDS)),
          cps.filter(row => isPublicFor(row, PERIOD_FIELDS)),
          phaseRows, actBlocks(project));
        const derive = (row) => {
          const next = { ...row, documentPhases };
          return { ...next, ...deriveAssessments(next, { lists: listRows }) };
        };

        if (!live) {
          if (derivedJson(derive(project)) === derivedJson(project)) summary.unchanged++;
          else summary.written++;
          continue;
        }

        const written = await writeGuarded({
          existing: project,
          reread: () => projects.getById(access, id),
          attempt: async (current) => {
            if (!current) return { status: 'missing' };
            const next = derive(current);
            if (derivedJson(next) === derivedJson(current)) return { status: 'unchanged' };
            await projects.upsert(next, { etag: current._etag });
            return { status: 'saved' };
          },
          onLost: (_current, attempt) =>
            logger.warn('[assessment-phases] project write lost its etag race, rebuilding', { id, attempt })
        });
        if (written.status === 'saved') summary.written++;
        else if (written.status === 'unchanged') summary.unchanged++;
        else {
          summary.failures++;
          logger.error(`[assessment-phases] project ${id} not written`, { status: written.status });
        }
      } catch (err) {
        summary.failures++;
        logger.error(`[assessment-phases] project ${id} failed`, { error: err.message });
      }
    }
  } catch (err) {
    summary.failures++;
    logger.error('[assessment-phases] run failed', { error: err.message, stack: err.stack });
  }

  logger.info(summaryLine(summary));
  return summary;
}

module.exports = { run, parseArgs, isPublicFor };

if (require.main === module) {
  Promise.resolve()
    .then(() => run(parseArgs(process.argv.slice(2))))
    .then(summary => process.exit(summary.failures > 0 ? 1 : 0))
    .catch((err) => {
      logger.error(`[assessment-phases] ${err.stack || err.message}`);
      process.exit(1);
    });
}
