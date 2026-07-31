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
const { eq, selectWhere, pageOptions } = require('./_sql');

/**
 * `chunks` is the only chunk container. A second one, `chunks_fts`, briefly existed because a
 * full-text policy is IMMUTABLE and could not be added to this one in place — that whole approach
 * was ruled out on 2026-07-31 (fuzzy is a silent no-op even enrolled, MIGRATION.md §F), and the
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
  chunkId,
  listVisible,
  getById,
  idsForDocument,
  replaceForDocument,
  removeForDocument
};
