'use strict';

// Hard removal of a document for `DELETE /documents/:id` and the seed's `--reconcile`. Indexers never
// see a delete, so the index entries go here too; the stored blob stays, its PDF facts are logged.

const documents = require('../repositories/documents');
const chunks = require('../repositories/chunks');
const { systemAccess } = require('./access-sql');
const aiSearch = require('../search/ai-search');
const { logger } = require('../utils/logger');

/** Index removal; with search configured, `indexRemovalError` names whatever may still be searchable. */
async function removeFromSearch(id) {
  const strict = aiSearch.config().configured;
  let removedChunksFromSearch;
  let indexRemovalError = null;
  try {
    removedChunksFromSearch = await aiSearch.deleteChunksForDocument(id, { strict });
  } catch (err) {
    if (err.code !== 'INDEX_DELETE_INCOMPLETE') throw err;
    removedChunksFromSearch = err.deleted;
    indexRemovalError = err.message;
  }
  const removedFromSearch = await aiSearch.deleteFromIndex(aiSearch.indexes().documents, id);
  if (strict && removedFromSearch === 0) {
    indexRemovalError = [indexRemovalError, `document ${id} is still in the search index`].filter(Boolean).join('; ');
  }
  return { removedFromSearch, removedChunksFromSearch, indexRemovalError };
}

/** The stamp moves _ts, so the document indexer puts the kept row back in document search. */
async function keepRow(id, projectId, report, step, error) {
  logger.error(`[purge] ${step} for document ${id}, row kept: ${error}`);
  await documents.patchExtraction(id, projectId, { chunkPurgeFailedAt: new Date().toISOString() })
    .catch(err => logger.error(`[purge] could not stamp kept document ${id}: ${err.message}`));
  return { ...report, rowKept: true };
}

// Index first, row last, so a retried DELETE finds everything again. An incomplete chunk removal, or
// with search configured an incomplete index removal, keeps the row (`rowKept: true`).
async function purgeDocument({ id, projectId, s3Key, pdfTitle } = {}) {
  const { indexRemovalError, ...removed } = await removeFromSearch(id);
  const report = { removedChunks: 0, ...removed, storedFileRetained: Boolean(s3Key) };
  if (indexRemovalError) {
    const kept = await keepRow(id, projectId, report, 'search index removal incomplete', indexRemovalError);
    return { ...kept, indexRemovalError };
  }

  let chunkRemovalError = null;
  try {
    const result = await chunks.removeForDocument(systemAccess(), id);
    report.removedChunks = result.succeeded || 0;
    if (result.failed > 0) chunkRemovalError = `${result.failed} chunk(s) not removed`;
  } catch (err) {
    chunkRemovalError = err.message;
  }
  if (chunkRemovalError) {
    // Leftover chunks keep their old _ts, so they stay out of chunk search until a retry.
    const kept = await keepRow(id, projectId, report, 'chunk removal failed', chunkRemovalError);
    return { ...kept, chunkRemovalError };
  }

  if (pdfTitle) {
    // In the message, not meta: the deployed format (NODE_ENV unset) prints the message alone.
    // sourceKey names the object the hash describes; reconcile rows carry no s3Key.
    logger.info(`[purge] pdf-title.original id=${id} s3Key=${s3Key} ` +
      `sourceKey=${pdfTitle.sourceKey} originalLength=${pdfTitle.originalLength} ` +
      `originalSha256=${pdfTitle.originalSha256}`);
  }
  await documents.deleteById(id, projectId);

  return { ...report, rowKept: false };
}

module.exports = { purgeDocument };
