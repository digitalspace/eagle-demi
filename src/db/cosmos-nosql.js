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
 * Upper bound on pages drained for a ranked query. Generous — a ranked query fans out one page
 * per physical partition and then stops — but it MUST exist. See queryRanked.
 */
const RANKED_MAX_PAGES = 50;

/**
 * Wall-clock ceiling for one ranked query, across every page.
 *
 * The page cap alone is NOT a bound on time: 50 pages that each take seconds is minutes, and on a
 * single-worker B1 plan a request that runs for minutes takes every other endpoint down with it —
 * measured, `/api/config` went dark alongside search. The spike measured healthy ranked queries at
 * 182-964ms, so 5s is far outside normal and still well inside any client timeout.
 */
const RANKED_TIMEOUT_MS = Number(process.env.COSMOS_RANKED_TIMEOUT_MS) || 5000;

/**
 * Run an `ORDER BY RANK` query. Ranked queries need their own entry point because BOTH of the
 * ordinary ways of reading a feed are broken for them, in opposite directions:
 *
 *   fetchNext() once  — returns EMPTY early pages with hasMoreResults still true, so a caller
 *                       that reads one page gets zero rows for a query that has matches.
 *   fetchAll()        — drains until hasMoreResults goes false, and for a ranked query that
 *                       matches NOTHING against a non-empty container that never happens. It
 *                       spins, pegs the single core, and the app stops answering entirely
 *                       WITHOUT the process exiting: measured on demi-api-dev, one such query
 *                       made every endpoint unreachable for ~6 minutes with no crash, no restart
 *                       and nothing in the logs.
 *
 * So: drain explicitly, and bound the drain. The page cap is the actual safety property here —
 * it converts a hang into a short result, which is a bug you can see rather than an outage.
 *
 * Returns TOP-N. There is no continuation token: ranked queries cannot page by one.
 */
async function queryRanked(containerName, spec, options = {}) {
  assertQuerySpec(spec, containerName);

  const container = getContainer(containerName);
  if (!container) return { items: [], requestCharge: 0, pages: 0, truncated: false };

  const top = Math.max(1, Number(options.top) || 1);
  const maxPages = Number(options.maxPages) || RANKED_MAX_PAGES;
  const timeoutMs = Number(options.timeoutMs) || RANKED_TIMEOUT_MS;

  const feedOptions = { maxItemCount: top };
  if (options.partitionKey !== undefined) feedOptions.partitionKey = options.partitionKey;

  // TWO bounds, because they stop different things. The deadline below cannot interrupt a single
  // fetchNext() that never returns — only the abort signal can. The abort signal in turn does not
  // stop a fast-but-endless sequence of pages — only the deadline and the page cap do.
  const abort = AbortSignal.timeout(timeoutMs);
  feedOptions.abortSignal = abort;

  let result;
  try {
    result = await drainRanked(container.items.query(spec, feedOptions), top, {
      maxPages,
      deadline: Date.now() + timeoutMs
    });
  } catch (err) {
    // An aborted query is a bounded failure, not a crash: report empty and say so loudly. It must
    // not propagate as a 500, and it must never be silent — silence is what made the original
    // outage look like a network problem.
    if (abort.aborted || err.name === 'AbortError' || err.code === 'ABORT_ERR') {
      console.error(
        `[Cosmos] ranked query on "${containerName}" ABORTED after ${timeoutMs}ms. ` +
        'Returning empty rather than holding the worker.'
      );
      return { items: [], requestCharge: 0, pages: 0, truncated: true, timedOut: true };
    }
    throw err;
  }

  // Hitting either bound is the pathological shape above. Say so.
  if (result.truncated || result.timedOut) {
    console.warn(
      `[Cosmos] ranked query on "${containerName}" stopped early ` +
      `(pages=${result.pages}, timedOut=${Boolean(result.timedOut)}) with ` +
      `${result.items.length} item(s); returning what it has rather than spinning.`
    );
  }

  return { ...result, items: result.items.map(stripInternals) };
}

/**
 * The bounded drain itself, separated from client plumbing so it can be tested against a fake
 * iterator — including the one shape that matters, an iterator whose hasMoreResults() never goes
 * false. Exported for that reason only.
 */
async function drainRanked(iterator, top, opts = {}) {
  const maxPages = Number(opts.maxPages) || RANKED_MAX_PAGES;
  const deadline = opts.deadline; // epoch ms, optional — injected so this stays testable
  const items = [];
  let requestCharge = 0;
  let pages = 0;
  let timedOut = false;

  while (iterator.hasMoreResults() && items.length < top && pages < maxPages) {
    if (deadline && Date.now() >= deadline) {
      timedOut = true;
      break;
    }
    const page = await iterator.fetchNext();
    pages++;
    requestCharge += page.requestCharge || 0;
    if (page.resources && page.resources.length) items.push(...page.resources);
  }

  return {
    items: items.slice(0, top),
    requestCharge,
    pages,
    timedOut,
    truncated: timedOut || (pages >= maxPages && items.length < top)
  };
}

/**
 * How far Cosmos has got rebuilding a container's index, as a percentage.
 *
 * This exists because a ranked query is only meaningful at 100: `ORDER BY RANK` cannot be served
 * from a partially built index, while `FULLTEXTCONTAINS` masks the same state by scanning. Every
 * cutover that lands rows in bulk has to wait on this, so it is a permanent operational reading,
 * not a debugging aid — see MIGRATION.md §F.
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
 * Bulk write that VERIFIES each operation and retries what Cosmos rejected.
 *
 * `bulk()` returns a per-operation status code and does not throw on a partial failure. Ignoring
 * that is how a seed silently under-writes: the first document seed reported 60,578 written while
 * only 56,317 landed, because the caller counted what it SENT. On serverless the usual cause is
 * 429 (throttling), which is retryable — so failures are retried with backoff rather than merely
 * counted.
 *
 * @returns {{succeeded: number, failed: number, statusCounts: object}}
 */
async function bulkVerified(containerName, operations, opts = {}) {
  const maxAttempts = opts.maxAttempts || 4;
  const statusCounts = {};
  let pending = operations;
  let succeeded = 0;

  for (let attempt = 1; attempt <= maxAttempts && pending.length > 0; attempt++) {
    const results = await bulk(containerName, pending);
    const retry = [];

    results.forEach((r, i) => {
      const code = r && r.statusCode;
      statusCounts[code] = (statusCounts[code] || 0) + 1;
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

  return { succeeded, failed: pending.length, statusCounts };
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
  RANKED_MAX_PAGES,
  RANKED_TIMEOUT_MS,
  initCosmosClient,
  getDatabase,
  getContainer,
  assertQuerySpec,
  query,
  queryRanked,
  drainRanked,
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
