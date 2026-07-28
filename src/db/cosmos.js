'use strict';

const { CosmosClient } = require('@azure/cosmos');
const config = require('../config');

let clientInstance = null;
let databaseInstance = null;

const DATABASE_ID = process.env.COSMOS_DATABASE || process.env.COSMOSDB_DATABASE || config.cosmosDatabaseName || 'epic';

/**
 * Initialize Cosmos DB Client Singleton
 */
function initCosmosClient() {
  if (clientInstance) return clientInstance;

  const endpoint = process.env.COSMOS_ENDPOINT || process.env.COSMOSDB_ENDPOINT;
  const key = process.env.COSMOS_KEY || process.env.COSMOSDB_KEY;
  const connectionString = process.env.COSMOS_CONNECTION_STRING || process.env.COSMOSDB_CONNECTION_STRING;

  if (connectionString) {
    clientInstance = new CosmosClient(connectionString);
  } else if (endpoint && key) {
    clientInstance = new CosmosClient({ endpoint, key });
  } else {
    // Mock / Local fallback mode
    clientInstance = new CosmosClient({ endpoint: 'https://localhost:8081', key: 'C2y6yDtfR2UXvbjNCv2gXSe4E4y59HUE8PdGpY3iT4A=' });
  }

  databaseInstance = clientInstance.database(DATABASE_ID);
  console.log(`[CosmosDB] Initialized CosmosClient connected to database: "${DATABASE_ID}"`);
  return clientInstance;
}

/**
 * Get active Database instance
 */
function getDatabase() {
  if (!databaseInstance) {
    initCosmosClient();
  }
  return databaseInstance;
}

/**
 * Get Container handle
 */
function getContainer(containerName) {
  const db = getDatabase();
  return db.container(containerName);
}

/**
 * Helper to ensure database and core containers exist
 */
async function initContainers() {
  const db = getDatabase();
  const containers = ['projects', 'documents', 'records', 'boundaries', 'regions', 'wildfires', 'logs'];
  
  for (const cName of containers) {
    try {
      await db.containers.createIfNotExists({ id: cName, partitionKey: '/_id' });
    } catch (err) {
      console.warn(`[CosmosDB] Warning initializing container ${cName}:`, err.message);
    }
  }
}

/**
 * Execute SQL Query on a container
 */
async function queryContainer(containerName, querySpec, options = {}) {
  const container = getContainer(containerName);
  const { resources } = await container.items.query(querySpec, options).fetchAll();
  return resources;
}

/**
 * Read point item by _id
 */
async function getItem(containerName, id, partitionKey = id) {
  try {
    const container = getContainer(containerName);
    const { resource } = await container.item(String(id), String(partitionKey)).read();
    return resource || null;
  } catch (err) {
    if (err.code === 404) return null;
    throw err;
  }
}

/**
 * Upsert an item into container
 */
async function upsertItem(containerName, item) {
  const container = getContainer(containerName);
  if (!item.id && item._id) {
    item.id = String(item._id);
  } else if (!item._id && item.id) {
    item._id = item.id;
  }
  const { resource } = await container.items.upsert(item);
  return resource;
}

/**
 * Delete an item by _id
 */
async function deleteItem(containerName, id, partitionKey = id) {
  try {
    const container = getContainer(containerName);
    await container.item(String(id), String(partitionKey)).delete();
    return true;
  } catch (err) {
    if (err.code === 404) return false;
    throw err;
  }
}

/**
 * Count items in container
 */
async function countContainer(containerName, whereClause = '', parameters = []) {
  const queryText = `SELECT VALUE COUNT(1) FROM c ${whereClause ? 'WHERE ' + whereClause : ''}`;
  const querySpec = { query: queryText, parameters };
  const container = getContainer(containerName);
  const { resources } = await container.items.query(querySpec).fetchAll();
  return resources && resources.length > 0 ? resources[0] : 0;
}

module.exports = {
  initCosmosClient,
  getDatabase,
  getContainer,
  initContainers,
  queryContainer,
  getItem,
  upsertItem,
  deleteItem,
  countContainer
};
