'use strict';

const config = require('../config');
const queueClient = require('../jobs/queue-client');
const documents = require('../repositories/documents');
const extractionRows = require('../repositories/documents-extraction');
const { logger } = require('../utils/logger');

/** Why `row` gets no extraction message, or null when it should get one. */
function skipReason(row) {
  if (!row || !row.id) return 'no row';
  if (row.documentSource === documents.UPDATE_SOURCE) return 'update image';
  if (!documents.isScanCleared(row)) return 'not scan-cleared';
  if (row.isDeleted === true) return 'deleted';
  if (!row.s3Key) return 'no stored file';
  if (row.contentExtracted === true) return 'extracted';
  return null;
}

/**
 * Queue `row` for the extraction job and stamp `extractionQueuedAt`. Never throws: callers have
 * already written the row, so a failure is logged and the next catch-up run of
 * src/scripts/extraction-backlog.js picks the row up.
 *
 * @param {string} reason where the row came from (`intake`, `eagle`, `backlog`), carried in the message
 * @returns {Promise<boolean>} whether a message was sent
 */
async function enqueueExtraction(row, reason) {
  const name = config.extraction.queue;
  if (!name || skipReason(row)) return false;

  const documentId = String(row.id);
  const enqueuedAt = new Date().toISOString();
  try {
    // Plain JSON text: host.json `messageEncoding: "none"` covers this app's queues, and the job reads text.
    await queueClient.queueClientFor({ name, setting: 'EXTRACTION_QUEUE', feature: 'extraction enqueue' })
      .sendMessage(JSON.stringify({ documentId, projectId: row.projectId ?? null, reason, enqueuedAt }));
  } catch (err) {
    logger.warn('[extraction] enqueue failed', { documentId, reason, error: err.message, stack: err.stack });
    return false;
  }

  try {
    await extractionRows.markExtractionQueued(row.id, row.projectId, enqueuedAt);
  } catch (err) {
    // The message is out; without the stamp the next catch-up run may send it again; a second run writes nothing new.
    logger.warn('[extraction] queued stamp failed', { documentId, error: err.message, stack: err.stack });
  }
  return true;
}

module.exports = { enqueueExtraction };
