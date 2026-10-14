'use strict';

/**
 * Hard removal of a record and everything that outlives it.
 *
 * One implementation, two callers: `DELETE /documents/:id` and `DELETE /projects/:id`, plus the
 * seeder's `--reconcile`. AI Search indexers run on a `_ts` high-water mark and never see a
 * delete, so removing the index entry here is the ONLY thing that stops a deleted record staying
 * findable — a second implementation would eventually forget one of these calls. A DELETE that
 * overlaps an indexer run can still leave an index entry for a deleted row; the kept-row stamp
 * below makes that window reachable on a retried DELETE too.
 *
 * The stored blob is deliberately left in place: no caller may destroy a source file. A titled
 * PDF's original length and hash live only on the row, so they are logged before it goes.
 */

const documents = require('../repositories/documents');
const projects = require('../repositories/projects');
const chunks = require('../repositories/chunks');
const { systemAccess } = require('./access-sql');
const aiSearch = require('../search/ai-search');
const { logger } = require('../utils/logger');

/**
 * Remove a document, its chunks, and both search-index entries.
 * Index cleanup is best-effort and reported rather than thrown.
 *
 * Index first, then Cosmos, row last: a request that dies part way leaves the row, so a retried
 * DELETE finds the chunks again. The other order leaves index rows nothing can reach. For the same
 * reason a chunk removal that threw or left chunks behind keeps the row: `rowKept: true`.
 */
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

async function purgeProject({ id } = {}) {
  await projects.deleteById(id);
  const removedFromSearch = await aiSearch.deleteFromIndex(aiSearch.indexes().projects, id);
  return { removedFromSearch };
}

module.exports = { purgeDocument, purgeProject };
