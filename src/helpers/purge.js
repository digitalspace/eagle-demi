'use strict';

/**
 * Hard removal of a record and everything that outlives it.
 *
 * One implementation, two callers: `DELETE /documents/:id` and `DELETE /projects/:id`, plus the
 * seeder's `--reconcile`. AI Search indexers run on a `_ts` high-water mark and never see a
 * delete, so removing the index entry here is the ONLY thing that stops a deleted record staying
 * findable — a second implementation would eventually forget one of these calls.
 *
 * The stored blob is deliberately left in place: no caller may destroy a source file.
 */

const documents = require('../repositories/documents');
const projects = require('../repositories/projects');
const chunks = require('../repositories/chunks');
const { systemAccess } = require('./access-sql');
const aiSearch = require('../search/ai-search');
const { logger } = require('../utils/logger');

/**
 * Remove a document, its chunks, and both search-index entries.
 * Cleanup is best-effort and reported rather than thrown: the row is already gone.
 */
async function purgeDocument({ id, projectId, s3Key } = {}) {
  await documents.deleteById(id, projectId);

  let removedChunks = 0;
  try {
    const result = await chunks.removeForDocument(systemAccess(), id);
    removedChunks = result.succeeded || 0;
  } catch (err) {
    logger.error(`[purge] chunk removal failed for document ${id}: ${err.message}`);
  }

  const removedFromSearch = await aiSearch.deleteFromIndex(aiSearch.indexes().documents, id);
  const removedChunksFromSearch = await aiSearch.deleteChunksForDocument(id);

  return {
    removedChunks,
    removedFromSearch,
    removedChunksFromSearch,
    storedFileRetained: Boolean(s3Key)
  };
}

async function purgeProject({ id } = {}) {
  await projects.deleteById(id);
  const removedFromSearch = await aiSearch.deleteFromIndex(aiSearch.indexes().projects, id);
  return { removedFromSearch };
}

module.exports = { purgeDocument, purgeProject };
