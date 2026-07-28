'use strict';

const Project = require('../models/project');
const Document = require('../models/document');
const Region = require('../models/region');
const Boundary = require('../models/boundary');
const Record = require('../models/record');
const { runSync } = require('../scripts/sync_from_openshift');

const models = {
  projects: Project,
  documents: Document,
  regions: Region,
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
    const isAsync = req.query.async === 'true';
    if (isAsync) {
      runSync().catch((err) => console.error('Background seed error:', err));
      return res.json({
        success: true,
        message: 'Database seed/sync triggered in background from OpenShift API.'
      });
    }

    console.log(' Starting database seed/sync...');
    await runSync();
    const stats = {};
    for (const [name, model] of Object.entries(models)) {
      stats[name] = await model.countDocuments();
    }

    res.json({
      success: true,
      message: 'Database seed/sync completed successfully.',
      stats
    });
  } catch (err) {
    console.error('Seed database error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Trigger boundary seed from BC OpenMaps WFS
 */
async function seedBoundariesHandler(req, res) {
  try {
    const { seedBoundaries } = require('../scripts/seed-boundaries');
    const isAsync = req.query.async === 'true';
    if (isAsync) {
      seedBoundaries().catch((err) => console.error('Background boundary seed error:', err));
      return res.json({
        success: true,
        message: 'Boundary seed triggered in background from B.C. OpenMaps WFS.'
      });
    }

    console.log(' Starting boundary seed from B.C. OpenMaps WFS...');
    await seedBoundaries();
    const count = await Boundary.countDocuments();
    res.json({
      success: true,
      message: 'Boundary seed completed successfully.',
      count
    });
  } catch (err) {
    console.error('Seed boundaries error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Bulk import JSON documents into a specified collection
 */
async function importCollection(req, res) {
  try {
    const { collection, items } = req.body;
    if (!collection || !models[collection]) {
      return res.status(400).json({
        success: false,
        error: `Invalid collection. Allowed: ${Object.keys(models).join(', ')}`
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Items array is required and must not be empty.'
      });
    }

    const Model = models[collection];
    let upsertedCount = 0;
    for (const item of items) {
      await Model.upsert(item);
      upsertedCount++;
    }
    const count = await Model.countDocuments();

    res.json({
      success: true,
      collection,
      upsertedCount,
      totalCount: count
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Execute query / manipulation on Cosmos DB collection
 */
async function queryCollection(req, res) {
  try {
    const { collection, action = 'find' } = req.body;
    if (!collection || !models[collection]) {
      return res.status(400).json({
        success: false,
        error: `Invalid collection. Allowed: ${Object.keys(models).join(', ')}`
      });
    }

    const Model = models[collection];
    let data;

    switch (action) {
      case 'find':
        data = await Model.find();
        break;
      case 'count':
        data = { count: await Model.countDocuments() };
        break;
      default:
        return res.status(400).json({
          success: false,
          error: `Unsupported action '${action}'. Allowed: find, count`
        });
    }

    res.json({
      success: true,
      action,
      collection,
      data
    });
  } catch (err) {
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

module.exports = {
  getDbStats,
  seedDatabase,
  seedBoundaries: seedBoundariesHandler,
  importCollection,
  queryCollection,
  runNightlySyncHandler,
  runNrptiSyncHandler
};
