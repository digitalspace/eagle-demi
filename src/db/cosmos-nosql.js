'use strict';

/**
 * Cosmos DB for NoSQL data access. Thin, parameterised, and fail-closed.
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
const { logger } = require('../utils/logger');

let clientInstance = null;
let databaseInstance = null;

/**
 * The NoSQL database name, from a DEDICATED variable.
 *
 * It must NOT be `COSMOS_DATABASE`: that variable still holds `epic` on the deployed app and the
 * now-deleted Mongo-API client read it. Setting `COSMOS_DATABASE=demi` for this client once
 * silently repointed the LIVE legacy app at the new, empty database: every endpoint returned `[]`
 * with HTTP 200, because queryContainer swallows the error.
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
    logger.warn('[Cosmos] COSMOS_ENDPOINT is not set; data access is unavailable.');
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
 * How many pages a single-row lookup drains before it gives up.
 *
 * A cross-partition lookup visits partitions until it runs out of RU budget for the page, so the
 * bound is a fault stop, not a result limit: 50 pages is far past any id lookup that is going to
 * succeed, and it keeps a query with a predicate that matches nothing from walking all 357
 * partitions one page at a time.
 */
const LOOKUP_MAX_PAGES = 50;

/**
 * `err.code` on the error `queryFirst` throws when it runs out of pages.
 *
 * Callers read `null` from a lookup as "the row is not there" and act destructively on it — the
 * re-stamp drops its message, the seeder writes a duplicate. A drain that stopped early is not that
 * answer, so it must not wear its shape.
 */
const LOOKUP_BOUND_CODE = 'COSMOS_LOOKUP_BOUND';

/**
 * First row of a lookup that expects at most one, draining pages until it is found.
 *
 * A single page of a cross-partition query can legally come back EMPTY while the row exists:
 * Cosmos answers with whatever the partitions it reached within the page's RU budget held, and the
 * iterator still has more results. Reading one page and stopping — `query(..., {maxItemCount: 1})`
 * — reports an existing document as gone.
 *
 * ONE iterator, drained with repeated `fetchNext()`, which is the only drain the SDK supports on
 * every path (@azure/cosmos 4.10.0, and the loop its own `fetchNext` docstring shows at
 * dist/commonjs/queryIterator.js:212). Resuming a NEW iterator from `response.continuationToken`,
 * which is what this used to do through `query()`, is broken for exactly the cross-partition case
 * this function exists for: a query the gateway rejects switches to `PipelinedQueryExecutionContext`
 * (queryIterator.js:241-242), whose `LegacyFetchImplementation` never sets `x-ms-continuation`
 * (dist/commonjs/queryExecutionContext/LegacyFetchImplementation.js:15-53) and whose `mergeHeaders`
 * does not copy it either (dist/commonjs/queryExecutionContext/headerUtils.js:39-77). So
 * `FeedResponse.continuationToken` — a raw read of that header (request/FeedResponse.js:19-21) —
 * came back undefined and the drain stopped at page one; and had a token been there, feeding it
 * back would have THROWN "Continuation tokens are supported when enableQueryControl is set true"
 * (queryExecutionContext/parallelQueryExecutionContextBase.js:85-91).
 *
 * Returns null only when the iterator is genuinely exhausted. Hitting the page bound THROWS, with
 * `code === LOOKUP_BOUND_CODE`: at that point nothing is known about the row, and a caller told
 * "absent" would act on a guess.
 *
 * @param {object} [options] as `query`, minus `maxItemCount` — the page size is fixed at 1
 * @returns {Promise<object|null>}
 * @throws {Error} `code === LOOKUP_BOUND_CODE` when the drain runs out of pages
 */
async function queryFirst(containerName, spec, options = {}) {
  assertQuerySpec(spec, containerName);

  const container = getContainer(containerName);
  if (!container) return null;

  const feedOptions = { maxItemCount: 1 };
  if (options.partitionKey !== undefined) feedOptions.partitionKey = options.partitionKey;
  if (options.continuationToken) feedOptions.continuationToken = options.continuationToken;

  const iterator = container.items.query(spec, feedOptions);

  for (let page = 0; page < LOOKUP_MAX_PAGES && iterator.hasMoreResults(); page++) {
    const response = await iterator.fetchNext();
    const items = response.resources || [];
    if (items.length > 0) return stripInternals(items[0]);
  }

  if (!iterator.hasMoreResults()) return null;

  logger.warn('[Cosmos] lookup ran out of pages before the iterator ran out of partitions.', {
    container: containerName, pages: LOOKUP_MAX_PAGES
  });
  throw Object.assign(
    new Error(`[Cosmos] lookup in "${containerName}" reached the ${LOOKUP_MAX_PAGES}-page bound ` +
      'with the iterator still holding results; "not found" would be a guess'),
    { code: LOOKUP_BOUND_CODE });
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
 *
 * `etag` is the same optimistic guard `replace` takes: the write lands only while the item is still
 * the revision the caller read, and a mismatch throws 412. It is the ONLY concurrency control an
 * upsert can have — a whole-item write has no stored value left to test a `condition` against.
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
 * Partial update — atomic, no read-modify-write, and it cannot erase fields it does not name.
 *
 * `condition` is a SQL predicate over the stored item (`FROM c WHERE c.n < 3`) evaluated by the
 * server in the same operation: false means the patch is not applied and the call throws 412. That
 * is what makes a counter a test-and-set rather than a read-then-write two callers can interleave.
 *
 * `etag` is the other guard, and they are independent: `condition` asks whether the stored VALUES
 * still allow the write, `etag` asks whether the item is still the revision the caller read. A
 * clear-a-flag patch has no value to test — only "nobody wrote since I looked" — so it needs this
 * one. Mismatch throws 412, same as a failed condition.
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
 * Cosmos's answer to a write whose precondition — an `IfMatch` etag, or a Patch operation's SQL
 * `condition` — did not hold. It is a terminal ANSWER, not a transport fault: the row on the server
 * is the one the caller asked not to overwrite, so repeating the request repeats the rejection.
 */
const PRECONDITION_FAILED = 412;
const BULK_MAX_ATTEMPTS = 8;
const BULK_MAX_BACKOFF_MS = 20000;
const BULK_BACKOFF_JITTER_MS = 250;

/**
 * How long to wait before the next attempt.
 *
 * Doubling rather than linear: a corpus walk against a serverless account stays throttled for
 * minutes, and 1s/2s/3s/4s spends every attempt inside the same overload. The 2026-09 chunk
 * backfill exhausted four linear attempts on 523,144 throttled operations and left 70 documents
 * part-stamped. Cosmos's own hint wins when it is larger, because it is the only figure that knows
 * when the partition will have budget again. Jitter keeps the concurrent walkers from resending in
 * lockstep, which is what turns one throttle into a repeating one.
 */
function bulkBackoffMs(attempt, hintMs) {
  const hint = Number.isFinite(hintMs) && hintMs > 0 ? hintMs : 0;
  const exponential = 1000 * 2 ** (attempt - 1);
  return Math.min(Math.max(exponential, hint), BULK_MAX_BACKOFF_MS)
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
 * Bulk write. All operations must target the SAME partition key value.
 *
 * Splits into 100-operation requests and concatenates the responses, so the return value has one
 * entry per input operation in input order regardless of how it was chunked.
 *
 * Operation objects are forwarded to the SDK verbatim, so a Patch operation may carry a guarded
 * body — `resourceBody: {operations, condition}` — exactly as `patch()` above does for a single
 * item. @azure/cosmos 4.10 types `PatchOperationInput.resourceBody` as `PatchRequestBody`, which is
 * `{operations, condition?}` (`utils/batch.d.ts:103-110`, `utils/patch.d.ts:18-21`), and the
 * executor puts the prepared operations straight in the request body without rewriting the patch
 * spec (`client/Item/Items.js:605` `body: batch.operations`, via `utils/batch.js:73-77`, which only
 * stringifies `partitionKey`). A rejected condition comes back as a per-operation 412, which
 * `bulkVerified` reports apart from a failure.
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
 * counted. `opts.maxAttempts` raises or lowers the `BULK_MAX_ATTEMPTS` default for a caller that
 * knows its walk is long enough to sit through a sustained throttle.
 *
 * `requestCharge` is the RU actually billed, summed across every attempt — retries included, since
 * on serverless a retried operation is paid for twice and a figure that hid that would understate
 * the bill exactly when it matters. This is the only write path for chunks, so it is the one place
 * the number can be collected once for ingest, seeds and deletes alike.
 *
 * A 412 is the exception to the retry: a precondition that did not hold is Cosmos's ANSWER, so it
 * is recorded once, never retried, and reported in `skippedIds` rather than `failedIds`. Retrying
 * it would pay `maxAttempts` requests for a decision already made and then hand the caller a
 * guarded write it declined as a lost one.
 *
 * @returns {{succeeded: number, failed: number, statusCounts: object, requestCharge: number,
 *            failedIds: string[], skippedIds: string[]}}
 */
/**
 * The id an operation names. `resourceBody.id` covers Upsert/Create, which carry no top-level `id`
 * — without it every failed upsert reports `undefined` and a caller filtering on this drops the
 * whole batch.
 */
function operationId(op) {
  return op.id ?? (op.resourceBody && op.resourceBody.id) ?? (op.resource && op.resource.id);
}

async function bulkVerified(containerName, operations, opts = {}) {
  const maxAttempts = opts.maxAttempts || BULK_MAX_ATTEMPTS;
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
      if (attempt < maxAttempts) await sleep(bulkBackoffMs(attempt, err && err.retryAfterInMs));
      continue;
    }

    const retry = [];
    let retryAfterMs = 0;
    // Driven by what was SENT, not by what came back. A response shorter than the request — an
    // empty array, or a truncated one — otherwise dropped its tail silently: those operations were
    // never counted, never retried and never named in `failedIds`, so the caller was told the batch
    // landed. No status is an unanswered operation, which is a failure until Cosmos says otherwise.
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
      await sleep(bulkBackoffMs(attempt, retryAfterMs));
    }
  }

  // Only when every attempt threw and nothing landed: the caller has no per-operation detail to
  // report, so surface the underlying error rather than a bare count it cannot act on.
  if (lastThrown && succeeded === 0 && pending.length === operations.length) {
    throw lastThrown;
  }

  // The ids still unwritten, so a caller can act on the subset that DID land. `skippedIds` are the
  // ones Cosmos declined on their own precondition: they are neither written nor lost, and a caller
  // that lumped them in with `failedIds` would send a repair after rows that are already current.
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
