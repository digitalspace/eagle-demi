'use strict';

/**
 * Copy the staff-side Eagle fields onto the comment, comment-period and organization rows already
 * in Cosmos, from the raw Eagle record each row keeps in `sources.eagle`.
 *
 * WHY. The three mirrors now promote these fields (`staffFields` in each controller), but rows
 * written before that hold them only in `sources.eagle`, which no caller can read. A re-push from
 * Eagle would fix it, and is what this avoids: the values are already inside DEMI.
 *
 *   node src/scripts/backfill-eagle-staff-fields.js [--live]
 *
 * **DRY RUN BY DEFAULT**, matching the sibling scripts; `--dry-run` says so explicitly. Cosmos is
 * private-endpoint-only and keyless, so a live run executes on the devbox (`demi-devbox-<env>`) via
 * `demi-run` — see README "Running anything against the database".
 *
 * Each row is replaced whole under the etag it was read at, so a push landing in between wins and
 * the row is counted `raced`; a second run picks up anything left. Sealed rows are not scanned:
 * systemAccess() carries the sealed exclusion like every other ladder read.
 */

const { isDeepStrictEqual } = require('node:util');
const cosmos = require('../db/cosmos-nosql');
const { selectWhere, countWhere, eq, fetchAll } = require('../repositories/_sql');
const comments = require('../repositories/comments');
const commentPeriods = require('../repositories/comment-periods');
const lists = require('../repositories/lists');
const { systemAccess } = require('../helpers/access-sql');
const commentMirror = require('../controllers/nosql/comment');
const commentPeriodMirror = require('../controllers/nosql/comment-period');
const organizationMirror = require('../controllers/nosql/organization');
const { logger } = require('../utils/logger');

const TAG = '[staff-fields-backfill]';

const TARGETS = [
  { container: comments.CONTAINER, partitionField: comments.PARTITION_FIELD,
    staffFields: commentMirror.staffFields, criteria: [] },
  { container: commentPeriods.CONTAINER, partitionField: commentPeriods.PARTITION_FIELD,
    staffFields: commentPeriodMirror.staffFields, criteria: [] },
  { container: lists.CONTAINER, partitionField: lists.PARTITION_FIELD,
    staffFields: organizationMirror.staffFields,
    criteria: [eq(lists.PARTITION_FIELD, lists.KINDS.ORGANIZATION, '@kind')] }
];

function parseArgs(argv) {
  const args = { live: false };
  for (const a of argv) {
    if (a === '--live') args.live = true;
    else if (a === '--dry-run') args.live = false;
    else throw new Error(`${TAG} unknown argument: ${a}`);
  }
  return args;
}

/** The row with its staff fields re-derived from `sources.eagle`; null when it already agrees. */
function planRow(row, staffFields) {
  const want = staffFields(row.sources.eagle);
  if (Object.entries(want).every(([k, v]) => isDeepStrictEqual(row[k], v))) return null;
  const { _etag, ...body } = row;
  return { ...body, ...want };
}

function summaryLine(s) {
  return `${TAG} container=${s.container} mode=${s.mode} scanned=${s.scanned} of ${s.expected} ` +
    `current=${s.current} noSource=${s.noSource} planned=${s.planned} written=${s.written} ` +
    `raced=${s.raced} failed=${s.failed}`;
}

async function backfillContainer(target, args, io) {
  const { container, partitionField, staffFields } = target;
  const spec = { access: systemAccess(), partitionField: null,
    criteria: [eq('sourceSystem', 'eagle', '@source'), ...target.criteria] };

  const summary = {
    container, mode: args.live ? 'live' : 'dry-run',
    expected: await io.count(container, countWhere(spec)),
    scanned: 0, current: 0, noSource: 0, planned: 0, written: 0, raced: 0, failed: 0
  };

  // One drained cross-partition read, no ORDER BY: the SDK's own fetchAll follows every page.
  const rows = await io.fetchAll(container, selectWhere(spec));
  // A bulk request may not span partition keys.
  const byPartition = new Map();
  for (const row of rows) {
    summary.scanned++;
    if (!row.sources || !row.sources.eagle) { summary.noSource++; continue; }
    const body = planRow(row, staffFields);
    if (!body) { summary.current++; continue; }
    summary.planned++;
    const key = row[partitionField];
    if (!byPartition.has(key)) byPartition.set(key, []);
    byPartition.get(key).push({
      operationType: 'Replace', id: String(row.id), partitionKey: key,
      ifMatch: row._etag, resourceBody: body
    });
  }

  if (args.live) {
    for (const operations of byPartition.values()) {
      const result = await io.bulkVerified(container, operations);
      summary.written += result.succeeded || 0;
      summary.failed += result.failed || 0;
      summary.raced += (result.skippedIds || []).length;
    }
  }

  logger.info(summaryLine(summary));
  if (summary.scanned !== summary.expected) {
    logger.warn(`${TAG} INCOMPLETE: ${container} scanned ${summary.scanned} of ` +
      `${summary.expected} rows — do NOT treat this run as done.`);
  }
  return summary;
}

/**
 * @param {string[]} argv
 * @param {object} [deps] test seam: {fetchAll, count, bulkVerified}
 * @returns {Promise<object[]>} one summary per container
 */
async function backfillEagleStaffFields(argv = [], deps = {}) {
  const args = parseArgs(argv);
  const io = {
    fetchAll: deps.fetchAll || fetchAll,
    count: deps.count || (async (container, spec) => (await cosmos.query(container, spec)).items[0] || 0),
    bulkVerified: deps.bulkVerified || ((container, ops) => cosmos.bulkVerified(container, ops))
  };

  const summaries = [];
  for (const target of TARGETS) summaries.push(await backfillContainer(target, args, io));
  return summaries;
}

/** Partial is not success: a rejected write and a short read both exit 1. A raced row is not. */
function exitCodeFor(summaries) {
  return summaries.some(s => s.failed > 0 || s.scanned !== s.expected) ? 1 : 0;
}

module.exports = { parseArgs, planRow, backfillEagleStaffFields, exitCodeFor, summaryLine };

if (require.main === module) {
  cosmos.initCosmosClient();

  backfillEagleStaffFields(process.argv.slice(2))
    .then(summaries => process.exit(exitCodeFor(summaries)))
    .catch(err => {
      logger.error(`${TAG} Fatal`, { error: err.message, stack: err.stack });
      process.exit(1);
    });
}
