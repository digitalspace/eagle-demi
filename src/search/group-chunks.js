'use strict';

/**
 * Collapse chunk hits into one result per DOCUMENT.
 *
 * A chunk is a passage of a PDF, so a long report produces dozens of hits for one query. The reader
 * is looking for documents, not passages, and a page where one report crowds out nine others is
 * worse than a shorter list.
 *
 * WHY HERE AND NOT IN THE QUERY. Azure AI Search has no result collapsing and no group-by.
 * Microsoft's own guidance for a chunk-per-row index is to carry a parent `documentId` and group in
 * application code at query time, which is this file.
 *
 * PORTED FROM `eagle-search/service/group.js:38-86`, deliberately: eagle-public's content-search
 * card binds the shape that file produces — `snippets[]` (`content-result.component.html:20,24`),
 * `matchCount` (`content-result.component.ts:44`) and a download URL built from `_id`
 * (`:36-39`, which expects a DOCUMENT id). Against the ungrouped shape every card renders
 * "0 matches" with no snippet body and a download link pointing at a chunk id.
 *
 * WHAT IT DOES NOT DO: change the ranking. The first chunk of a document sets that document's
 * position, so BM25 order is preserved.
 *
 * DEMI'S OWN FRONTEND IS KEPT WORKING IN THE SAME ROW, not migrated: it reads `snippet` (singular),
 * `pageNumber` and `documentName` off chunk rows (`frontend/src/app/services/
 * registry-state.service.ts:1160-1175`). Those stay, taken from the lead chunk, and `chunkId`
 * carries the id `_id` used to hold. One row, both consumers — the same asymmetry the project-name
 * join already keeps.
 */

/**
 * Chunks fetched per page of documents.
 *
 * 10 per document is generous — eagle-search measured the worst case near 3 — but the cost is
 * asymmetric: too small and a page silently returns four documents, too large and we read extra
 * rows from an index that is already fast.
 */
const FANOUT = 10;

/** Snippets shown per document. The request asks for one fragment per chunk. */
const MAX_SNIPPETS = 2;

/** Rows to fetch for a requested page of documents, clamped to Azure's `$top` maximum. */
function windowFor(pageSize) {
  return Math.min(Math.max(Number(pageSize) || 1, 1) * FANOUT, 1000);
}

/**
 * Group mapped chunk rows into document rows, preserving order.
 *
 * `pageNumber` IS NOT A PDF PAGE and is not surfaced as one. It is a passage sequence number — the
 * chunker increments it per emitted block — so nothing here renders "jump to page N" from it.
 * `matchCount` is the honest count.
 */
function groupByDocument(rows, pageSize) {
  const byDocument = new Map();

  for (const row of rows) {
    const id = String(row.documentId || '');
    if (!id) continue;

    if (!byDocument.has(id)) {
      // The FIRST chunk of a document is its highest-scoring one, so its metadata and its snippet
      // lead. Everything after it only adds snippets and to the count.
      byDocument.set(id, {
        _id: id,
        _schemaName: 'DocumentChunk',
        documentId: id,
        // The id `_id` used to carry, kept rather than dropped: it is the only handle on the
        // specific passage that matched, and losing it would make a citation unresolvable.
        chunkId: row._id,
        projectId: row.projectId,
        project: row.project,
        projectName: row.projectName,
        documentName: row.documentName,
        documentType: row.documentType,
        pageNumber: row.pageNumber,
        content: '',
        snippet: row.snippet || '',
        snippets: [],
        matchCount: 0
      });
    }

    const doc = byDocument.get(id);
    doc.matchCount++;
    if (row.snippet && doc.snippets.length < MAX_SNIPPETS) doc.snippets.push(row.snippet);
  }

  // Only the DOCUMENTS are truncated to the page size. Truncating the chunk rows first would drop
  // matches and snippets from documents that are still on the page.
  return [...byDocument.values()].slice(0, Math.max(Number(pageSize) || 1, 1));
}

module.exports = { groupByDocument, windowFor, FANOUT, MAX_SNIPPETS };
