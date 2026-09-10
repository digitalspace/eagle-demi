'use strict';

/**
 * Document chunks — extracted document text, the data behind Deep Search.
 *
 * Container `chunks`, partitioned by `/documentId`. Every chunk of a document shares one logical
 * partition, so replacing a document's chunks is a single-partition operation and one bulk call.
 *
 * THE PARTITION KEY IS NOT THE PROJECT. This is the only container where those differ —
 * `documents` is the only other container partitioned by `/projectId`. That matters
 * because `visibilityFor(access, field)` uses its argument for BOTH the partition key and the
 * project-scope field. Passing 'documentId' would emit `c.documentId IN (@scope0)` filled with
 * PROJECT ids, so a scoped caller would silently match nothing — and no test would catch it today
 * because only systemAccess() reads chunks. Hence two constants, used for two different things:
 * SCOPE_FIELD builds the predicate, PARTITION_FIELD addresses Cosmos. `/projectId/?` is indexed,
 * so scoping on it is free.
 */

const cosmos = require('../db/cosmos-nosql');
const { canRead } = require('../helpers/access-sql');
const { eq, selectWhere, pageOptions } = require('./_sql');

/**
 * `chunks` is the only chunk container. A second one, `chunks_fts`, briefly existed because a
 * full-text policy is IMMUTABLE and could not be added to this one in place — that whole approach
 * was ruled out on 2026-07-31 (fuzzy is a silent no-op even enrolled, wiki ADR-005), and the
 * container is gone. Deep Search moves to Azure AI Search, which indexes this container from the
 * outside and needs no policy on it.
 *
 * This one constant addresses every read AND write in this file, and the ingest route decides
 * nothing, so pointing it at the wrong container splits the corpus silently.
 */
const CONTAINER = 'chunks';
const PARTITION_FIELD = 'documentId'; // Cosmos partition key
const SCOPE_FIELD = 'projectId';      // project scope rides this, NOT the partition key

/**
 * Chunk ids are deterministic, so re-extracting a document upserts its chunks in place instead of
 * duplicating them. Nothing downstream synthesises an id — the AI Search indexer encodes this one
 * as the document key — so it has to be minted here.
 */
function chunkId(documentId, pageNumber, chunkIndex) {
  return `${documentId}::p${pageNumber}::c${chunkIndex}`;
}

/**
 * The parent-document fields every chunk repeats, so a chunk query filters on them without a join.
 * The List refs are ObjectId STRINGS, never labels: the filter panel sends ids, and a label
 * changes when someone renames a List item.
 *
 * Adding a name here costs an index PUT, a data-source PUT and a backfill over ~1.1M rows, in that
 * order — `azure/search/README.md`.
 */
const CHUNK_PARENT_LIST_REFS = Object.freeze([
  'typeId', 'milestoneId', 'projectPhaseId', 'documentAuthorTypeId'
]);

const CHUNK_PARENT_FIELDS = Object.freeze(['projectId', ...CHUNK_PARENT_LIST_REFS]);

/**
 * Which revision of the list above a chunk was stamped under, written as `parentFieldsVersion`.
 * The values themselves cannot answer "was this chunk ever stamped", because a document with no
 * List refs stamps nulls legitimately. Bump it when a NEW field joins, whose absence would read as
 * `null` and agree with the document.
 *
 * Not bumped for `projectId`: every ingest path has always written it, so a stale one fails the
 * plain value comparison already. It CAN be null — a handful of document rows carry no project at
 * all, and `documents.parentFieldRowsWithNoProject` is how the backfill reaches them.
 */
const CHUNK_PARENT_FIELDS_VERSION = 1;

/**
 * The instant the re-stamp walk that last wrote a chunk was serving.
 *
 * Two walks over one document are last-writer-wins without it: an older walk still in flight
 * finishes after a newer one and puts the values the newer walk replaced back on the chunks, with
 * the pending flag already cleared, so nothing reports the drift. Every stamp is conditional on
 * this field instead — a chunk only accepts a walk newer than the one already on it.
 *
 * NOT projected by `demi-chunks-ds` and not declared by the chunks index: it orders writers, it
 * answers no query, and a new column on 1.1M rows is an index PUT plus a full indexer pass.
 */
const STAMPED_AT_FIELD = 'parentStampedAt';

/** Same shape as `documents.PENDING_AT_PATTERN` — on the pending path the token IS that flag's
 * value — and checked for the same reason: it is interpolated into a patch condition, which the
 * SDK takes as a raw string with no parameter binding. */
const STAMPED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function assertStampedAt(stampedAt) {
  if (!STAMPED_AT_PATTERN.test(stampedAt)) {
    throw new TypeError(`[chunks] ${STAMPED_AT_FIELD} is not an ISO instant: ${stampedAt}`);
  }
  return stampedAt;
}

/** A chunk stamped by a walk at least as new as this one keeps what it has, and Cosmos answers 412.
 * Chunks written before the field existed carry no stamp and accept any walk. */
function stampCondition(stampedAt) {
  return `FROM c WHERE NOT IS_DEFINED(c.${STAMPED_AT_FIELD}) ` +
    `OR c.${STAMPED_AT_FIELD} < ${JSON.stringify(assertStampedAt(stampedAt))}`;
}

/**
 * What a document says its chunks' parent fields should be.
 *
 * Always every key, `null` where the document has none: a missing key leaves the previous value in
 * place on a PATCH, so a cleared milestone would keep answering the old milestone filter. Strings,
 * because the index declares `Edm.String` and an unstringified ObjectId indexes as null.
 */
function parentFieldsOf(document) {
  const doc = document || {};
  return {
    ...Object.fromEntries(CHUNK_PARENT_FIELDS.map(field => {
      const value = doc[field];
      return [field, value === null || value === undefined ? null : String(value)];
    })),
    parentFieldsVersion: CHUNK_PARENT_FIELDS_VERSION
  };
}

/**
 * `parentFieldsOf` plus the walk's stamp, for an ingest builder spreading parent fields into NEW
 * chunks: a chunk born without a stamp is older than every walk, so the next one overwrites it.
 */
function parentStampFieldsOf(document, stampedAt) {
  return { ...parentFieldsOf(document), [STAMPED_AT_FIELD]: assertStampedAt(stampedAt) };
}

/**
 * Whether a document edit moved any parent field, so the caller can skip a patch that would pay
 * full RU to write back what is already there. Values only, never the version: a version bump is a
 * corpus-wide re-stamp and belongs to `backfill-chunk-parent-fields.js`.
 */
function parentFieldsChanged(before, after) {
  const from = parentFieldsOf(before);
  const to = parentFieldsOf(after);
  return CHUNK_PARENT_FIELDS.some(field => from[field] !== to[field]);
}

/**
 * Chunks visible to this caller.
 *
 * `listVisible(access, {pageSize, continuationToken})` keeps the paged signature every bulk reader
 * expects, so this doubles as the source for whole-corpus passes.
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
 * Every chunk of ONE document, in page order.
 *
 * From COSMOS, not AI Search: chunk `content` is `maxVis 0` and never a select in `ai-search.js`
 * (test/vis/search-drift.test.js pins that), so the index cannot serve text. This is the same
 * source the summary endpoint reads its text from, and `listVisible` composes the same predicate.
 *
 * Sorted here because the container has no ORDER BY that survives paging, and a chunk id carries
 * its own order — `<docId>::p<page>::c<index>` — so page then index is deterministic.
 *
 * `max` is a real ceiling, not a formality: this drains a partition, and the caller is an offline
 * generator rather than a request path.
 */
async function allForDocument(access, documentId, { max = 2000 } = {}) {
  const rows = [];
  let continuationToken;
  do {
    const page = await listVisible(access, { documentId, pageSize: 1000, continuationToken });
    for (const row of page.items) rows.push(row);
    continuationToken = page.continuationToken;
  } while (continuationToken && rows.length < max);

  rows.sort((a, b) =>
    ((a.pageNumber ?? 0) - (b.pageNumber ?? 0)) ||
    ((a.chunkIndex ?? 0) - (b.chunkIndex ?? 0)));

  return rows.slice(0, max);
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
 * `{id, …CHUNK_PARENT_FIELDS}` for every chunk of one document. Single-partition, and the
 * projection is the id plus four short strings — never `content`, which is why this is a read the
 * backfill can afford once per document.
 *
 * The backfill compares these against what the DOCUMENT says, so it can tell a chunk that is
 * already correct from one carrying a stale value — including a stale value whose correct
 * replacement is `null`, which is the case a "does the document have anything to copy" test can
 * never see.
 */
async function parentFieldRowsForDocument(access, documentId) {
  const spec = selectWhere({
    access,
    partitionField: SCOPE_FIELD,
    criteria: [eq('documentId', String(documentId), '@documentId')],
    select: ['c.id', ...CHUNK_PARENT_FIELDS.map(f => `c.${f}`), 'c.parentFieldsVersion'].join(', ')
  });
  const { items } = await cosmos.query(CONTAINER, spec, { partitionKey: String(documentId) });
  return items;
}

/**
 * Whether a chunk row already holds exactly what the document says it should.
 *
 * The version counts as a field: a chunk stamped before `CHUNK_PARENT_FIELDS` grew agrees on every
 * field it knows about, so comparing values alone reads it as correct and the backfill skips
 * exactly the corpus it was run for.
 */
function chunkMatchesParent(chunk, fields) {
  return (chunk.parentFieldsVersion ?? null) === (fields.parentFieldsVersion ?? null) &&
    CHUNK_PARENT_FIELDS.every(field => (chunk[field] ?? null) === fields[field]);
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
function assertAcl(chunkItems) {
  for (const item of chunkItems) {
    // Fail closed: a chunk with no ladder token matches nobody but privileged callers.
    if (!Array.isArray(item.read) || item.read.length === 0) {
      throw new TypeError('[chunks] every chunk requires a non-empty read[] ACL');
    }
  }
}

/**
 * Upsert ONE batch of a document's chunks, leaving surplus alone.
 *
 * For the streaming ingest path, which cannot know the full chunk set up front — a 63 MB document
 * is chunked as it arrives, so the "what should survive" question can only be answered at the end.
 * Pair every streamed ingest with `deleteSurplus`, or a re-extraction that yields fewer chunks
 * leaves the old tail in place.
 */
async function upsertBatch(access, documentId, chunkItems) {
  assertAcl(chunkItems);
  if (chunkItems.length === 0) return { succeeded: 0, failed: 0, statusCounts: {}, requestCharge: 0 };

  const pk = String(documentId);
  return cosmos.bulkVerified(CONTAINER, chunkItems.map(resourceBody => ({
    operationType: 'Upsert', partitionKey: pk, resourceBody
  })));
}

/**
 * Rewrite the ACL on every chunk of one document.
 *
 * A chunk's `read[]` is a SNAPSHOT of its document's, copied at ingest. Nothing used to refresh it,
 * so unpublishing a document left its chunks carrying `public` — and because the AI Search indexer
 * is a `_ts` high-water mark, those rows were never re-read either, leaving the index copy stale
 * *indefinitely* rather than for the usual PT5M. Patching here advances `_ts`, so the next indexer
 * pass picks the change up and the lag becomes the ordinary one.
 *
 * A bulk PATCH, not an upsert: an upsert would have to read every chunk back first, and `content`
 * makes that a multi-megabyte round trip for a large document. All of a document's chunks share one
 * partition, and the average document holds ~19 of them, so this is normally a single request.
 *
 * @param {string} documentId
 * @param {string[]} read  the document's new ACL — a chunk must never out-rank its document
 */
async function setAclForDocument(access, documentId, read) {
  if (!Array.isArray(read) || read.length === 0) {
    throw new TypeError('[chunks] setAclForDocument requires a non-empty read[] ACL');
  }

  return setFieldsForDocument(access, documentId, {
    read,
    // `read[]` is authoritative and `isPublished` mirrors it, here as everywhere else. Nothing
    // reads a chunk's isPublished while its read[] is non-empty — assertAcl guarantees that —
    // but leaving the mirror stale is how the two come to disagree, and `/isPublished` is an
    // indexed path on this container.
    isPublished: read.includes('public')
  });
}

/**
 * Set the same field map on every chunk of one document — the bulk PATCH `setAclForDocument` and
 * `setParentFieldsForDocument` both ride, for the reasons in the block above.
 *
 * `bulkVerified` splits at Cosmos's 100-operation cap on its own, so a document with thousands of
 * chunks needs no batching here.
 *
 * @param {object} fields  Cosmos property name -> value. Every key is `set`, so a key left out
 *                         keeps whatever the chunk already holds.
 * @param {{stampedAt?: string}} [opts]  see `setFieldsForChunks`
 */
async function setFieldsForDocument(access, documentId, fields, opts = {}) {
  const ids = await idsForDocument(access, documentId);
  return setFieldsForChunks(access, documentId, ids, fields, opts);
}

/**
 * The same PATCH against NAMED chunks of one document, for the backfill: it has already read which
 * rows disagree with the parent, so it patches those instead of the whole document. Request paths
 * keep `setFieldsForDocument` — they know a value moved but not which chunks lag.
 *
 * @param {string[]} ids  chunk ids, all of `documentId`'s partition
 * @param {{stampedAt?: string, maxAttempts?: number}} [opts]  `stampedAt` is the instant this walk
 *   serves: it is written to `parentStampedAt` and guards every operation, so a chunk a newer walk
 *   already stamped comes back as `skippedNewer` instead of being overwritten. Absent: the patch is
 *   unconditional. `maxAttempts` overrides the bulk retry budget, for a corpus walk long enough to
 *   sit out a sustained throttle.
 */
async function setFieldsForChunks(access, documentId, ids, fields, { stampedAt, maxAttempts } = {}) {
  const guarded = stampedAt !== undefined;
  const patchFields = guarded
    ? { ...fields, [STAMPED_AT_FIELD]: assertStampedAt(stampedAt) }
    : fields;
  const operations = Object.entries(patchFields).map(([key, value]) => ({
    op: 'set', path: `/${key}`, value
  }));
  if (operations.length === 0) {
    throw new TypeError('[chunks] a chunk patch requires at least one field');
  }
  if (!ids || ids.length === 0) {
    return { succeeded: 0, failed: 0, skippedNewer: 0, statusCounts: {}, requestCharge: 0, chunks: 0 };
  }

  // One bulk request per 100 chunks, guarded or not: the ordering condition rides on each Patch
  // operation, and `bulkVerified` answers a rejected condition as `skippedIds` instead of retrying
  // it. A per-chunk request would cost one round trip per chunk on a corpus walk of 400k+ of them.
  const pk = String(documentId);
  const resourceBody = guarded
    ? { operations, condition: stampCondition(stampedAt) }
    : { operations };
  const result = await cosmos.bulkVerified(CONTAINER, ids.map(id => ({
    operationType: 'Patch',
    partitionKey: pk,
    id: String(id),
    resourceBody
  })), maxAttempts === undefined ? {} : { maxAttempts });

  // A chunk a NEWER walk already stamped is not a failure: the value on it is at least as current
  // as this walk's. Unguarded writes carry no condition, so nothing is ever skipped there.
  return { ...result, skippedNewer: result.skippedIds.length, chunks: ids.length };
}

/**
 * Re-stamp a document's filter metadata onto every one of its chunks.
 *
 * The chunk copy is a SNAPSHOT taken at ingest, exactly as `read[]` is, so nothing refreshes it
 * when the document's type or milestone changes upstream — and the AI Search indexer is a `_ts`
 * high-water mark, so a chunk nobody rewrites is never re-read either. The patch advances `_ts`,
 * which is what puts the new values in the index on the indexer's ordinary PT5M pass.
 *
 * Call it only when a value actually moved (`parentFieldsChanged`): this walks every chunk of the
 * document, and re-writing identical values would pay that RU on every metadata edit.
 *
 * @param {{stampedAt?: string}} [opts]  the instant this walk serves — the document's
 *   `parentFieldsPendingAt` token where there is one, the walk's own start instant otherwise.
 *   Without it the patch is unconditional, which is last-writer-wins across concurrent walks.
 */
async function setParentFieldsForDocument(access, documentId, document, opts = {}) {
  return setFieldsForDocument(access, documentId, parentFieldsOf(document), opts);
}

/**
 * How many failing documents a caller's error log names before it goes quiet. A systematic fault
 * would otherwise write one record per document over a 60k-document corpus.
 *
 * It counts DOCUMENTS, which is why `onError` below fires once per document rather than once per
 * rejected chunk operation: the average document holds ~19 chunks, so a cap counted in operations
 * goes quiet after the first document or two.
 */
const MAX_LOGGED_RESTAMP_ERRORS = 20;

/**
 * Re-stamp the parent fields of every document in `docs` whose row write LANDED.
 *
 * `failedIds` are the ids the document write rejected, and they are SKIPPED rather than stamped: a
 * re-stamp on the strength of a rejected write puts a value in the chunks that no document row
 * holds, so the chunk answers a filter its own document does not match — strictly worse than the
 * stale copy the run was fixing. The caller that writes no document rows passes none.
 *
 * A throw is counted and swallowed, never rethrown: the document rows are authoritative and have
 * already landed, a stale chunk copy makes a filter MISS rather than expose anything, and
 * `backfill-chunk-parent-fields.js --live` is the repair every caller's summary points at.
 *
 * @param {Array}    docs       documents whose parent fields moved; each must carry `id`
 * @param {string[]} failedIds  ids whose document-row write was rejected
 * @param {object}   [opts]     `onError(doc, err)` fires once per document that threw — a merely
 *                              rejected chunk operation arrives as a status count instead.
 *                              `stampedAt` guards every chunk write against a newer walk (see
 *                              `setFieldsForChunks`); one instant covers the whole batch, so a
 *                              caller serving per-document pending tokens stamps per document
 *                              instead. `stamp` is the test seam the scripts inject a double
 *                              through.
 * @returns {{stamped: number, failedDocuments: number, failedChunks: number, skipped: number,
 *           skippedNewer: number, chunks: number, requestCharge: number, statusCounts: object,
 *           stampedDocumentIds: string[], failedDocumentIds: string[]}}
 *          `stamped + failedDocuments + skipped === docs.length`; `chunks` and `failedChunks` count
 *          chunk OPERATIONS, the other three count DOCUMENTS — one document is ~19 operations, so
 *          a single mixed number could not be read either way. The two id lists name the documents
 *          behind the first two counts, which is what a caller needs to clear the pending flag on
 *          the ones that landed and leave it raised on the ones that did not — a count cannot say
 *          WHICH. Skipped ids are the `failedIds` the caller passed in and are in neither list.
 */
async function reStampAfterWrite(access, docs, failedIds = [], opts = {}) {
  const { onError, stamp = setParentFieldsForDocument, stampedAt } = opts;
  const rejected = new Set(Array.from(failedIds, String));
  const totals = {
    stamped: 0, failedDocuments: 0, failedChunks: 0, skipped: 0, skippedNewer: 0,
    chunks: 0, requestCharge: 0, statusCounts: {},
    stampedDocumentIds: [], failedDocumentIds: []
  };

  for (const doc of docs) {
    if (rejected.has(String(doc.id))) {
      totals.skipped++;
      continue;
    }

    let result;
    try {
      result = await stamp(access, doc.id, doc, { stampedAt });
    } catch (err) {
      totals.failedDocuments++;
      totals.failedDocumentIds.push(String(doc.id));
      if (onError) onError(doc, err);
      continue;
    }

    totals.chunks += result.succeeded || 0;
    totals.failedChunks += result.failed || 0;
    totals.skippedNewer += result.skippedNewer || 0;
    totals.requestCharge += result.requestCharge || 0;
    for (const [status, n] of Object.entries(result.statusCounts || {})) {
      totals.statusCounts[status] = (totals.statusCounts[status] || 0) + n;
    }
    // A document is stamped or it is not: one rejected operation leaves it carrying a mix of old
    // and new values on its chunks, which is the state the repair exists for. A chunk a NEWER walk
    // already stamped is not a rejection — the value on it is at least as current as this walk's.
    if (result.failed) {
      totals.failedDocuments++;
      totals.failedDocumentIds.push(String(doc.id));
    } else {
      totals.stamped++;
      totals.stampedDocumentIds.push(String(doc.id));
    }
  }

  return totals;
}

/**
 * Delete every chunk of this document whose id is NOT in `keepIds` — the tail half of a streamed
 * replace.
 *
 * Skipping this is not a cosmetic leak: AI Search indexers never see deletes (`_ts` high-water
 * mark only), so an orphaned chunk stays searchable forever and a document keeps answering queries
 * with text it no longer contains.
 */
async function deleteSurplus(access, documentId, keepIds) {
  const pk = String(documentId);
  const keep = new Set(Array.from(keepIds, String));

  const operations = (await idsForDocument(access, documentId))
    .filter(id => !keep.has(String(id)))
    .map(id => ({ operationType: 'Delete', partitionKey: pk, id: String(id) }));

  if (operations.length === 0) return { succeeded: 0, failed: 0, statusCounts: {}, requestCharge: 0 };
  return cosmos.bulkVerified(CONTAINER, operations);
}

async function replaceForDocument(access, documentId, chunkItems) {
  const pk = String(documentId);

  assertAcl(chunkItems);

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
  if (operations.length === 0) return { succeeded: 0, failed: 0, statusCounts: {}, requestCharge: 0 };

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
  CHUNK_PARENT_FIELDS,
  CHUNK_PARENT_LIST_REFS,
  CHUNK_PARENT_FIELDS_VERSION,
  STAMPED_AT_FIELD,
  MAX_LOGGED_RESTAMP_ERRORS,
  chunkId,
  parentFieldsOf,
  parentStampFieldsOf,
  parentFieldsChanged,
  parentFieldRowsForDocument,
  chunkMatchesParent,
  listVisible,
  allForDocument,
  getById,
  idsForDocument,
  setAclForDocument,
  setFieldsForDocument,
  setFieldsForChunks,
  setParentFieldsForDocument,
  reStampAfterWrite,
  replaceForDocument,
  upsertBatch,
  deleteSurplus,
  removeForDocument
};
