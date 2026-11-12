'use strict';

/**
 * Collapse chunk hits into one row per document, keeping BM25 order. AI Search has no group-by;
 * the row shape is the one eagle-public's content-result card and DEMI's frontend both bind.
 */

// Chunks fetched per document on a page; too small and a page silently returns fewer documents.
const FANOUT = 10;

/** Snippets shown per document. The request asks for one fragment per chunk. */
const MAX_SNIPPETS = 2;

/**
 * Chunks to fetch for a page. The ceiling has no default: callers pass `SERVICE_MAX_TOP`, so a
 * page stays one service request and no second copy of the limit can drift.
 */
function windowFor(pageSize, ceiling) {
  if (!Number.isFinite(ceiling) || ceiling < 1) {
    throw new TypeError('[group-chunks] windowFor needs the caller\'s fetch ceiling');
  }
  return Math.min(Math.max(Number(pageSize) || 1, 1) * FANOUT, ceiling);
}

/**
 * One passage: snippet text plus its page. `pageNumber` is nulled when `pageNumbered` is false,
 * because then it is a passage sequence, not a PDF page.
 */
function passageFrom(row) {
  const pageNumbered = row.pageNumbered === true;
  return {
    text: row.snippet,
    pageNumber: pageNumbered ? row.pageNumber ?? null : null,
    pageNumbered
  };
}

/**
 * Group chunk rows into document rows. No `pageSize` slice: the window is the page, and slicing
 * would skip documents for good. `matchCount` counts this window only.
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
        // A label, not an id: the eagle-public chunk card binds `milestone` raw, with no `idToList`.
        // Prod emits both, so `milestoneId` rides beside it.
        milestone: row.milestone || null,
        milestoneId: row.milestoneId || null,
        datePosted: row.datePosted || null,
        pageNumber: row.pageNumber,
        // Every chunk of one document agrees on it, so the lead chunk answers for all.
        pageNumbered: row.pageNumbered,
        content: '',
        snippet: row.snippet || '',
        snippets: [],
        // Same texts as `snippets`, same order, each with the page of the chunk that produced it.
        passages: [],
        matchCount: 0
      });
    }

    const doc = byDocument.get(id);
    doc.matchCount++;
    if (row.snippet && doc.snippets.length < MAX_SNIPPETS) {
      doc.snippets.push(row.snippet);
      doc.passages.push(passageFrom(row));
    }
  }

  return [...byDocument.values()];
}

module.exports = { groupByDocument, windowFor, FANOUT, MAX_SNIPPETS };
