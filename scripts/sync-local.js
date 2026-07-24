'use strict';

const { execSync } = require('child_process');
const mongoose = require('mongoose');

// Load Mongoose Models
const Project = require('../src/models/project');
const Document = require('../src/models/document');
const Region = require('../src/models/region');
const Boundary = require('../src/models/boundary');

const OPENSHIFT_API_URL = process.env.OPENSHIFT_API_URL || 'https://eagle-demi-api-6cdc9e-dev.apps.silver.devops.gov.bc.ca/api';

async function getCosmosUri() {
  if (process.env.MONGODB_URI) {
    return process.env.MONGODB_URI;
  }
  console.log('Retrieving Cosmos DB connection string via Azure CLI...');
  const uri = execSync(
    'az cosmosdb keys list --name demi-mongo-dev-pcbd7cygyic52 --resource-group c4b0a8-dev-rg --type connection-strings --query "connectionStrings[0].connectionString" -o tsv',
    { encoding: 'utf8' }
  ).trim();
  return uri;
}

async function fetchFromOpenShift(endpoint) {
  const url = `${OPENSHIFT_API_URL}${endpoint}`;
  console.log(`[GET] ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return await response.json();
}

async function syncCollection(model, endpoint, name) {
  try {
    const items = await fetchFromOpenShift(endpoint);
    console.log(` fetched ${items.length} ${name} from OpenShift.`);

    if (!Array.isArray(items) || items.length === 0) {
      console.log(`⚠️ No ${name} found to sync.`);
      return;
    }

    const bulkOps = items.map((item) => ({
      updateOne: {
        filter: { _id: item._id },
        update: { $set: item },
        upsert: true
      }
    }));

    const batchSize = 500;
    let synced = 0;
    for (let i = 0; i < bulkOps.length; i += batchSize) {
      const batch = bulkOps.slice(i, i + batchSize);
      await model.bulkWrite(batch, { ordered: false });
      synced += batch.length;
      console.log(` Synced ${synced}/${items.length} ${name}...`);
    }

    console.log(` Successfully synced ${synced} ${name} into Cosmos DB!\n`);
  } catch (err) {
    console.error(`❌ Error syncing ${name}: ${err.message}`);
  }
}

async function runLocalSync() {
  console.log('=== Local OpenShift -> Azure Cosmos DB Sync ===\n');

  const cosmosUri = await getCosmosUri();
  console.log('Connecting to Azure Cosmos DB...');
  await mongoose.connect(cosmosUri);
  console.log(' Connected to Azure Cosmos DB!\n');

  await syncCollection(Region, '/regions', 'regions');
  await syncCollection(Boundary, '/boundaries', 'boundaries');
  await syncCollection(Project, '/projects', 'projects');
  await syncCollection(Document, '/documents', 'documents');

  console.log('=== All Collections Synced Successfully! ===');
  await mongoose.disconnect();
}

if (require.main === module) {
  runLocalSync()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Sync failed:', err);
      process.exit(1);
    });
}

module.exports = { runLocalSync };
