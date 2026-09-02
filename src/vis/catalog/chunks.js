'use strict';

/**
 * Field visibility policy for a STORED chunk (container `chunks`). Same contract as
 * catalog/documents.js. Authored from the `src/chunker.js` output — `pageNumber`, `chunkIndex`,
 * `content` — plus the keys the ingest paths add (`id`, `documentId`, `projectId`, `read`,
 * `extractedAt`, src/controllers/nosql/document.js) and the Cosmos system fields.
 *
 * CHUNK CONTENT IS CLASSIFIED BY ITS PARENT DOCUMENT, not by the chunk, and the gate already works
 * that way: `src/controllers/search.js` withholds a chunk whose parent document the caller cannot
 * see, and `chunks.getById` re-applies `canRead`. This table classifies chunk METADATA only; it
 * adds no second plane and no chunk-level classification.
 *
 * `content` is 0/0 because no response ships chunk text — the chunk mapper sends `content: ''` and
 * the chunk `select` in `src/search/ai-search.js` never names it. There is no chunk read endpoint.
 * The one consumer of the text is the model call in `src/ai/summarize.js`, which reads it off the
 * raw row upstream of the response boundary.
 */
module.exports = {
  // Structural / identity. `id` is `documentId::p<page>::c<index>`, so it restates the three below.
  id: { defaultVis: 4, maxVis: 4 },
  documentId: { defaultVis: 4, maxVis: 4 },
  projectId: { defaultVis: 4, maxVis: 4 },
  pageNumber: { defaultVis: 4, maxVis: 4 },
  chunkIndex: { defaultVis: 4, maxVis: 4 },
  extractedAt: { defaultVis: 4, maxVis: 4 },

  // The extracted text itself, and the ACL snapshot taken from the parent at ingest.
  content: { defaultVis: 0, maxVis: 0 },
  read: { defaultVis: 0, maxVis: 0 },
  vis: { defaultVis: 0, maxVis: 0 },

  // Cosmos system fields.
  _rid: { defaultVis: 0, maxVis: 0 },
  _self: { defaultVis: 0, maxVis: 0 },
  _attachments: { defaultVis: 0, maxVis: 0 },
  _ts: { defaultVis: 0, maxVis: 0 },
  _etag: { defaultVis: 2, maxVis: 2 }
};
