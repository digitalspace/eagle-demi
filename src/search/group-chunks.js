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

/**
 * Chunks to fetch for a requested page.
 *
 * THE CEILING IS REQUIRED AND IS THE CALLER'S, deliberately — no default. It has to be a number
 * that already exists somewhere else (`ai-search.SERVICE_MAX_TOP`), and a default here would be a
 * second copy of it, silently wrong the day that one moves. That is the failure this whole function
 * exists to prevent: the window was clamped to Azure's `$top` limit of 1000 while `runSearch`
 * clamps `top` to its own ceiling, so chunks past the clamp were never requested while `skip` still
 * advanced by the full window — the documents in them were reachable from no page at all.
 *
 * `SERVICE_MAX_TOP`, not `MAX_PAGE_ROWS`: one page must cost ONE service request. A chunk search
 * runs on every debounced keystroke against a Basic 1-SU service, and `runSearch`'s fill loop turns
 * a larger window into two requests per keystroke — the multiplier `ai-search.js` explicitly says
 * `pageSize` must not become.
 */
function windowFor(pageSize, ceiling) {
  if (!Number.isFinite(ceiling) || ceiling < 1) {
    throw new TypeError('[group-chunks] windowFor needs the caller\'s fetch ceiling');
  }
  return Math.min(Math.max(Number(pageSize) || 1, 1) * FANOUT, ceiling);
}

/**
 * Group mapped chunk rows into document rows, preserving order.
 *
 * NO PAGE-SIZE TRUNCATION, and this is the one deliberate divergence from the eagle-search original
 * (`service/group.js:86`, which slices to `pageSize`). Slicing loses documents outright: the caller
 * pages by WINDOW — `skip` advances a whole window per page — so any document grouped out of the
 * window and then sliced off the end is skipped past on the next page and reachable from none.
 * Measured on a 300-passage / 150-document corpus at pageSize=10: page 0 ended at d9 and page 1
 * began at d50, so 40 documents fell in the gap, and 30 of 150 documents were servable in total.
 *
 * So the WINDOW is the page. A page carries every document its window covered — between 1 and
 * `window` rows, more than `pageSize` whenever the matches are spread thin — and consecutive pages
 * cover consecutive, non-overlapping chunk ranges, which is what makes every match reachable.
 *
 * `pageNumber` IS NOT A PDF PAGE and is not surfaced as one. It is a passage sequence number — the
 * chunker increments it per emitted block — so nothing here renders "jump to page N" from it.
 *
 * `matchCount` is the count of that document's passages IN THIS WINDOW, which is the honest count
 * of what this page found — not necessarily of what the corpus holds. A document whose passages
 * straddle a window boundary is returned on BOTH pages, each carrying its own partial count;
 * measured on a 200-passage corpus with a document at chunks 99 and 100, pages 0 and 1 each showed
 * it with matchCount 1. Grouping per window with no carry-over is what makes paging stateless, and
 * a true per-document total would need either a second aggregate query or a cursor. Say the count
 * is per page rather than pretending otherwise.
 */
function groupByDocument(rows) {
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

  return [...byDocument.values()];
}

module.exports = { groupByDocument, windowFor, FANOUT, MAX_SNIPPETS };
