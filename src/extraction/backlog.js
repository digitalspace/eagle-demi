'use strict';

const config = require('../config');
const extractionRows = require('../repositories/documents-extraction');
const { enqueueExtraction } = require('./enqueue');
const { logger } = require('../utils/logger');

// Bounds retries of a row whose source file is missing: the job deletes that message and posts nothing.
const REQUEUE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Queue at most `EXTRACTION_SWEEP_MAX` unextracted rows; api/index.js runs it daily. */
async function sweep({ now = new Date() } = {}) {
  if (!config.extraction.queue) return { listed: 0, queued: 0 };

  const rows = await extractionRows.listExtractionBacklog({
    queuedBefore: new Date(now.getTime() - REQUEUE_AFTER_MS).toISOString(),
    max: config.extraction.sweepMax
  });
  let queued = 0;
  for (const row of rows) {
    if (await enqueueExtraction(row, 'backlog')) queued += 1;
  }
  logger.info('[extraction] backlog sweep', { listed: rows.length, queued });
  return { listed: rows.length, queued };
}

module.exports = { sweep };
