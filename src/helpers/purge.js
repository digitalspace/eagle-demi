'use strict';

// Hard removal of a document for `DELETE /documents/:id` and the seed's `--reconcile`. Indexers never
// see a delete, so the index entries go here too; the stored blob stays, its PDF facts are logged.

const documents = require('../repositories/documents');
const chunks = require('../repositories/chunks');
const { systemAccess } = require('./access-sql');
const aiSearch = require('../search/ai-search');
const { logger } = require('../utils/logger');

// Index first, row last, so a retried DELETE finds the chunks again; a chunk removal that threw or
// left chunks keeps the row (`rowKept: true`). Index cleanup is reported, never thrown.
async function purgeDocument({ id, projectId, s3Key, pdfTitle } = {}) {
  const removedChunksFromSearch = await aiSearch.deleteChunksForDocument(id);
  const removedFromSearch = await aiSearch.deleteFromIndex(aiSearch.indexes().documents, id);
  const report = { removedChunks: 0, removedFromSearch, removedChunksFromSearch, storedFileRetained: Boolean(s3Key) };

  let chunkRemovalError = null;
  try {
    const result = await chunks.removeForDocument(systemAccess(), id);
    report.removedChunks = result.succeeded || 0;
    if (result.failed > 0) chunkRemovalError = `${result.failed} chunk(s) not removed`;
  } catch (err) {
    chunkRemovalError = err.message;
  }
  if (chunkRemovalError) {
    logger.error(`[purge] chunk removal failed for document ${id}, row kept: ${chunkRemovalError}`);
    // Indexers re-read only rows whose _ts moved: the stamp puts the kept row back in document
    // search. Its leftover chunks keep their old _ts and stay out of chunk search until a retry.
    await documents.patchExtraction(id, projectId, { chunkPurgeFailedAt: new Date().toISOString() })
      .catch(err => logger.error(`[purge] could not stamp kept document ${id}: ${err.message}`));
    return { ...report, rowKept: true, chunkRemovalError };
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
