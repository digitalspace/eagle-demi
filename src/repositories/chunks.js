'use strict';

/**
 * Extracted document text, container `chunks`, partitioned by `/documentId`. Scope with SCOPE_FIELD:
 * PARTITION_FIELD in `visibilityFor` would test document ids against project ids and match nothing.
 */

const crypto = require('crypto');
const cosmos = require('../db/cosmos-nosql');
const { canRead } = require('../helpers/access-sql');
const { logger } = require('../utils/logger');
const { eq, inList, selectWhere, pageOptions } = require('./_sql');

/**
 * Every read and write here goes through this one constant, and the ingest route decides nothing,
 * so pointing it at another container splits the corpus silently.
 */
const CONTAINER = 'chunks';
const PARTITION_FIELD = 'documentId'; // Cosmos partition key
const SCOPE_FIELD = 'projectId';      // project scope rides this, NOT the partition key

/** Deterministic, so a re-extraction upserts in place; the AI Search indexer keys on this id. */
function chunkId(documentId, pageNumber, chunkIndex) {
  return `${documentId}::p${pageNumber}::c${chunkIndex}`;
}

/**
 * Parent fields every chunk repeats so a chunk query filters without a join; List refs are id strings,
 * never labels. Adding one: index PUT, data-source PUT, then backfill (`azure/search/README.md`).
 */
const CHUNK_PARENT_LIST_REFS = Object.freeze([
  'typeId', 'milestoneId', 'projectPhaseId', 'documentAuthorTypeId'
]);

const CHUNK_PARENT_FIELDS = Object.freeze(['projectId', ...CHUNK_PARENT_LIST_REFS]);

/**
 * The list revision a chunk was stamped under (`parentFieldsVersion`). Bump it when a field joins:
 * a missing field reads as `null` and would agree with a document that has none.
 */
const CHUNK_PARENT_FIELDS_VERSION = 1;

/**
 * The instant of the re-stamp walk that last wrote a chunk; stamps are conditional on it, so a late
 * older walk cannot undo a newer one. Not in the search index: it orders writers, answers no query.
 */
const STAMPED_AT_FIELD = 'parentStampedAt';

/** Same shape as `documents.PENDING_AT_PATTERN` (a pending token can be the stamp), checked because
 * it goes into a raw-string patch condition. */
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
 * A document's chunk parent fields. Every key, `null` when absent, since a PATCH keeps an omitted key;
 * strings, since the index is `Edm.String` and a raw ObjectId indexes as null.
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
 * Whether an edit moved any parent field, so the caller can skip a no-op patch. Values only: a
 * version bump is a corpus re-stamp for `backfill-chunk-parent-fields.js`.
 */
function parentFieldsChanged(before, after) {
  const from = parentFieldsOf(before);
  const to = parentFieldsOf(after);
  return CHUNK_PARENT_FIELDS.some(field => from[field] !== to[field]);
}

/** Chunks visible to this caller, paged like every bulk reader expects, so whole-corpus passes use it. */
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
 * Every chunk of one document, from Cosmos: the index never selects chunk `content`. Sorted here by
 * page then index, since no ORDER BY survives paging; `max` caps the partition drain.
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
 * `itemHash` lets an identical re-post skip its billed upsert. Per-ingest clocks are left out by name,
 * so a new field is hashed by default: forgetting one costs a write, never a skipped change.
 */
const HASH_FIELD = 'itemHash';
const UNHASHED_FIELDS = new Set([HASH_FIELD, 'extractedAt', STAMPED_AT_FIELD]);

function itemHashOf(item) {
  const keys = Object.keys(item).filter(k => !UNHASHED_FIELDS.has(k)).sort();
  const canonical = JSON.stringify(Object.fromEntries(keys.map(k => [k, item[k]])));
  return crypto.createHash('sha256').update(canonical).digest('base64');
}

/** `id -> { hash, stampedAt, ts }` for the named chunks of one document, or all of them when `ids`
 * is omitted. Single-partition, and the projection is four short fields, never `content`. */
async function storedHashes(access, documentId, ids) {
  const criteria = [eq('documentId', String(documentId), '@documentId')];
  if (ids) criteria.push(inList('id', ids.map(String), '@id'));
  const spec = selectWhere({
    access, partitionField: SCOPE_FIELD, criteria,
    select: `c.id, c.${HASH_FIELD}, c.${STAMPED_AT_FIELD}, c._ts`
  });
  const { items } = await cosmos.query(CONTAINER, spec, { partitionKey: String(documentId) });
  return new Map(items.map(row => [
    String(row.id), { hash: row[HASH_FIELD], stampedAt: row[STAMPED_AT_FIELD], ts: row._ts }
  ]));
}

/**
 * Whether a stored row already holds this item, keeping its older stamp: every patch nulls `itemHash`,
 * so a match means no walk wrote it since ingest. An unstamped row accepts every walk, so it is rewritten.
 */
function isUnchanged(row, item, hash) {
  if (!row || row.hash !== hash) return false;
  return item[STAMPED_AT_FIELD] === undefined || typeof row.stampedAt === 'string';
}

/**
 * Seconds a chunk may be missing from the index before that is a gap, not lag. The indexer runs PT5M;
 * checking sooner would rewrite every chunk of a fast retry.
 */
const INDEX_SETTLE_SECONDS = 30 * 60;

// ~19 chunks is the average document, so a typical lost document heals in one ingest while an
// indexer outage costs at most this many writes per ingest.
const MAX_HEALED_PER_INGEST = 20;

/** One ingest's heal allowance; a streamed ingest passes the same one to every `upsertBatch`. */
function healBudget() {
  return { left: MAX_HEALED_PER_INGEST };
}

/**
 * Unchanged ids the settled index lacks, to rewrite: the `_ts` high-water mark never re-reads them.
 * Over the cap and over half missing reads as indexer lag, so none are rewritten.
 *
 * @param {Function} [indexed]  (chunkIds) => Set of those the index holds, or null
 */
async function missingFromIndex(documentId, ids, stored, indexed, budget) {
  if (!indexed || budget.left <= 0) return [];
  const now = Date.now() / 1000;
  const settled = ids.filter((id) => {
    const { ts } = stored.get(id);
    return ts != null && now - ts >= INDEX_SETTLE_SECONDS;
  });
  if (settled.length === 0) return [];
  const held = await indexed(settled);
  if (!held) return [];
  const missing = settled.filter(id => !held.has(id));
  if (missing.length > MAX_HEALED_PER_INGEST && missing.length * 2 > settled.length) {
    logger.warn(`[chunks] doc=${documentId} index lacks ${missing.length} of ${settled.length} ` +
      'settled chunks; read as indexer lag, none rewritten');
    return [];
  }
  const healed = missing.slice(0, budget.left);
  budget.left -= healed.length;
  return healed;
}

/** Upsert operations for the items not already stored and indexed as they are; a stored row with
 * no hash counts as changed, so the first re-post after this shipped rewrites once. */
async function changedUpserts(documentId, chunkItems, stored, opts = {}) {
  const pk = String(documentId);
  const hashed = chunkItems.map(item => ({ item, id: String(item.id), hash: itemHashOf(item) }));
  const unchanged = hashed.filter(h => isUnchanged(stored.get(h.id), h.item, h.hash)).map(h => h.id);
  const healedIds = await missingFromIndex(documentId, unchanged, stored, opts.indexed,
    opts.healBudget || healBudget());
  const healed = new Set(healedIds);
  const skip = new Set(unchanged.filter(id => !healed.has(id)));
  const operations = hashed.filter(h => !skip.has(h.id)).map(({ item, hash }) => (
    { operationType: 'Upsert', partitionKey: pk, resourceBody: { ...item, [HASH_FIELD]: hash } }));
  logSkipped(documentId, chunkItems.length, operations.length, healedIds);
  return operations;
}

function logSkipped(documentId, total, sent, healedIds) {
  const healed = healedIds.length;
  if (healed > 0) {
    // Ids in the message, not meta: the deployed format prints the message alone. At most
    // MAX_HEALED_PER_INGEST of them, and they name what the index lost so its cause can be traced.
    logger.warn(`[chunks] doc=${documentId} healed=${healed} unchanged chunks the index lacked: ` +
      healedIds.join(','));
  }
  if (sent < total) {
    logger.info(`[chunks] doc=${documentId} unchanged=${total - sent} ` +
      `upserted=${sent - healed} healed=${healed}`);
  }
}

/**
 * Id, parent fields and version of every chunk of one document, never `content`. The backfill
 * compares them to the document, so it also catches a stale value whose fix is `null`.
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
 * Whether a chunk holds exactly what the document says. The version counts: a chunk stamped before
 * the list grew agrees on every field it knows, and the backfill would skip it.
 */
function chunkMatchesParent(chunk, fields) {
  return (chunk.parentFieldsVersion ?? null) === (fields.parentFieldsVersion ?? null) &&
    CHUNK_PARENT_FIELDS.every(field => (chunk[field] ?? null) === fields[field]);
}

/**
 * Replace a document's chunks: upsert, then delete surplus, so a live document never has zero chunks.
 *
 * @param {string} documentId
 * @param {Array}  chunkItems  fully-formed items; each MUST carry a non-empty read[]
 */
/** `bulkVerified`'s return shape for a call that had nothing to send. */
function noWrites() {
  return { succeeded: 0, failed: 0, statusCounts: {}, requestCharge: 0 };
}

function assertAcl(chunkItems) {
  for (const item of chunkItems) {
    // Fail closed: a chunk with no ladder token matches nobody but privileged callers.
    if (!Array.isArray(item.read) || item.read.length === 0) {
      throw new TypeError('[chunks] every chunk requires a non-empty read[] ACL');
    }
  }
}

/**
 * Upsert one batch of a streamed ingest, leaving surplus: pair every stream with `deleteSurplus`. Reads
 * only this batch's hashes; pass one `opts.healBudget` to every batch, or each heals up to the cap.
 */
async function upsertBatch(access, documentId, chunkItems, opts = {}) {
  assertAcl(chunkItems);
  if (chunkItems.length === 0) return noWrites();

  const stored = await storedHashes(access, documentId, chunkItems.map(i => i.id));
  const operations = await changedUpserts(documentId, chunkItems, stored, opts);
  if (operations.length === 0) return noWrites();
  return cosmos.bulkVerified(CONTAINER, operations);
}

/**
 * Rewrite the ACL copied onto every chunk of one document at ingest. The bulk PATCH advances `_ts`,
 * so the `_ts`-driven indexer sees it; an upsert would read back every chunk's `content` first.
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
    // `isPublished` mirrors `read[]` here as everywhere; nothing reads it while `read[]` is set, but
    // `/isPublished` is indexed, and a stale mirror is how the two come to disagree.
    isPublished: read.includes('public')
  });
}

/**
 * Set one field map on every chunk of a document; `bulkVerified` splits at the 100-operation cap.
 *
 * @param {object} fields  Cosmos property name -> value; a key left out keeps the chunk's value
 * @param {{stampedAt?: string}} [opts]  see `setFieldsForChunks`
 */
async function setFieldsForDocument(access, documentId, fields, opts = {}) {
  const ids = await idsForDocument(access, documentId);
  return setFieldsForChunks(access, documentId, ids, fields, opts);
}

/**
 * The same PATCH on named chunks, for the backfill. `opts.stampedAt` guards each write against a newer
 * walk (`skippedNewer`), absent = unconditional; the other two override the bulk retry budget.
 *
 * @param {string[]} ids  chunk ids, all of `documentId`'s partition
 * @param {{stampedAt?: string, maxAttempts?: number, maxBackoffMs?: number}} [opts]
 */
async function setFieldsForChunks(
  access, documentId, ids, fields, { stampedAt, maxAttempts, maxBackoffMs } = {}
) {
  if (Object.keys(fields).length === 0) {
    throw new TypeError('[chunks] a chunk patch requires at least one field');
  }
  const guarded = stampedAt !== undefined;
  // A patched row differs from the hash its ingest wrote, so the next re-post must rewrite it.
  const patchFields = {
    ...fields,
    [HASH_FIELD]: null,
    ...(guarded ? { [STAMPED_AT_FIELD]: assertStampedAt(stampedAt) } : {})
  };
  const operations = Object.entries(patchFields).map(([key, value]) => ({
    op: 'set', path: `/${key}`, value
  }));
  if (!ids || ids.length === 0) {
    return { succeeded: 0, failed: 0, skippedNewer: 0, statusCounts: {}, requestCharge: 0, chunks: 0 };
  }

  // One bulk request per 100 chunks: the condition rides each Patch, and `bulkVerified` reports a
  // rejected one as `skippedIds` without retrying. Per-chunk requests would cost a round trip each.
  const pk = String(documentId);
  const resourceBody = guarded
    ? { operations, condition: stampCondition(stampedAt) }
    : { operations };
  const result = await cosmos.bulkVerified(CONTAINER, ids.map(id => ({
    operationType: 'Patch',
    partitionKey: pk,
    id: String(id),
    resourceBody
  })), { maxAttempts, maxBackoffMs });

  // A chunk a NEWER walk already stamped is not a failure: the value on it is at least as current
  // as this walk's. Unguarded writes carry no condition, so nothing is ever skipped there.
  return { ...result, skippedNewer: result.skippedIds.length, chunks: ids.length };
}

/**
 * Re-stamp a document's filter fields onto its chunks; the patch advances `_ts` so the indexer sees
 * it. Call only when a value moved (`parentFieldsChanged`): this walks every chunk.
 *
 * @param {{stampedAt?: string}} [opts]  the walk's instant: the pending token, else its start; absent = unconditional
 */
async function setParentFieldsForDocument(access, documentId, document, opts = {}) {
  return setFieldsForDocument(access, documentId, parentFieldsOf(document), opts);
}

/**
 * Failing documents an error log names before going quiet. Counted in documents, so `onError` fires
 * once per document: a cap in chunk operations (~19 per document) would go quiet almost at once.
 */
const MAX_LOGGED_RESTAMP_ERRORS = 20;

/**
 * Re-stamp each document whose row write landed, skipping `failedIds`; throws are counted, never
 * rethrown. `chunks` and `failedChunks` count chunk operations, the rest count documents.
 *
 * @param {Array}    docs       documents whose parent fields moved; each must carry `id`
 * @param {string[]} failedIds  ids whose document-row write was rejected
 * @param {object}   [opts]     `onError(doc, err)` once per throwing document; `stampedAt` (see `setFieldsForChunks`); `stamp` test seam
 * @returns {{stamped: number, failedDocuments: number, failedChunks: number, skipped: number, skippedNewer: number, chunks: number, requestCharge: number, statusCounts: object, stampedDocumentIds: string[], failedDocumentIds: string[]}}
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
    // One rejected operation leaves the chunks mixed, which is what the repair is for; a chunk a newer
    // walk stamped is not a rejection.
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
 * `cosmos.bulk` with a Delete that finds no row counted as landed: the row is gone, which is what
 * the delete asked for. `bulkVerified` would otherwise retry it and then report it lost.
 */
async function bulkGoneIsDeleted(operations) {
  const results = await cosmos.bulk(CONTAINER, operations);
  return results.map((r, i) => (r && r.statusCode === 404 && operations[i].operationType === 'Delete'
    ? { ...r, statusCode: 204 }
    : r));
}

/**
 * Unindex `surplusIds` before Cosmos deletes them, keeping any id the index still holds, so a request
 * that dies between the two deletes leaves its retry something to find.
 *
 * @param {Function} [unindex]  (chunkIds) => { [reason]: chunk ids kept in the index }, reasons from INDEX_KEPT; absent = no index to clear
 */
async function unindexFirst(surplusIds, unindex) {
  if (!unindex || surplusIds.length === 0) return { deletable: surplusIds, kept: {} };
  const kept = await unindex(surplusIds);
  const held = new Set(Object.values(kept).flat().map(String));
  return { deletable: surplusIds.filter(id => !held.has(id)), kept };
}

/** Why the index kept a chunk: it would not delete it, or no index is configured to ask. */
const INDEX_KEPT = ['stillIndexed', 'indexUnconfigured'];

/**
 * Write `operations`, then count the chunks kept back for the index as failed too, so the caller's
 * single `failed` check turns the request into a retry. Each reason gets its own status count.
 */
async function writeVerified(operations, kept) {
  // bulkVerified, never bulk: bulk does not throw on partial failure, so counting what was sent
  // over-reports what was written.
  let result = operations.length === 0
    ? noWrites()
    : await cosmos.bulkVerified(CONTAINER, operations, { bulkFn: bulkGoneIsDeleted });
  for (const [reason, ids] of Object.entries(kept)) {
    if (ids.length === 0) continue;
    result = {
      ...result,
      failed: result.failed + ids.length,
      failedIds: [...(result.failedIds || []), ...ids],
      statusCounts: { ...result.statusCounts, [reason]: ids.length }
    };
  }
  return result;
}

/** True when every failed chunk is one the index kept, i.e. Cosmos wrote everything it was sent. */
function onlyIndexKept(result) {
  const counts = result.statusCounts || {};
  const kept = INDEX_KEPT.reduce((sum, reason) => sum + (counts[reason] || 0), 0);
  return result.failed > 0 && result.failed === kept;
}

const deleteOp = (pk) => (id) => ({ operationType: 'Delete', partitionKey: pk, id });

/**
 * Delete every chunk of this document not in `keepIds`, the tail of a streamed replace. Indexers never
 * see deletes, so `opts.unindex` runs first (`unindexFirst`), or the old text stays searchable.
 */
async function deleteSurplus(access, documentId, keepIds, opts = {}) {
  const pk = String(documentId);
  const keep = new Set(Array.from(keepIds, String));

  const surplus = (await idsForDocument(access, documentId))
    .map(String)
    .filter(id => !keep.has(id));

  const { deletable, kept } = await unindexFirst(surplus, opts.unindex);
  return writeVerified(deletable.map(deleteOp(pk)), kept);
}

async function replaceForDocument(access, documentId, chunkItems, opts = {}) {
  const pk = String(documentId);

  assertAcl(chunkItems);

  const stored = await storedHashes(access, documentId);
  const keep = new Set(chunkItems.map(i => String(i.id)));

  const operations = await changedUpserts(documentId, chunkItems, stored, opts);

  const surplus = [...stored.keys()].filter(id => !keep.has(id));
  const { deletable, kept } = await unindexFirst(surplus, opts.unindex);
  operations.push(...deletable.map(deleteOp(pk)));

  // Same shape as bulkVerified's return — `failed` is a COUNT, so callers can test it uniformly.
  return writeVerified(operations, kept);
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
  onlyIndexKept,
  MAX_HEALED_PER_INGEST,
  healBudget,
  INDEX_SETTLE_SECONDS,
  removeForDocument
};
