'use strict';

/**
 * Document chunks — extracted document text, the data behind Deep Search.
 *
 * Container `chunks`, partitioned by `/documentId`. Every chunk of a document shares one logical
 * partition, so replacing a document's chunks is a single-partition operation and one bulk call.
 *
 * THE PARTITION KEY IS NOT THE PROJECT. This is the only container where those differ —
 * `documents`, `records` and `project_fragments` all partition by `/projectId`. That matters
 * because `visibilityFor(access, field)` uses its argument for BOTH the partition key and the
 * project-scope field. Passing 'documentId' would emit `c.documentId IN (@scope0)` filled with
 * PROJECT ids, so a scoped caller would silently match nothing — and no test would catch it today
 * because only systemAccess() reads chunks. Hence two constants, used for two different things:
 * SCOPE_FIELD builds the predicate, PARTITION_FIELD addresses Cosmos. `/projectId/?` is indexed,
 * so scoping on it is free.
 */

const cosmos = require('../db/cosmos-nosql');
const { canRead } = require('../helpers/access-sql');
const { eq, selectWhere, countWhere, pageOptions } = require('./_sql');

/**
 * `chunks_fts`, not `chunks`: the full-text policy is IMMUTABLE, so searching this text where it
 * already lives needed a new container rather than an index change (MIGRATION.md §F). This one
 * constant is the whole write repoint — every path in this file goes through it, and the ingest
 * route decides nothing, so the extraction host needs no change.
 */
const CONTAINER = 'chunks_fts';
const PARTITION_FIELD = 'documentId'; // Cosmos partition key
const SCOPE_FIELD = 'projectId';      // project scope rides this, NOT the partition key

/** Cosmos rejects nothing above this — it silently returns ZERO rows. Documented max is 2. */
const MAX_FUZZY_DISTANCE = 2;

/**
 * Fuzzy matching is OFF unless explicitly enabled, and the default is not timidity — it is
 * measured. On `demi-cosmos-dev` the fuzzy `{term, distance}` form returns ZERO rows for a query
 * that exact matching answers correctly. Microsoft document fuzzy search as "early preview"
 * requiring enrolment in *New features for full-text Search*, which this account does not have.
 *
 * That matters far more than a missing feature, because the frontend sends `fuzzy=true` on EVERY
 * Deep Search (`registry-state.service.ts`). Honouring the flag against an account that cannot
 * serve it turns the entire feature into a silent blank page. Falling back to exact matching gives
 * real results — Cosmos stems natively, so "assess" still finds "assessed".
 *
 * Set COSMOS_FTS_FUZZY=true once the preview is enrolled and verified against live data.
 */
const FUZZY_ENABLED = process.env.COSMOS_FTS_FUZZY === 'true';

/**
 * Ranked queries cannot page by continuation token, so chunk search is TOP-N. 250 is what the
 * search API already caps a page at, so the contract is unchanged.
 */
const DEFAULT_TOP = 20;
const MAX_TOP = 250;

/** Beyond this the query text grows without adding recall; BM25 is already dominated by the rest. */
const MAX_TERMS = 16;

/**
 * Chunk ids are deterministic, so re-extracting a document upserts its chunks in place instead of
 * duplicating them. The Typesense transform reads `chunk.id` verbatim and synthesises nothing
 * (transform-nosql.js), so the id has to be minted here.
 */
function chunkId(documentId, pageNumber, chunkIndex) {
  return `${documentId}::p${pageNumber}::c${chunkIndex}`;
}

/**
 * Chunks visible to this caller.
 *
 * `listVisible(access, {pageSize, continuationToken})` is the signature the Typesense full sync's
 * pageAll() calls, so this doubles as the sync source.
 */
async function listVisible(access, opts = {}) {
  const { documentId } = opts;

  const spec = selectWhere({
    access,
    partitionField: SCOPE_FIELD,
    criteria: documentId ? [eq('documentId', String(documentId), '@documentId')] : []
  });

  const options = pageOptions({
    ...opts,
    partitionKey: documentId !== undefined ? String(documentId) : undefined
  });

  return cosmos.query(CONTAINER, spec, options);
}

/**
 * Split a user's search string into full-text terms.
 *
 * Splits on anything that is not a letter or a digit, so punctuation and quotes cannot reach the
 * query, and keeps accented and non-Latin letters (\p{L}) — dropping them would silently make
 * French place names unsearchable.
 */
function tokenize(keywords) {
  return String(keywords || '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length > 0)
    .slice(0, MAX_TERMS);
}

/**
 * Ranked full-text search over chunk content, with the caller's visibility predicate composed into
 * the SAME WHERE clause — not applied afterwards, which would let the ranking be computed over
 * rows the caller cannot see and return a short page of nothing.
 *
 * @param {object} access            from resolveAccess()
 * @param {object} opts
 * @param {string} opts.keywords     raw user input
 * @param {boolean} [opts.fuzzy]     tolerate typos, at MAX_FUZZY_DISTANCE edits
 * @param {number} [opts.top]        TOP-N, capped at MAX_TOP
 */
async function searchText(access, opts = {}) {
  const terms = tokenize(opts.keywords);

  // Not an optimisation — a correctness guard. `ORDER BY RANK` with no full-text predicate returns
  // the WHOLE container, ranked but unfiltered, and does not error. Stopword-only input ("the and
  // of") reaches here as terms and is handled by Cosmos itself, which returns 0 rows.
  if (terms.length === 0) {
    return { items: [], continuationToken: undefined, requestCharge: 0 };
  }

  const top = Math.min(Math.max(Number(opts.top) || DEFAULT_TOP, 1), MAX_TOP);

  // Requested fuzzy is not the same as available fuzzy. Degrade to exact rather than to nothing.
  const fuzzyRequested = opts.fuzzy === true;
  const fuzzy = fuzzyRequested && FUZZY_ENABLED;
  const fuzzyUnavailable = fuzzyRequested && !FUZZY_ENABLED;

  const names = terms.map((_, i) => `@term${i}`);

  // Distance is a fixed constant rather than a caller-supplied number precisely because an
  // out-of-range value returns zero rows instead of an error — there is nothing to catch.
  const params = names.map((name, i) => ({
    name,
    value: fuzzy ? { term: terms[i], distance: MAX_FUZZY_DISTANCE } : terms[i]
  }));

  // FULLTEXTCONTAINSALL takes plain strings. The fuzzy form is an object per term, which only
  // FULLTEXTCONTAINS accepts, so ALL semantics are spelled out as an AND of single-term calls.
  // ponytail: the fuzzy object is passed as one bound PARAMETER rather than an inline literal, so
  // no caller value is ever interpolated. Verify against the live account before relying on it —
  // a binding Cosmos does not understand fails as zero rows, not as an error.
  const match = {
    clause: fuzzy
      ? names.map(n => `FULLTEXTCONTAINS(c.content, ${n})`).join(' AND ')
      : `FULLTEXTCONTAINSALL(c.content, ${names.join(', ')})`,
    params
  };

  // PRE-FLIGHT, and the reason this method is two queries instead of one.
  //
  // `ORDER BY RANK` spins INSIDE the SDK's client-side merge when it matches nothing against a
  // container that has rows. Measured on demi-api-dev at index progress 100: the spin is
  // synchronous, so it blocks the event loop — every other endpoint goes dark, no error is thrown,
  // the process never exits, and it recovers only minutes later. Critically, that also means an
  // AbortSignal or a deadline CANNOT save us: both are timers, and a blocked loop runs no timers.
  // The only defence is not to issue the query.
  //
  // So ask the cheap question first. This count uses the IDENTICAL predicate via countWhere, has
  // no ORDER BY RANK, and is measured at ~3 RU.
  const countSpec = countWhere({
    access,
    partitionField: SCOPE_FIELD,
    criteria: [match]
  });
  const matches = await cosmos.queryValue(CONTAINER, countSpec);
  if (!matches) {
    return {
      items: [],
      continuationToken: undefined,
      requestCharge: 0,
      matched: 0,
      fuzzyUnavailable
    };
  }

  const spec = selectWhere({
    access,
    partitionField: SCOPE_FIELD,
    criteria: [match],
    // `read` is projected so the response can report the item's real ACL instead of assuming
    // 'public'. `content` is the only large field and the UI needs it for the snippet.
    select: 'TOP @top c.id, c.documentId, c.projectId, c.pageNumber, c.content, c.read',
    orderBy: `RANK FULLTEXTSCORE(c.content, ${names.join(', ')})`
  });
  // Appended rather than passed as a criterion: andClauses drops a fragment whose clause is `true`,
  // and its parameters with it.
  spec.parameters.push({ name: '@top', value: top });

  // queryRanked, never query(). Both of query()'s modes are wrong for `ORDER BY RANK`: one
  // fetchNext() returns empty early pages for a query that HAS matches, and fetchAll() never
  // terminates when the query matches NOTHING against a non-empty container — that one took
  // demi-api-dev completely unreachable for ~6 minutes, with no crash and no log line.
  // TOP bounds the result server-side; the page cap and the timeout bound the client.
  const result = await cosmos.queryRanked(CONTAINER, spec, { top });

  // A bounded failure still has to be legible. An empty result that came from a timeout is NOT
  // the same fact as "nothing matched", and callers that cannot tell them apart are how a broken
  // search path gets reported as an empty corpus.
  if (fuzzyUnavailable) {
    console.warn(
      '[chunks] fuzzy matching was requested but COSMOS_FTS_FUZZY is not enabled; served as an ' +
      'exact match. Enable it only after enrolling the account in the full-text preview.'
    );
  }

  if (result.timedOut) {
    console.error(
      `[chunks] ranked search timed out for ${terms.length} term(s); returning empty. ` +
      'This is a fault, not an empty corpus.'
    );
  }

  return { ...result, fuzzyUnavailable };
}

async function getById(access, id, documentId) {
  const doc = await cosmos.readItem(CONTAINER, String(id), String(documentId));
  if (!doc) return null;
  // Point reads bypass the query predicate, so the ACL check is mandatory here.
  return canRead(doc, access, SCOPE_FIELD) ? doc : null;
}

/** Ids of every chunk of one document. Single-partition. */
async function idsForDocument(access, documentId) {
  const spec = selectWhere({
    access,
    partitionField: SCOPE_FIELD,
    criteria: [eq('documentId', String(documentId), '@documentId')],
    select: 'VALUE c.id'
  });
  const { items } = await cosmos.query(CONTAINER, spec, { partitionKey: String(documentId) });
  return items;
}

/**
 * Replace a document's chunks with `chunkItems`.
 *
 * Upsert-then-delete-surplus rather than delete-all-then-insert: there is no window in which a
 * live document has zero chunks, and a re-run with identical input is a no-op.
 *
 * @param {string} documentId
 * @param {Array}  chunkItems  fully-formed items; each MUST carry a non-empty read[]
 */
async function replaceForDocument(access, documentId, chunkItems) {
  const pk = String(documentId);

  for (const item of chunkItems) {
    // Fail closed. A chunk with no ACL falls back to the isPublished mirror and could become
    // publicly readable — a chunk is a fragment of its document and must never out-rank it.
    if (!Array.isArray(item.read) || item.read.length === 0) {
      throw new TypeError('[chunks] every chunk requires a non-empty read[] ACL');
    }
  }

  const existing = new Set(await idsForDocument(access, documentId));
  const keep = new Set(chunkItems.map(i => String(i.id)));

  const operations = chunkItems.map(resourceBody => ({
    operationType: 'Upsert',
    partitionKey: pk,
    resourceBody
  }));

  for (const id of existing) {
    if (!keep.has(String(id))) {
      operations.push({ operationType: 'Delete', partitionKey: pk, id: String(id) });
    }
  }

  // Same shape as bulkVerified's return — `failed` is a COUNT, so callers can test it uniformly.
  if (operations.length === 0) return { succeeded: 0, failed: 0, statusCounts: {} };

  // bulkVerified, never bulk: bulk does not throw on partial failure, and counting what was SENT
  // is the bug that reported 60,578 documents written when 56,317 existed.
  return cosmos.bulkVerified(CONTAINER, operations);
}

/** Remove every chunk of a document. Used when the document itself is hard-deleted. */
async function removeForDocument(access, documentId) {
  return replaceForDocument(access, documentId, []);
}

module.exports = {
  CONTAINER,
  PARTITION_FIELD,
  SCOPE_FIELD,
  MAX_FUZZY_DISTANCE,
  FUZZY_ENABLED,
  MAX_TOP,
  chunkId,
  tokenize,
  searchText,
  listVisible,
  getById,
  idsForDocument,
  replaceForDocument,
  removeForDocument
};
