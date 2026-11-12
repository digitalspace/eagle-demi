'use strict';

/**
 * Field visibility for a stored chunk's metadata. Chunk access follows the parent document;
 * this table adds no chunk-level classification.
 */
module.exports = {
  // Structural / identity. `id` is `documentId::p<page>::c<index>`, so it restates the three below.
  id: { defaultVis: 4, maxVis: 4 },
  documentId: { defaultVis: 4, maxVis: 4 },
  projectId: { defaultVis: 4, maxVis: 4 },
  pageNumber: { defaultVis: 4, maxVis: 4 },
  // True when `pageNumber` is a real PDF page, not a passage number. 4/4 like the number,
  // so a caller can tell "Page 12" from "Passage 12".
  pageNumbered: { defaultVis: 4, maxVis: 4 },
  chunkIndex: { defaultVis: 4, maxVis: 4 },
  extractedAt: { defaultVis: 4, maxVis: 4 },

  // Parent document filter fields copied onto the chunk (`chunks.CHUNK_PARENT_FIELDS`).
  // Same levels as the document columns they copy.
  typeId: { defaultVis: 4, maxVis: 4 },
  milestoneId: { defaultVis: 4, maxVis: 4 },
  projectPhaseId: { defaultVis: 4, maxVis: 4 },
  documentAuthorTypeId: { defaultVis: 4, maxVis: 4 },

  // `chunks.CHUNK_PARENT_FIELDS_VERSION`. 4/4 because the completeness probe filters on it.
  parentFieldsVersion: { defaultVis: 4, maxVis: 4 },

  // Orders re-stamp writers (`chunks.STAMPED_AT_FIELD`); no response or index carries it.
  parentStampedAt: { defaultVis: 0, maxVis: 0 },

  // Hash of the stored row (`chunks.itemHashOf`) that lets a re-post skip unchanged chunks. 0/0 for
  // the same reason: bookkeeping between writers, no response carries it.
  itemHash: { defaultVis: 0, maxVis: 0 },

  // No response ships chunk text; summarize reads it off the raw row.
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
