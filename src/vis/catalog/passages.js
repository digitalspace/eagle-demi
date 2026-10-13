'use strict';

/**
 * Field visibility policy for a native passage row (`GET /documents/passages`): one chunks-index
 * hit, shaped in `src/controllers/native/passages.js`. Same contract as catalog/chunks.js, whose
 * entries these restate; the gate is still the parent document.
 *
 * `snippet` is 4/4 where chunk `content` is 0/0: it is the index's highlight of the matched terms,
 * escaped, never the whole chunk. `content` is not listed, so the redactor drops it if a row ever
 * carried it.
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
