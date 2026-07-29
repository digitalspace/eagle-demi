'use strict';

const { MongoClient, ObjectId } = require('mongodb');
const config = require('../config');

let mongoClientInstance = null;
let mongoDbInstance = null;

const DATABASE_ID = process.env.COSMOS_DATABASE || process.env.COSMOSDB_DATABASE || process.env.MONGODB_DATABASE || config.cosmosDatabaseName || 'epic';

/**
 * Initialize Cosmos DB Client Singleton (Cosmos DB MongoDB API)
 */
function initCosmosClient() {
  if (mongoDbInstance) return mongoDbInstance;

  const connectionString = process.env.COSMOS_CONNECTION_STRING || process.env.COSMOSDB_CONNECTION_STRING || process.env.MONGODB_URI;

  if (!connectionString) {
    console.warn('[CosmosDB] No connection string provided in COSMOS_CONNECTION_STRING or MONGODB_URI');
    return null;
  }

  try {
    mongoClientInstance = new MongoClient(connectionString, {
      tls: true,
      retryWrites: false
    });
    mongoDbInstance = mongoClientInstance.db(DATABASE_ID);
    console.log(`[CosmosDB] Initialized CosmosClient connected to database: "${DATABASE_ID}"`);
    return mongoDbInstance;
  } catch (err) {
    console.error(`[CosmosDB] CosmosClient initialization failed:`, err.message);
    return null;
  }
}

/**
 * Get active Database instance
 */
function getDatabase() {
  if (!mongoDbInstance) {
    initCosmosClient();
  }
  return mongoDbInstance;
}

/**
 * Get Container handle
 */
function getContainer(containerName) {
  const db = getDatabase();
  return db ? db.collection(containerName) : null;
}

/**
 * Helper to ensure database containers exist
 */
async function initContainers() {
  // No-op for Cosmos DB MongoDB API
}

/**
 * Execute Query on a container/collection
 */
/**
 * Reject anything that isn't a plain MongoDB filter object.
 *
 * This used to accept a Cosmos-SQL-ish string and "translate" it by substring matching,
 * silently dropping every predicate it didn't recognise — so `WHERE c.isPublished = true`
 * became `{}` and every caller leaked its whole collection. Fail closed instead: an
 * untranslatable filter must be a loud error, never an unfiltered read.
 */
function assertMongoFilter(filter, containerName) {
  if (filter === undefined || filter === null) return {};
  if (typeof filter !== 'object' || Array.isArray(filter)) {
    throw new TypeError(
      `[CosmosDB] Refusing to query "${containerName}" with a non-object filter ` +
      `(${typeof filter}). Pass a MongoDB filter object, not a SQL string.`
    );
  }
  return filter;
}

async function queryContainer(containerName, filter, options = {}) {
  const safeFilter = assertMongoFilter(filter, containerName);
  try {
    initCosmosClient();
    const col = getContainer(containerName);
    if (!col) return [];

    let cursor = col.find(safeFilter);

    const limit = options.maxItemCount || options.limit || 0;
    if (limit > 0) {
      cursor = cursor.limit(limit);
    }
    const results = (await cursor.toArray()) || [];

    // Sort in memory, NOT via cursor.sort(). Cosmos DB's MongoDB API rejects a sort on any
    // field without a supporting index, and that rejection surfaces as a query error —
    // which this function would swallow into an empty result set, silently blanking the
    // page. Result sets are capped by `limit` above, so this stays cheap.
    // ponytail: in-memory sort applies after the limit; add a Cosmos index and move the
    // sort back into the query if a collection ever needs true global ordering.
    if (options.sort) {
      const [field, direction] = Object.entries(options.sort)[0] || [];
      if (field) {
        const dir = direction === -1 ? -1 : 1;
        results.sort((a, b) => {
          const av = a ? a[field] : undefined;
          const bv = b ? b[field] : undefined;
          if (av === bv) return 0;
          if (av === undefined || av === null) return 1;
          if (bv === undefined || bv === null) return -1;
          return (av < bv ? -1 : 1) * dir;
        });
      }
    }

    return results;
  } catch (err) {
    console.error(`[CosmosDB] Query container "${containerName}" failed:`, err.message);
    return [];
  }
}

/**
 * Read point item by _id
 */
async function getItem(containerName, id, partitionKey = id) {
  try {
    initCosmosClient();
    const col = getContainer(containerName);
    if (!col) return null;

    const strId = String(id);
    const numId = Number(id);
    // Records imported from EPIC keep genuine ObjectId _ids, while DEMI-created records use
    // string _ids. Matching only the string form made every imported document unreachable
    // by id — /documents/:id and the download endpoint both 404'd on real data.
    const filter = {
      $or: [
        { _id: strId },
        { id: strId },
        ...(ObjectId.isValid(strId) ? [{ _id: new ObjectId(strId) }] : []),
        ...(isNaN(numId) ? [] : [{ trackProjectId: numId }])
      ]
    };
    const resource = await col.findOne(filter);
    return resource || null;
  } catch (err) {
    console.error(`[CosmosDB] getItem "${containerName}/${id}" failed:`, err.message);
    return null;
  }
}

/**
 * Upsert an item into container
 */
async function upsertItem(containerName, item) {
  try {
    if (!item.id && item._id) {
      item.id = String(item._id);
    } else if (!item._id && item.id) {
      item._id = String(item.id);
    }

    initCosmosClient();
    const col = getContainer(containerName);
    if (!col) throw new Error('CosmosDB container handle unavailable');

    await col.updateOne(
      { _id: item._id },
      { $set: item },
      { upsert: true }
    );
    return item;
  } catch (err) {
    console.error(`[CosmosDB] upsertItem "${containerName}" failed:`, err.message);
    throw err;
  }
}

/**
 * Delete an item by _id
 */
async function deleteItem(containerName, id, partitionKey = id) {
  try {
    initCosmosClient();
    const col = getContainer(containerName);
    if (!col) return false;

    const strId = String(id);
    const res = await col.deleteOne({ $or: [{ _id: strId }, { id: strId }] });
    return res.deletedCount > 0;
  } catch (err) {
    console.error(`[CosmosDB] deleteItem "${containerName}/${id}" failed:`, err.message);
    return false;
  }
}

/**
 * Count items in container
 */
async function countContainer(containerName, filter) {
  // Counts must honour the SAME filter as the read, or pagination totals leak the true
  // size of a collection the caller is not allowed to see.
  const safeFilter = assertMongoFilter(filter, containerName);
  try {
    initCosmosClient();
    const col = getContainer(containerName);
    if (!col) return 0;

    return await col.countDocuments(safeFilter);
  } catch (err) {
    console.error(`[CosmosDB] countContainer "${containerName}" failed:`, err.message);
    return 0;
  }
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
