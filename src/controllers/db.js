'use strict';

const mongoose = require('mongoose');
const Project = require('../models/project');
const Document = require('../models/document');
const Region = require('../models/region');
const Boundary = require('../models/boundary');
const { runSync } = require('../scripts/sync_from_openshift');

const models = {
  projects: Project,
  documents: Document,
  regions: Region,
  boundaries: Boundary
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
      database: mongoose.connection.name || 'demi',
      connectionState: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
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
    // Run sync asynchronously in background or await if requested
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
    const bulkOps = items.map((item) => ({
      updateOne: {
        filter: { _id: item._id || new mongoose.Types.ObjectId() },
        update: { $set: item },
        upsert: true
      }
    }));

    const result = await Model.bulkWrite(bulkOps, { ordered: false });
    const count = await Model.countDocuments();

    res.json({
      success: true,
      collection,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      upsertedCount: result.upsertedCount,
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
    const { collection, action = 'find', filter = {}, update = {}, limit = 100 } = req.body;
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
        data = await Model.find(filter).limit(Number(limit));
        break;
      case 'findOne':
        data = await Model.findOne(filter);
        break;
      case 'updateOne':
        data = await Model.updateOne(filter, update, { upsert: true });
        break;
      case 'updateMany':
        data = await Model.updateMany(filter, update);
        break;
      case 'deleteOne':
        data = await Model.deleteOne(filter);
        break;
      case 'deleteMany':
        data = await Model.deleteMany(filter);
        break;
      case 'count':
        data = { count: await Model.countDocuments(filter) };
        break;
      default:
        return res.status(400).json({
          success: false,
          error: `Unsupported action '${action}'. Allowed: find, findOne, updateOne, updateMany, deleteOne, deleteMany, count`
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

module.exports = {
  getDbStats,
  seedDatabase,
  importCollection,
  queryCollection
};
