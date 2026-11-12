'use strict';

/**
 * Field visibility for a native passage row (`GET /documents/passages`). `snippet` is 4/4 because
 * it is the escaped highlight, never the whole chunk; `content` is unlisted so it is dropped.
 */
module.exports = {
  id: { defaultVis: 4, maxVis: 4 },
  documentId: { defaultVis: 4, maxVis: 4 },
  projectId: { defaultVis: 4, maxVis: 4 },
  pageNumber: { defaultVis: 4, maxVis: 4 },
  pageNumbered: { defaultVis: 4, maxVis: 4 },
  snippet: { defaultVis: 4, maxVis: 4 },

  // Filter-only: the parent's list refs the chunk repeats (catalog/chunks.js). Rows do not carry
  // them; they are listed so `assertFilterable` admits the filters.
  typeId: { defaultVis: 4, maxVis: 4 },
  milestoneId: { defaultVis: 4, maxVis: 4 },
  projectPhaseId: { defaultVis: 4, maxVis: 4 },
  documentAuthorTypeId: { defaultVis: 4, maxVis: 4 }
};
