'use strict';

/**
 * Queues unextracted rows the release and push paths missed: old rows, failed sends, restored source files.
 * Runs on the devbox via `demi-run`; the operator exports both settings in USAGE in the same command.
 */

const config = require('../config');
const extractionRows = require('../repositories/documents-extraction');
const { enqueueExtraction } = require('../extraction/enqueue');
const { logger } = require('../utils/logger');

const TAG = '[extraction backlog]';
const MAX_BATCH = 500;
const USAGE = 'usage: EXTRACTION_QUEUE=<queue> AzureWebJobsStorage__accountName=<account> ' +
  `node src/scripts/extraction-backlog.js --max <1-${MAX_BATCH}> [--help]`;

// Bounds retries of a row whose source file is missing: the job deletes that message and posts nothing.
const REQUEUE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const args = { max: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help') args.help = true;
    else if (a === '--max') {
      const value = argv[++i] || '';
      args.max = /^\d+$/.test(value) ? Number(value) : NaN;
    } else throw new Error(`${TAG} unknown argument: ${a}`);
  }
  if (!args.help && !(args.max >= 1 && args.max <= MAX_BATCH)) throw new Error(`${TAG} ${USAGE}`);
  return args;
}

/** Queue at most `max` rows; rejects when a setting is missing or any send failed. */
async function run({ max, now = new Date() }) {
  const settings = {
    EXTRACTION_QUEUE: config.extraction.queue,
    AzureWebJobsStorage__accountName: process.env.AzureWebJobsStorage__accountName
  };
  for (const [setting, value] of Object.entries(settings)) {
    if (!value) throw new Error(`${TAG} ${setting} is not set; ${USAGE}`);
  }

  const rows = await extractionRows.listExtractionBacklog({
    queuedBefore: new Date(now.getTime() - REQUEUE_AFTER_MS).toISOString(),
    max
  });
  let queued = 0;
  for (const row of rows) {
    if (await enqueueExtraction(row, 'backlog')) queued += 1;
  }
  const report = { listed: rows.length, queued };
  logger.info(TAG, report);
  if (queued < rows.length) {
    throw new Error(`${TAG} ${queued} of ${rows.length} queued; see the [extraction] enqueue failed lines`);
  }
  return report;
}

module.exports = { parseArgs, run, MAX_BATCH };

if (require.main === module) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    logger.error(err.message);
    process.exit(1);
  }
  if (args.help) {
    logger.info(USAGE);
    process.exit(0);
  }
  require('../db/cosmos-nosql').initCosmosClient();
  run(args).catch((err) => {
    logger.error(`${TAG} ${err.stack || err.message}`);
    process.exit(1);
  });
}
