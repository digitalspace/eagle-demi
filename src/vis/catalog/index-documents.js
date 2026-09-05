'use strict';

/**
 * Field visibility policy for an AI Search DOCUMENT hit, keyed on INDEX field names — same reason as
 * catalog/index-projects.js. Most names match `catalog/documents.js`, but not all: the data source
 * projects `c.documentFileName AS fileNameTokens`, and this table also classifies `highlighted`,
 * which no stored document carries. The index is what a hit carries and it is PUT independently of
 * the container, so the two tables stay separate.
 *
 * Every field of `azure/search/indexes/documents.json` has an entry; test/vis/search-drift.test.js
 * holds that against the committed index definition.
 */
module.exports = {
  id: { defaultVis: 4, maxVis: 4 },
  displayName: { defaultVis: 4, maxVis: 4 },
  documentFileName: { defaultVis: 4, maxVis: 4 },
  description: { defaultVis: 4, maxVis: 4 },
  type: { defaultVis: 4, maxVis: 4 },
  projectId: { defaultVis: 4, maxVis: 4 },
  isPublished: { defaultVis: 4, maxVis: 4 },
  typeId: { defaultVis: 4, maxVis: 4 },
  milestoneId: { defaultVis: 4, maxVis: 4 },
  projectPhaseId: { defaultVis: 4, maxVis: 4 },
  documentAuthorTypeId: { defaultVis: 4, maxVis: 4 },
  datePosted: { defaultVis: 4, maxVis: 4 },
  milestone: { defaultVis: 4, maxVis: 4 },
  projectPhase: { defaultVis: 4, maxVis: 4 },
  documentAuthorType: { defaultVis: 4, maxVis: 4 },
  legislation: { defaultVis: 4, maxVis: 4 },
  isFeatured: { defaultVis: 4, maxVis: 4 },
  documentSource: { defaultVis: 4, maxVis: 4 },
  // Bytes. Shipped as `internalSize`, Eagle's name for it, so eagle-public can size a bulk download.
  fileSize: { defaultVis: 4, maxVis: 4 },
  // `documentFileName` under the filename analyzer, so it carries no further data. Not retrievable,
  // so no hit carries it; classified anyway, because retrievable is one index PUT away.
  fileNameTokens: { defaultVis: 4, maxVis: 4 },
  // The natural-sort key. Not retrievable either, but `buildOrderBy` gates a sort key on this
  // table, so an uncatalogued field would be dropped from every order it appears in.
  displayNameSort: { defaultVis: 4, maxVis: 4 },

  // Not an index field: the marked-up copy of `displayName`/`description` that `searchDocuments`
  // attaches. It cannot outrank its sources, which are both 4.
  highlighted: { defaultVis: 4, maxVis: 4 },

  // The caller's own ACL restated. `isPublished` is derived from it in the redactor.
  read: { defaultVis: 0, maxVis: 0 }
};
