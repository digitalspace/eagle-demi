'use strict';

const { systemAccess } = require('../helpers/access-sql');
const projectsRepo = require('../repositories/projects');
const documentsRepo = require('../repositories/documents');
const boundariesRepo = require('../repositories/boundaries');
const recordsRepo = require('../repositories/records');

/**
 * Containers whose index-build state is worth reporting. A bulk load leaves the index lagging the
 * rows, and a reader that arrives before it reaches 100 sees a short answer rather than an error.
 */
const INDEXED_CONTAINERS = ['chunks', 'documents', 'projects'];

/**
 * Index-build progress per container, as a percentage.
 *
 * Exposed through the API rather than read out of band: Cosmos sits behind a private endpoint on a
 * keyless account, so the app's managed identity is the only thing that can read it, and this is
 * the app. Reused as the pre-cutover gate for any bulk load — see MIGRATION.md §F.
 */
async function getIndexProgress() {
  // No USE_COSMOS_NOSQL gate. It used to return null when the flag was unset, which is now the
  // wrong answer in the only remaining direction: with one data layer, an unset flag would make
  // this report "inactive" for a database that is very much serving traffic.
  const cosmosNoSql = require('../db/cosmos-nosql');
  const progress = {};
  for (const name of INDEXED_CONTAINERS) {
    try {
      progress[name] = await cosmosNoSql.indexProgress(name);
    } catch (err) {
      // One missing or unreadable container must not deny the whole reading.
      progress[name] = `error: ${err.message}`;
    }
  }
  return progress;
}

/**
 * GET /admin/index-progress — index-build state, and nothing else.
 *
 * Deliberately NOT folded into /db/stats, even now that stats no longer runs the legacy Mongo
 * counts that used to make it hang for minutes. An operational reading has to be independent of
 * the thing it is used to diagnose: this one issues no container query at all, so it still
 * answers when every count is timing out.
 */
async function getIndexProgressHandler(req, res) {
  try {
    const progress = await getIndexProgress();
    // Which container a DEPLOYED build actually writes chunks to is otherwise unobservable from
    // outside — app settings cannot be read back from the SCM container either, since it gets
    // neither the app's env nor its managed identity. One string removes the guess, and this is
    // exactly the fact that went wrong when chunk writes were pointed at `chunks_fts`.
    const chunks = require('../repositories/chunks');
    res.json({
      success: true,
      active: true,
      database: 'demi',
      indexProgress: progress,
      search: { container: chunks.CONTAINER }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Item counts per container.
 *
 * Every number now comes from the SAME database. This used to run four `countDocuments()` calls
 * against the legacy Mongo-API account (database `epic`) and report them alongside NoSQL index
 * progress — two databases in one response, which is exactly the confusion that let
 * `COSMOS_DATABASE` silently repoint the live app. Those counts are gone with the account.
 *
 * Counts run under systemAccess(): this is an operational reading of the whole database, the
 * route is admin-only, and systemAccess takes no arguments so it cannot be derived from a
 * request.
 */
async function getDbStats(req, res) {
  try {
    const access = systemAccess();

    const [projects, documents, records, boundaries] = await Promise.all([
      projectsRepo.countVisible(access),
      documentsRepo.countVisible(access),
      recordsRepo.countVisible(access),
      // No access argument — the boundaries container carries no read[] at all.
      boundariesRepo.count()
    ]);

    const indexProgress = await getIndexProgress();

    res.json({
      success: true,
      database: 'demi',
      connectionState: 'connected',
      driver: 'azure-cosmos-nosql',
      stats: { projects, documents, boundaries, records },
      ...(indexProgress ? { indexProgress } : {})
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// The seed and nightly-sync handlers are gone with the Mongo-era scripts behind them
// (sync_from_openshift, seed-and-merge, nightly-sync). `src/scripts/seed-nosql.js` reproduces
// projects, documents and boundaries from the upstream sources, and is run inside the network
// over the App Service SSH tunnel — a 60k-document seed outlives any HTTP request, so it never
// belonged behind a route. See README.md for the recipe.

/**
 * Trigger NRPTI sync process manually via HTTP API
 */
async function runNrptiSyncHandler(req, res) {
  try {
    const { syncNrptiData } = require('../scripts/sync-nrpti');
    const isAsync = req.query.async === 'true';

    if (isAsync) {
      syncNrptiData().catch((err) => console.error('Background NRPTI sync error:', err));
      return res.json({
        success: true,
        message: 'NRPTI sync process triggered in background.'
      });
    }

    console.log(' Starting manual NRPTI sync...');
    const results = await syncNrptiData();
    res.json({
      success: true,
      message: 'NRPTI sync completed successfully.',
      results
    });
  } catch (err) {
    console.error('NRPTI sync error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = {
  getDbStats,
  getIndexProgressHandler,
  runNrptiSyncHandler
};
