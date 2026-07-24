'use strict';

const mongoose = require('mongoose');
const config = require('../config');
const { logger } = require('../utils/logger');

// Load Mongoose Models
const Project = require('../models/project');
const Document = require('../models/document');
const Region = require('../models/region');
const Boundary = require('../models/boundary');

const OPENSHIFT_API_URL = process.env.OPENSHIFT_API_URL || 'https://eagle-demi-api-6cdc9e-dev.apps.silver.devops.gov.bc.ca/api';

async function fetchFromOpenShift(endpoint) {
  const url = `${OPENSHIFT_API_URL}${endpoint}`;
  logger.info(`Fetching data from OpenShift: ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return await response.json();
}

async function syncCollection(model, endpoint, name) {
  try {
    const items = await fetchFromOpenShift(endpoint);
    logger.info(`Fetched ${items.length} ${name} from OpenShift.`);

    if (!Array.isArray(items) || items.length === 0) {
      logger.warn(`No ${name} found to sync.`);
      return;
    }

    const bulkOps = items.map((item) => ({
      updateOne: {
        filter: { _id: item._id },
        update: { $set: item },
        upsert: true
      }
    }));

    // Process in batches of 500
    const batchSize = 500;
    let synced = 0;
    for (let i = 0; i < bulkOps.length; i += batchSize) {
      const batch = bulkOps.slice(i, i + batchSize);
      await model.bulkWrite(batch, { ordered: false });
      synced += batch.length;
      logger.info(`Synced ${synced}/${items.length} ${name}...`);
    }

    logger.info(`Successfully synced ${synced} ${name} into Cosmos DB.`);
  } catch (err) {
    logger.error(`Error syncing ${name}:`, { error: err.message });
  }
}

async function runSync() {
  logger.info('=== Starting OpenShift -> Azure Cosmos DB Sync ===');

  const shouldDisconnect = mongoose.connection.readyState !== 1;
  if (shouldDisconnect) {
    logger.info(`Connecting to Cosmos DB: ${config.mongoUri.replace(/:[^:@]+@/, ':***@')}`);
    await mongoose.connect(config.mongoUri);
  }

  logger.info('Connected to Cosmos DB. Syncing collections...');

  await syncCollection(Region, '/regions', 'regions');
  await syncCollection(Boundary, '/boundaries', 'boundaries');
  await syncCollection(Project, '/projects', 'projects');
  await syncCollection(Document, '/documents', 'documents');

  logger.info('=== Sync Completed Successfully! ===');
  if (shouldDisconnect) {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  runSync()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('Sync failed:', { error: err.message, stack: err.stack });
      process.exit(1);
    });
}

module.exports = { runSync };
