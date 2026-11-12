'use strict';

const { systemAccess } = require('../helpers/access-sql');
const projectsRepo = require('../repositories/projects');
const documentsRepo = require('../repositories/documents');
const boundariesRepo = require('../repositories/boundaries');
const aiSearch = require('../search/ai-search');
const { serverError } = require('../helpers/response');
const { logger } = require('../utils/logger');

/** After a bulk load the index lags the rows: a read before 100% gets a short answer, not an error. */
const INDEXED_CONTAINERS = ['chunks', 'documents', 'projects'];

/**
 * Index-build progress per container, in percent. Served by the API because only the app's managed
 * identity can reach the private, keyless Cosmos account; it gates cutover after any bulk load.
 */
async function getIndexProgress() {
  const cosmosNoSql = require('../db/cosmos-nosql');
  const entries = await Promise.all(INDEXED_CONTAINERS.map(async (name) => {
    try {
      return [name, await cosmosNoSql.indexProgress(name)];
    } catch (err) {
      // One missing or unreadable container must not deny the whole reading. Any signed-in
      // caller reads this, so the Cosmos detail goes to the log only.
      logger.warn(`[demi-api] index progress for ${name} failed: ${err.message}`);
      return [name, 'error: unavailable'];
    }
  }));
  return Object.fromEntries(entries);
}

/**
 * GET /admin/index-progress: kept apart from /db/stats on purpose. It issues no container query, so
 * it still answers when every count is timing out.
 */
async function getIndexProgressHandler(req, res) {
  try {
    const progress = await getIndexProgress();
    // The chunk container a deployed build writes to cannot be read from outside: app settings
    // are not readable back, so the name is reported here.
    const chunks = require('../repositories/chunks');
    // Reranking degrades to BM25 with a 200 and the same shape, so `semantic` stats are the only
    // sign it is live. A plain object read, no container query: this stays the cheap endpoint.
    res.json({
      success: true,
      active: true,
      database: 'demi',
      indexProgress: progress,
      search: { container: chunks.CONTAINER, semantic: aiSearch.semanticStats() }
    });
  } catch (err) {
    return serverError(res, err, 'index progress failed');
  }
}

/**
 * Item counts per container, all from the one `demi` database. Runs under systemAccess(): an
 * admin-only operational reading of the whole database.
 */
async function getDbStats(req, res) {
  try {
    const access = systemAccess();

    // Eagle rows with no Track counterpart are retained and flagged; this is the only place their
    // number shows. Counted off `sourceSystem`, the flag itself.
    const [
      projects, eagleOnlyProjects, documents, boundaries,
      projectsWithCentroid, documentsExtracted, documentsExtractionErrors
    ] = await Promise.all([
      projectsRepo.countVisible(access),
      projectsRepo.countEagleOnlyIds(access),
      documentsRepo.countVisible(access),
      boundariesRepo.countVisible(access),
      projectsRepo.countWithCentroid(access),
      documentsRepo.countVisible(access, { extracted: true }),
      documentsRepo.countVisible(access, { extractionError: true })
    ]);

    const indexProgress = await getIndexProgress();

    res.json({
      success: true,
      database: 'demi',
      connectionState: 'connected',
      driver: 'azure-cosmos-nosql',
      stats: {
        projects,
        trackProjects: projects - eagleOnlyProjects,
        unlinkedProjects: eagleOnlyProjects,
        documents,
        boundaries,
        projectsWithCentroid,
        documentsExtracted,
        documentsExtractionErrors
      },
      indexProgress
    });
  } catch (err) {
    return serverError(res, err, 'db stats failed');
  }
}

// No seed route: a 60k-document seed outlives any HTTP request. src/scripts/seed-nosql.js runs on
// the devbox via `demi-run`; recipe in README.md.

module.exports = {
  getDbStats,
  getIndexProgressHandler
};
