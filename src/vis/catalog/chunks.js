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

  // The parent document's filter metadata, repeated on the chunk so a chunk query can filter on it
  // (`chunks.CHUNK_PARENT_FIELDS`). Same classification as the columns they are copied from —
  // catalog/documents.js has all four at 4/4 — because they ARE those columns: a List ObjectId is
  // the value eagle-public's filter panel already sends, and a chunk carrying one says nothing
  // about the document that its own row does not.
  typeId: { defaultVis: 4, maxVis: 4 },
  milestoneId: { defaultVis: 4, maxVis: 4 },
  projectPhaseId: { defaultVis: 4, maxVis: 4 },
  documentAuthorTypeId: { defaultVis: 4, maxVis: 4 },

  // Which revision of that list the four above were stamped under (`chunks.CHUNK_PARENT_FIELDS_VERSION`).
  // 4/4 like the fields it describes: it is a small integer that says how current a stamp is, and
  // it carries nothing about the document beyond what those fields already say. The completeness
  // probe filters on it, so it has to survive the response boundary the same way they do.
  parentFieldsVersion: { defaultVis: 4, maxVis: 4 },

  // Which re-stamp walk last wrote the fields above (`chunks.STAMPED_AT_FIELD`). 0/0: it orders
  // writers against each other and says nothing a caller can use — no response carries it and the
  // chunks index does not declare it.
  parentStampedAt: { defaultVis: 0, maxVis: 0 },

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
