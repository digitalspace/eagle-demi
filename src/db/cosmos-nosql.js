'use strict';

/**
 * Callers pass a parameterised spec { query, parameters }, never a filter object or an interpolated
 * value. No Mongo-to-SQL translator: it fails open on $ne, $exists and $size, which visibility uses.
 */

const { CosmosClient } = require('@azure/cosmos');
const { logger } = require('../utils/logger');

let clientInstance = null;
let databaseInstance = null;

/**
 * Own variable, never `COSMOS_DATABASE`, which holds `epic` on the deployed app for another layer.
 * The default fits every environment.
 */
const DATABASE_ID = process.env.COSMOS_NOSQL_DATABASE || 'demi';

/**
 * One client per process: the SDK pools connections and caches metadata per instance.
 * Keyless managed-identity auth (disableLocalAuth); AZURE_CLIENT_ID picks the user-assigned identity.
 */
function initCosmosClient() {
  if (databaseInstance) return databaseInstance;

  const endpoint = process.env.COSMOS_ENDPOINT;
  if (!endpoint) {
    logger.warn('[Cosmos] COSMOS_ENDPOINT is not set; data access is unavailable.');
    return null;
  }

  try {
    // Required lazily so that merely importing this module does not pull in @azure/identity
    // in environments (tests) that never connect.
    const { createCredential } = require('../utils/azure-credential');

    clientInstance = new CosmosClient({ endpoint, aadCredentials: createCredential() });
    databaseInstance = clientInstance.database(DATABASE_ID);
    logger.info(`[Cosmos] Connected to database "${DATABASE_ID}" at ${endpoint}`);
    return databaseInstance;
  } catch (err) {
    logger.error(`[Cosmos] Client initialization failed: ${err.message}`);
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
 * Throws on anything but a parameterised spec: an unrunnable query must fail loud, never turn into
 * an unfiltered read.
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
 * Stripped before any item leaves this module; `_self` and `_rid` disclose the resource path.
 * `_etag` stays: it is the concurrency token the write functions take.
 */
const INTERNAL_FIELDS = ['_rid', '_self', '_attachments', '_ts'];

function stripInternals(item) {
  if (!item || typeof item !== 'object') return item;
  for (const f of INTERNAL_FIELDS) delete item[f];
  return item;
}

/**
 * @param {string} containerName
 * @param {{query: string, parameters: Array}} spec
 * @param {object} [options]
 * @param {string} [options.partitionKey]       one partition, no query-plan round trip
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
  if (options.maxItemCount) {
    feedOptions.maxItemCount = options.maxItemCount;
    // Without it a cross-partition ORDER BY drops the continuation token and every page is the
    // first. Single-partition queries ignore the flag.
    feedOptions.enableQueryControl = true;
  }
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
 * Fault stop, not a result limit: far past any lookup that will succeed, and it keeps a no-match
 * cross-partition query from walking every partition one page at a time.
 */
const LOOKUP_MAX_PAGES = 50;

/**
 * `err.code` when `queryFirst` runs out of pages. Callers act destructively on a null "not there",
 * so an early stop throws instead.
 */
const LOOKUP_BOUND_CODE = 'COSMOS_LOOKUP_BOUND';

/**
 * First row, from ONE iterator drained with fetchNext(): a cross-partition page can be empty while
 * the row exists, and a new iterator resumed from a continuation token stops at page one.
 *
 * @param {object} [options] as `query`, minus `maxItemCount` — the page size is fixed at 1
 * @returns {Promise<object|null>} null only when the iterator is exhausted
 * @throws {Error} `code === LOOKUP_BOUND_CODE` when the drain runs out of pages
 */
async function queryFirst(containerName, spec, options = {}) {
  assertQuerySpec(spec, containerName);

  const container = getContainer(containerName);
  if (!container) return null;

  const feedOptions = { maxItemCount: 1 };
  if (options.partitionKey !== undefined) feedOptions.partitionKey = options.partitionKey;
  if (options.continuationToken) feedOptions.continuationToken = options.continuationToken;

  const { rows, cut } = await drain(container.items.query(spec, feedOptions), 1, LOOKUP_MAX_PAGES);
  if (rows.length > 0) return rows[0];
  if (!cut) return null;

  logger.warn('[Cosmos] lookup ran out of pages before the iterator ran out of partitions.', {
    container: containerName, pages: LOOKUP_MAX_PAGES
  });
  throw Object.assign(
    new Error(`[Cosmos] lookup in "${containerName}" reached the ${LOOKUP_MAX_PAGES}-page bound ` +
      'with the iterator still holding results; "not found" would be a guess'),
    { code: LOOKUP_BOUND_CODE });
}

/**
 * `fetchNext()` on ONE iterator until it holds `want` rows or runs dry (see `queryFirst` for why one
 * iterator). `cut` is true when `maxFetches` stopped it with results still pending.
 */
async function drain(iterator, want, maxFetches) {
  const rows = [];
  for (let page = 0; rows.length < want && iterator.hasMoreResults(); page++) {
    if (page === maxFetches) return { rows, cut: true };
    const response = await iterator.fetchNext();
    for (const item of response.resources || []) rows.push(stripInternals(item));
  }
  return { rows, cut: false };
}

/**
 * Up to `size` rows from one drained iterator, bounded at LOOKUP_MAX_PAGES fetches plus one per `size` of `skip`
 * (the SDK's OFFSET stage empties skipped fetches). A cut drain answers short, or null under `whole`.
 */
async function queryPage(containerName, spec, { size, skip = 0, whole = false } = {}) {
  assertQuerySpec(spec, containerName);
  if (!(Number.isInteger(size) && size > 0)) throw new Error('[Cosmos] queryPage needs a positive size');

  const container = getContainer(containerName);
  if (!container) return [];

  const maxFetches = LOOKUP_MAX_PAGES + Math.ceil(Math.max(Number(skip) || 0, 0) / size);
  const { rows, cut } = await drain(container.items.query(spec, { maxItemCount: size }), size, maxFetches);
  if (cut) {
    logger.warn('[Cosmos] page drain hit its fetch bound; answering a short page.', {
      container: containerName, pages: maxFetches, rows: rows.length, size, skip
    });
    if (whole) return null;
  }
  return rows.slice(0, size);
}

/**
 * Index rebuild progress in percent, or null without the header. A query on a partial index answers
 * short without an error, so any bulk cutover waits on this.
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
 * Point read, null on 404. It skips the query predicate, so callers MUST gate the result with
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
 * Upsert REPLACES the whole item, it does not merge: use patch() for partial updates. `etag` lands
 * it only on the revision the caller read, else 412; an upsert has no other concurrency guard.
 *
 * @param {{etag?: string}} [options]
 */
async function upsert(containerName, item, { etag } = {}) {
  const container = getContainer(containerName);
  if (!container) return null;
  const options = etag ? { accessCondition: { type: 'IfMatch', condition: etag } } : {};
  const { resource } = await container.items.upsert(item, options);
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

/** Cosmos rejects a patch with more than this many operations. Exported so a caller that turns
 * request keys into operations can refuse the request instead of failing at the data layer. */
const PATCH_MAX_OPERATIONS = 10;

/**
 * Atomic partial update. `condition` (`FROM c WHERE c.n < 3`) tests stored values on the server and
 * `etag` tests the revision the caller read; either failing throws 412 and nothing is applied.
 *
 * @param {Array<{op: string, path: string, value: any}>} operations
 * @param {string} [condition]
 * @param {string} [etag] the `_etag` of the item the caller read
 */
async function patch(containerName, id, partitionKey, operations, condition, etag) {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new TypeError('[Cosmos] patch() requires a non-empty operations array.');
  }
  if (operations.length > PATCH_MAX_OPERATIONS) {
    throw new RangeError(
      `[Cosmos] patch() supports at most ${PATCH_MAX_OPERATIONS} operations, got ${operations.length}.`
    );
  }
  const container = getContainer(containerName);
  if (!container) return null;
  const body = condition ? { operations, condition } : operations;
  const options = etag ? { accessCondition: { type: 'IfMatch', condition: etag } } : {};
  const { resource } = await container.item(String(id), partitionKey).patch(body, options);
  return resource;
}

/** `etag` guards the delete like patch's: it lands only on the revision the caller read, else 412. */
async function remove(containerName, id, partitionKey, { etag } = {}) {
  const container = getContainer(containerName);
  if (!container) return false;
  const options = etag ? { accessCondition: { type: 'IfMatch', condition: etag } } : {};
  try {
    await container.item(String(id), partitionKey).delete(options);
    return true;
  } catch (err) {
    if (err.code === 404) return false;
    throw err;
  }
}

/**
 * Cosmos limit per bulk request. Chunked here, not per caller: a caller that forgot would fail only
 * on large partitions (8,000+ documents), so in production and never in a test.
 */
const BULK_MAX_OPERATIONS = 100;

/** A failed etag or patch condition: a final answer, so a retry only repeats the rejection. */
const PRECONDITION_FAILED = 412;

/**
 * Small because ingest and the ACL cascade run inside `/api` requests that APIM cuts at 30s: four
 * doubling attempts wait about 7s. Offline walks raise it with `opts.maxAttempts`.
 */
const BULK_MAX_ATTEMPTS = 4;
const BULK_MAX_BACKOFF_MS = 20000;
const BULK_BACKOFF_JITTER_MS = 250;

/**
 * Doubling, as serverless throttles last minutes; a larger Cosmos hint wins. The cap bounds both for
 * callers behind APIM (offline walks raise `opts.maxBackoffMs`); jitter stops lockstep resends.
 */
function bulkBackoffMs(attempt, hintMs, maxBackoffMs = BULK_MAX_BACKOFF_MS) {
  const hint = Number.isFinite(hintMs) && hintMs > 0 ? hintMs : 0;
  const exponential = 1000 * 2 ** (attempt - 1);
  return Math.min(Math.max(exponential, hint), maxBackoffMs)
    + Math.round(Math.random() * BULK_BACKOFF_JITTER_MS);
}

/**
 * The retry hint on a per-operation result. The bulk response does not carry it as dependably as a
 * thrown `ErrorResponse.retryAfterInMs` does, so it is used when present and ignored otherwise.
 */
function operationRetryAfterMs(r) {
  if (!r) return 0;
  const hint = r.retryAfterMilliseconds ?? r.retryAfter;
  return Number.isFinite(hint) ? hint : 0;
}

/**
 * All operations target ONE partition key value; results are one per input, in input order. Ops go
 * to the SDK verbatim, so a Patch may carry `resourceBody: {operations, condition}` as patch() does.
 */
async function bulk(containerName, operations, opts = {}) {
  // Test seam: without a Cosmos client this returns [], so the 100-operation split is unreachable.
  const container = opts.containerFn ? opts.containerFn(containerName) : getContainer(containerName);
  if (!container || !operations.length) return [];

  const results = [];
  for (let i = 0; i < operations.length; i += BULK_MAX_OPERATIONS) {
    const chunk = operations.slice(i, i + BULK_MAX_OPERATIONS);
    results.push(...await container.items.bulk(chunk));
  }
  return results;
}

/** Upsert and Create carry their id only in `resourceBody`. */
function operationId(op) {
  return op.id ?? (op.resourceBody && op.resourceBody.id) ?? (op.resource && op.resource.id);
}

/**
 * bulk() does not throw on partial failure, so this checks each status and retries failures (mostly
 * 429). A 412 is never retried and lands in `skippedIds`; `requestCharge` sums every attempt.
 *
 * @returns {{succeeded: number, failed: number, statusCounts: object, requestCharge: number, failedIds: string[], skippedIds: string[]}}
 */
async function bulkVerified(containerName, operations, opts = {}) {
  const maxAttempts = opts.maxAttempts || BULK_MAX_ATTEMPTS;
  const maxBackoffMs = opts.maxBackoffMs || BULK_MAX_BACKOFF_MS;
  // Seam for the retry tests. Without a Cosmos client `bulk()` returns [] rather than throwing,
  // so there is otherwise no way to exercise the one path that matters here.
  const doBulk = opts.bulkFn || ((ops) => bulk(containerName, ops));
  // Same seam for the wait, so a test can assert the delay without spending it.
  const sleep = opts.sleepFn || ((ms) => new Promise(r => setTimeout(r, ms)));
  const statusCounts = {};
  let pending = operations;
  let succeeded = 0;
  let requestCharge = 0;
  const skipped = [];
  let lastThrown = null;

  for (let attempt = 1; attempt <= maxAttempts && pending.length > 0; attempt++) {
    let results;
    try {
      results = await doBulk(pending);
    } catch (err) {
      // A whole-request rejection (often a serverless 429) throws with no per-operation statuses:
      // count it under `thrown` and retry the same `pending`.
      statusCounts.thrown = (statusCounts.thrown || 0) + 1;
      lastThrown = err;
      if (attempt < maxAttempts) {
        await sleep(bulkBackoffMs(attempt, err && err.retryAfterInMs, maxBackoffMs));
      }
      continue;
    }

    const retry = [];
    let retryAfterMs = 0;
    // Driven by what was SENT: an operation missing from a short response counts as a failure.
    const answered = Array.isArray(results) ? results : [];
    pending.forEach((op, i) => {
      const r = answered[i];
      const code = r && r.statusCode;
      const bucket = i < answered.length ? code : 'unanswered';
      statusCounts[bucket] = (statusCounts[bucket] || 0) + 1;
      // Charged whatever the status: a rejected operation still costs RU, and a 429 costs it again
      // on the retry below.
      requestCharge += (r && Number(r.requestCharge)) || 0;
      if (code >= 200 && code < 300) succeeded++;
      else if (code === PRECONDITION_FAILED) skipped.push(op);
      else {
        retry.push(op);
        // The longest hint in the batch, because the wait has to clear the slowest of them.
        retryAfterMs = Math.max(retryAfterMs, operationRetryAfterMs(r));
      }
    });

    pending = retry;
    if (pending.length > 0 && attempt < maxAttempts) {
      await sleep(bulkBackoffMs(attempt, retryAfterMs, maxBackoffMs));
    }
  }

  // Only when every attempt threw and nothing landed: the caller has no per-operation detail to
  // report, so surface the underlying error rather than a bare count it cannot act on.
  if (lastThrown && succeeded === 0 && pending.length === operations.length) {
    throw lastThrown;
  }

  // `skippedIds` failed their own precondition: not written, not lost, so they need no repair.
  return {
    succeeded, failed: pending.length, statusCounts, requestCharge,
    failedIds: pending.map(operationId), skippedIds: skipped.map(operationId)
  };
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
  PATCH_MAX_OPERATIONS,
  LOOKUP_MAX_PAGES,
  LOOKUP_BOUND_CODE,
  initCosmosClient,
  getDatabase,
  getContainer,
  assertQuerySpec,
  query,
  queryFirst,
  queryPage,
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
