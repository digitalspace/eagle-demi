'use strict';

const Project = require('../models/project');
const Document = require('../models/document');
const Boundary = require('../models/boundary');
const Record = require('../models/record');
const { runSync } = require('../scripts/sync_from_openshift');

const models = {
  projects: Project,
  documents: Document,
  boundaries: Boundary,
  records: Record
};

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
  if (process.env.USE_COSMOS_NOSQL !== 'true') return null;

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
 * Deliberately NOT folded into /db/stats. That endpoint runs four `countDocuments()` calls against
 * the LEGACY Mongo-API account first and can take minutes or hang outright, so an instrument
 * placed behind it is unusable exactly when it is needed. An operational reading has to be cheap
 * and independent of the thing it is being used to diagnose.
 */
async function getIndexProgressHandler(req, res) {
  try {
    const progress = await getIndexProgress();
    if (!progress) {
      return res.json({ success: true, active: false, reason: 'USE_COSMOS_NOSQL is not true' });
    }
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
 * Get document counts and stats for all collections
 */
async function getDbStats(req, res) {
  try {
    const stats = {};
    for (const [name, model] of Object.entries(models)) {
      stats[name] = await model.countDocuments();
    }

    // Reported separately from `stats`, and labelled, because `stats` counts come from the LEGACY
    // Mongo-API layer (database `epic`) while index progress is read from the NoSQL account. Two
    // different databases in one response is exactly the confusion that made `COSMOS_DATABASE`
    // silently repoint the live app, so neither number is allowed to look like the other's.
    const indexProgress = await getIndexProgress();

    res.json({
      success: true,
      database: 'epic',
      connectionState: 'connected',
      driver: 'azure-cosmos-sdk',
      stats,
      ...(indexProgress ? { nosql: { database: 'demi', indexProgress } } : {})
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Trigger full sync / seed from OpenShift API to Cosmos DB
 */
async function seedDatabase(req, res) {
  try {
    const { run: runSeedAndMerge } = require('../scripts/seed-and-merge');
    const isAsync = req.query.async === 'true';
    if (isAsync) {
      runSync().then(() => runSeedAndMerge()).catch((err) => console.error('Background seed error:', err));
      return res.json({
        success: true,
        message: 'Database seed/sync triggered in background.'
      });
    }

    console.log(' Starting database seed/sync...');
    await runSync();
    const mergeStats = await runSeedAndMerge();
    const stats = {};
    for (const [name, model] of Object.entries(models)) {
      stats[name] = await model.countDocuments();
    }

    res.json({
      success: true,
      message: 'Database seed/sync completed successfully.',
      stats,
      mergeStats
    });
  } catch (err) {
    console.error('Seed database error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}




/**
 * Trigger nightly sync process manually via HTTP API
 */
async function runNightlySyncHandler(req, res) {
  try {
    const { runNightlySync } = require('../scripts/nightly-sync');
    const isAsync = req.query.async === 'true';
    if (isAsync) {
      runNightlySync().catch((err) => console.error('Background nightly sync error:', err));
      return res.json({
        success: true,
        message: 'Nightly sync process triggered in background.'
      });
    }

    console.log(' Starting manual nightly sync...');
    await runNightlySync();
    const stats = {};
    for (const [name, model] of Object.entries(models)) {
      stats[name] = await model.countDocuments();
    }

    res.json({
      success: true,
      message: 'Nightly sync completed successfully.',
      stats
    });
  } catch (err) {
    console.error('Nightly sync error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

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

/**
 * Trigger Track project seeding & NRPTI record folding explicitly
 */
async function seedTrackDatabase(req, res) {
  try {
    const { run: runSeedAndMerge } = require('../scripts/seed-and-merge');
    console.log('[dbController] Starting track project seed and merge...');
    const mergeStats = await runSeedAndMerge();
    const stats = {};
    for (const [name, model] of Object.entries(models)) {
      stats[name] = await model.countDocuments();
    }
    return res.json({
      success: true,
      message: 'Track projects seeded and NRPTI records folded successfully.',
      mergeStats,
      stats
    });
  } catch (err) {
    console.error('[dbController] Track seed error:', err);
    return res.status(500).json({ success: false, error: err.message, stack: err.stack });
  }
}

module.exports = {
  getDbStats,
  getIndexProgressHandler,
  seedDatabase,
  seedTrackDatabase,
  runNightlySyncHandler,
  runNrptiSyncHandler
};
