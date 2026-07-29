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
 * Get document counts and stats for all collections
 */
async function getDbStats(req, res) {
  try {
    const stats = {};
    for (const [name, model] of Object.entries(models)) {
      stats[name] = await model.countDocuments();
    }
    res.json({
      success: true,
      database: 'epic',
      connectionState: 'connected',
      driver: 'azure-cosmos-sdk',
      stats
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
  seedDatabase,
  seedTrackDatabase,
  runNightlySyncHandler,
  runNrptiSyncHandler
};
