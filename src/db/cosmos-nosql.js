'use strict';

/**
 * Cosmos DB for NoSQL data access. Thin, parameterised, and fail-closed.
 *
 * Replaces src/db/cosmos.js (MongoDB driver) during the migration; both exist until cutover.
 *
 * DESIGN: callers pass a query SPEC — { query: string, parameters: [] } — not a filter object.
 *
 * There is deliberately no Mongo→SQL translator. One that handles 90% of operators fails
 * OPEN on the rest, and the operators where the two disagree ($ne, $exists, $size) are
 * exactly what the visibility predicate is built from. This repo already shipped that bug:
 * a substring "translator" turned `WHERE c.isPublished = true` into `{}` and served every
 * collection to anonymous callers. There are ~12 distinct query shapes in the whole
 * application — that is twelve functions, not a translator.
 *
 * No caller value is ever interpolated into SQL. Parameters only.
 */

const { CosmosClient } = require('@azure/cosmos');

let clientInstance = null;
let databaseInstance = null;

const DATABASE_ID = process.env.COSMOS_DATABASE || 'demi';

/**
 * Singleton client. The SDK pools connections and caches metadata per instance, so creating
 * one per request is a documented performance mistake.
 *
 * Auth is Microsoft Entra via managed identity — the account has disableLocalAuth set, so
 * there is no key to configure or leak. AZURE_CLIENT_ID selects the user-assigned identity.
 */
function initCosmosClient() {
  if (databaseInstance) return databaseInstance;

  const endpoint = process.env.COSMOS_ENDPOINT;
  if (!endpoint) {
    console.warn('[Cosmos] COSMOS_ENDPOINT is not set; data access is unavailable.');
    return null;
  }

  try {
    // Required lazily so that merely importing this module does not pull in @azure/identity
    // in environments (tests) that never connect.
    const { DefaultAzureCredential } = require('@azure/identity');
    const credentialOptions = process.env.AZURE_CLIENT_ID
      ? { managedIdentityClientId: process.env.AZURE_CLIENT_ID }
      : undefined;

    clientInstance = new CosmosClient({
      endpoint,
      aadCredentials: new DefaultAzureCredential(credentialOptions)
    });
    databaseInstance = clientInstance.database(DATABASE_ID);
    console.log(`[Cosmos] Connected to database "${DATABASE_ID}" at ${endpoint}`);
    return databaseInstance;
  } catch (err) {
    console.error('[Cosmos] Client initialization failed:', err.message);
    return null;
  }
}

function getDatabase() {
  return databaseInstance || initCosmosClient();
}

function getContainer(containerName) {
  const db = getDatabase();
  if (!db) return null;
  return db.container(containerName);
}

/**
 * Reject anything that is not a proper parameterised query spec.
 *
 * Deliberately strict, and deliberately throws rather than returning empty: an unrunnable
 * query must be a loud programmer error, never a silent unfiltered read. This is the guard
 * the previous implementation lacked.
 */
function assertQuerySpec(spec, containerName) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError(
      `[Cosmos] Refusing to query "${containerName}": expected a query spec object, got ${
        Array.isArray(spec) ? 'array' : typeof spec
      }.`
    );
  }
  if (typeof spec.query !== 'string' || spec.query.trim() === '') {
    throw new TypeError(
      `[Cosmos] Refusing to query "${containerName}": spec.query must be a non-empty string.`
    );
  }
  if (!Array.isArray(spec.parameters)) {
    throw new TypeError(
      `[Cosmos] Refusing to query "${containerName}": spec.parameters must be an array ` +
      '(use [] when the query takes none).'
    );
  }
  for (const p of spec.parameters) {
    if (!p || typeof p.name !== 'string' || !p.name.startsWith('@')) {
      throw new TypeError(
        `[Cosmos] Refusing to query "${containerName}": every parameter needs a name ` +
        'beginning with "@".'
      );
    }
  }
  return spec;
}

/**
 * Run a query.
 *
 * @param {string} containerName
 * @param {{query: string, parameters: Array}} spec
 * @param {object} [options]
 * @param {string} [options.partitionKey]       scope to one partition — avoids a query-plan
 *                                              round trip and fans out to nothing else
 * @param {number} [options.maxItemCount]       page size
 * @param {string} [options.continuationToken]  resume a previous page
 * @returns {Promise<{items: Array, continuationToken: string|undefined, requestCharge: number}>}
 */
async function query(containerName, spec, options = {}) {
  assertQuerySpec(spec, containerName);

  const container = getContainer(containerName);
  if (!container) return { items: [], continuationToken: undefined, requestCharge: 0 };

  const feedOptions = {};
  if (options.partitionKey !== undefined) feedOptions.partitionKey = options.partitionKey;
  if (options.maxItemCount) feedOptions.maxItemCount = options.maxItemCount;
  if (options.continuationToken) feedOptions.continuationToken = options.continuationToken;

  const iterator = container.items.query(spec, feedOptions);
  const response = options.maxItemCount
    ? await iterator.fetchNext()
    : await iterator.fetchAll();

  return {
    items: response.resources || [],
    continuationToken: response.continuationToken,
    requestCharge: response.requestCharge || 0
  };
}

/**
 * Query returning a single scalar, e.g. SELECT VALUE COUNT(1).
 * Counts must use the SAME predicate as the read, or totals leak hidden rows.
 */
async function queryValue(containerName, spec, options = {}) {
  const { items } = await query(containerName, spec, options);
  return items.length > 0 ? items[0] : null;
}

/**
 * Point read. Requires the partition key — that is the API, not an inconvenience.
 * Returns null on 404 rather than throwing.
 *
 * A point read bypasses the query predicate entirely, so callers MUST gate the result with
 * canRead() from helpers/access-sql.
 */
async function readItem(containerName, id, partitionKey) {
  const container = getContainer(containerName);
  if (!container) return null;

  try {
    const { resource } = await container.item(String(id), partitionKey).read();
    return resource || null;
  } catch (err) {
    if (err.code === 404) return null;
    throw err;
  }
}

async function create(containerName, item) {
  const container = getContainer(containerName);
  if (!container) return null;
  const { resource } = await container.items.create(item);
  return resource;
}

/**
 * Whole-item write. Cosmos upsert REPLACES the item — it does not merge like Mongo's $set.
 * Use patch() for partial updates, or a field written by one path will be erased by another.
 */
async function upsert(containerName, item) {
  const container = getContainer(containerName);
  if (!container) return null;
  const { resource } = await container.items.upsert(item);
  return resource;
}

/**
 * Replace with optimistic concurrency. Passing the item's _etag makes a concurrent write
 * fail with 412 instead of silently losing an update.
 */
async function replace(containerName, id, partitionKey, item, etag) {
  const container = getContainer(containerName);
  if (!container) return null;
  const options = etag ? { accessCondition: { type: 'IfMatch', condition: etag } } : {};
  const { resource } = await container.item(String(id), partitionKey).replace(item, options);
  return resource;
}

/**
 * Partial update — atomic, no read-modify-write, and it cannot erase fields it does not name.
 * Cosmos caps a patch at 10 operations.
 *
 * @param {Array<{op: string, path: string, value: any}>} operations
 */
async function patch(containerName, id, partitionKey, operations) {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new TypeError('[Cosmos] patch() requires a non-empty operations array.');
  }
  if (operations.length > 10) {
    throw new RangeError(
      `[Cosmos] patch() supports at most 10 operations, got ${operations.length}.`
    );
  }
  const container = getContainer(containerName);
  if (!container) return null;
  const { resource } = await container.item(String(id), partitionKey).patch(operations);
  return resource;
}

async function remove(containerName, id, partitionKey) {
  const container = getContainer(containerName);
  if (!container) return false;
  try {
    await container.item(String(id), partitionKey).delete();
    return true;
  } catch (err) {
    if (err.code === 404) return false;
    throw err;
  }
}

/**
 * Cosmos rejects a bulk request with more than 100 operations. Chunking is done HERE rather than
 * at each call site because the seeder handles a project with 8,000+ documents in one partition —
 * a caller that forgot would fail only on the large projects, i.e. in production and not in a
 * test.
 */
const BULK_MAX_OPERATIONS = 100;

/**
 * Bulk write. All operations must target the SAME partition key value.
 *
 * Splits into 100-operation requests and concatenates the responses, so the return value has one
 * entry per input operation in input order regardless of how it was chunked.
 */
async function bulk(containerName, operations) {
  const container = getContainer(containerName);
  if (!container || !operations.length) return [];

  const results = [];
  for (let i = 0; i < operations.length; i += BULK_MAX_OPERATIONS) {
    const chunk = operations.slice(i, i + BULK_MAX_OPERATIONS);
    results.push(...await container.items.bulk(chunk));
  }
  return results;
}

/**
 * Readiness probe. Cheap metadata read that proves both the endpoint and the credential work.
 */
async function ping() {
  const db = getDatabase();
  if (!db) return false;
  await db.read();
  return true;
}

module.exports = {
  DATABASE_ID,
  BULK_MAX_OPERATIONS,
  initCosmosClient,
  getDatabase,
  getContainer,
  assertQuerySpec,
  query,
  queryValue,
  readItem,
  create,
  upsert,
  replace,
  patch,
  remove,
  bulk,
  ping
};
