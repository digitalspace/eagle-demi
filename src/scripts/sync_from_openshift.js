'use strict';

const { initCosmosClient } = require('../db/cosmos');
const { logger } = require('../utils/logger');

// Load Repository Models
const Project = require('../models/project');
const Document = require('../models/document');
const Region = require('../models/region');

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

async function syncCollection(Model, endpoint, name) {
  try {
    const items = await fetchFromOpenShift(endpoint);
    logger.info(`Fetched ${items.length} ${name} from OpenShift.`);

    if (!Array.isArray(items) || items.length === 0) {
      logger.warn(`No ${name} found to sync.`);
      return;
    }

    let synced = 0;
    for (const item of items) {
      await Model.upsert(item);
      synced++;
      if (synced % 100 === 0) {
        logger.info(`Synced ${synced}/${items.length} ${name}...`);
      }
    }

    logger.info(`Successfully synced ${synced} ${name} into Cosmos DB.`);
  } catch (err) {
    logger.error(`Error syncing ${name}:`, { error: err.message });
  }
}

async function runSync() {
  logger.info('=== Starting OpenShift -> Azure Cosmos DB Sync ===');
  await initCosmosClient();

  await syncCollection(Region, '/regions', 'regions');
  try {
    const { seedBoundaries } = require('./seed-boundaries');
    await seedBoundaries();
  } catch (err) {
    logger.error('Error seeding boundaries from OpenMaps WFS:', { error: err.message });
  }
  await syncCollection(Project, '/projects', 'projects');
  await syncCollection(Document, '/documents', 'documents');

  logger.info('=== Sync Completed Successfully! ===');
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
