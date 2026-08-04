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

/**
 * The NoSQL database name, from a DEDICATED variable.
 *
 * It must NOT be `COSMOS_DATABASE`: the legacy Mongo-API client reads that same variable
 * (src/db/cosmos.js) and needs a DIFFERENT value — `epic` there, `demi` here. Both layers run
 * side by side until cutover, so one variable cannot serve both. Setting `COSMOS_DATABASE=demi`
 * for this client silently repointed the LIVE legacy app at the new, empty database: every
 * endpoint returned `[]` with HTTP 200, because queryContainer swallows the error.
 *
 * Same lesson as USE_COSMOS_NOSQL — never let one layer's config decide another layer's
 * behaviour. The default is correct for every environment, so it normally needs no setting.
 */
const DATABASE_ID = process.env.COSMOS_NOSQL_DATABASE || 'demi';

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
 * Cosmos system fields that are pure internals. Stripped before anything leaves this module.
 *
 * `_self` and `_rid` disclose the internal resource path (`dbs/…/colls/…/docs/…`), `_attachments`
 * and `_ts` are noise, and on a 60,578-document corpus they are dead weight in every response.
 *
 * `_etag` is deliberately KEPT: it is the optimistic-concurrency token that `replace()` takes, so
 * removing it would quietly make safe concurrent writes impossible.
 */
const INTERNAL_FIELDS = ['_rid', '_self', '_attachments', '_ts'];

function stripInternals(item) {
  if (!item || typeof item !== 'object') return item;
  for (const f of INTERNAL_FIELDS) delete item[f];
  return item;
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
    items: (response.resources || []).map(stripInternals),
    continuationToken: response.continuationToken,
    requestCharge: response.requestCharge || 0
  };
}

/**
 * How far Cosmos has got rebuilding a container's index, as a percentage.
 *
 * A query against a partially built index answers short rather than erroring, so every cutover
 * that lands rows in bulk has to wait on this. Permanent operational reading, not a debugging
 * aid — see the wiki's ADR-005.
 *
 * Returns null when the header is absent (the SDK only emits it with populateQuotaInfo, and only
 * for containers that have one).
 */
async function indexProgress(containerName) {
  const container = getContainer(containerName);
  if (!container) return null;

  const response = await container.read({ populateQuotaInfo: true });
  const raw = response.headers &&
    response.headers['x-ms-documentdb-collection-index-transformation-progress'];
  return raw === undefined || raw === null ? null : Number(raw);
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
    return resource ? stripInternals(resource) : null;
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
async function bulk(containerName, operations, opts = {}) {
  // Seam for the chunking tests, mirroring `bulkVerified`'s `bulkFn` rather than inventing a second
  // style. Without a Cosmos client `getContainer()` returns nothing and this returns [], so the
  // 100-operation split — the part that only misbehaves on large partitions — is otherwise
  // unreachable from a test.
  const container = opts.containerFn ? opts.containerFn(containerName) : getContainer(containerName);
  if (!container || !operations.length) return [];

  const results = [];
  for (let i = 0; i < operations.length; i += BULK_MAX_OPERATIONS) {
    const chunk = operations.slice(i, i + BULK_MAX_OPERATIONS);
    results.push(...await container.items.bulk(chunk));
  }
  return results;
}

/**
 * Bulk write that VERIFIES each operation and retries what Cosmos rejected.
 *
 * `bulk()` returns a per-operation status code and does not throw on a partial failure. Ignoring
 * that is how a seed silently under-writes: the first document seed reported 60,578 written while
 * only 56,317 landed, because the caller counted what it SENT. On serverless the usual cause is
 * 429 (throttling), which is retryable — so failures are retried with backoff rather than merely
 * counted.
 *
 * `requestCharge` is the RU actually billed, summed across every attempt — retries included, since
 * on serverless a retried operation is paid for twice and a figure that hid that would understate
 * the bill exactly when it matters. This is the only write path for chunks, so it is the one place
 * the number can be collected once for ingest, seeds and deletes alike.
 *
 * @returns {{succeeded: number, failed: number, statusCounts: object, requestCharge: number}}
 */
async function bulkVerified(containerName, operations, opts = {}) {
  const maxAttempts = opts.maxAttempts || 4;
  // Seam for the retry tests. Without a Cosmos client `bulk()` returns [] rather than throwing,
  // so there is otherwise no way to exercise the one path that matters here.
  const doBulk = opts.bulkFn || ((ops) => bulk(containerName, ops));
  const statusCounts = {};
  let pending = operations;
  let succeeded = 0;
  let requestCharge = 0;
  let lastThrown = null;

  for (let attempt = 1; attempt <= maxAttempts && pending.length > 0; attempt++) {
    let results;
    try {
      results = await doBulk(pending);
    } catch (err) {                                               // noqa: BLE001
      // The SDK THROWS when Cosmos rejects the whole request rather than individual operations.
      // A serverless 429 is the common case ("The request rate is too large") and it arrives with
      // no per-operation statuses at all, so the loop below never sees it. Before this, that
      // escaped the retry entirely and reached the caller as a hard failure — which is wrong for
      // precisely the status class this function exists to survive. Measured 2026-08-03 on the
      // streaming ingest, where one 30 MB document issues ~60 bulk calls back to back and dev's
      // serverless throughput cannot keep up.
      //
      // Treat it as "the whole attempt failed": `pending` is untouched, so the same operations are
      // retried. Recorded under `thrown` so the caller's error message still says what happened.
      statusCounts.thrown = (statusCounts.thrown || 0) + 1;
      lastThrown = err;
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 1000 * attempt));
      continue;
    }

    const retry = [];
    results.forEach((r, i) => {
      const code = r && r.statusCode;
      statusCounts[code] = (statusCounts[code] || 0) + 1;
      // Charged whatever the status: a rejected operation still costs RU, and a 429 costs it again
      // on the retry below.
      requestCharge += (r && Number(r.requestCharge)) || 0;
      if (code >= 200 && code < 300) succeeded++;
      else retry.push(pending[i]);
    });

    pending = retry;
    if (pending.length > 0 && attempt < maxAttempts) {
      // Linear backoff. 429 carries retryAfterInMs, but the bulk response does not surface it
      // per-operation reliably, so this stays simple and generous.
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }

  // Only when every attempt threw and nothing landed: the caller has no per-operation detail to
  // report, so surface the underlying error rather than a bare count it cannot act on.
  if (lastThrown && succeeded === 0 && pending.length === operations.length) {
    throw lastThrown;
  }

  return { succeeded, failed: pending.length, statusCounts, requestCharge };
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
  INTERNAL_FIELDS,
  stripInternals,
  BULK_MAX_OPERATIONS,
  initCosmosClient,
  getDatabase,
  getContainer,
  assertQuerySpec,
  query,
  indexProgress,
  queryValue,
  readItem,
  create,
  upsert,
  replace,
  patch,
  remove,
  bulk,
  bulkVerified,
  ping
};
