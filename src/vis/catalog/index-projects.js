'use strict';

/**
 * Field visibility policy for an AI Search PROJECT hit. Same contract as catalog/projects.js, but
 * keyed on INDEX field names: the data source renames columns on the way in
 * (`azure/search/datasources/demi-projects-ds.json` — `abbreviation AS displayName`,
 * `proponentName AS proponent`, `projectState AS status`, `eagleId AS legacyEagleId`,
 * `projectType AS type`), so a hit and a stored row do not share a vocabulary.
 *
 * Every field of `azure/search/indexes/projects.json` has an entry; test/vis/search-drift.test.js
 * holds that against the committed index definition.
 */
module.exports = {
  id: { defaultVis: 4, maxVis: 4 },
  name: { defaultVis: 4, maxVis: 4 },
  displayName: { defaultVis: 4, maxVis: 4 },
  description: { defaultVis: 4, maxVis: 4 },
  proponent: { defaultVis: 4, maxVis: 4 },
  sector: { defaultVis: 4, maxVis: 4 },
  status: { defaultVis: 4, maxVis: 4 },
  region: { defaultVis: 4, maxVis: 4 },
  legacyEagleId: { defaultVis: 4, maxVis: 4 },
  centroid: { defaultVis: 4, maxVis: 4 },
  isPublished: { defaultVis: 4, maxVis: 4 },
  type: { defaultVis: 4, maxVis: 4 },
  currentPhaseName: { defaultVis: 4, maxVis: 4 },
  currentPhaseNameId: { defaultVis: 4, maxVis: 4 },
  eacDecision: { defaultVis: 4, maxVis: 4 },
  eacDecisionId: { defaultVis: 4, maxVis: 4 },
  ceaaInvolvementId: { defaultVis: 4, maxVis: 4 },
  decisionDate: { defaultVis: 4, maxVis: 4 },
  sourceSystem: { defaultVis: 4, maxVis: 4 },

  // Not an index field: the marked-up copy of `name`/`displayName`/`description` that
  // `searchProjects` attaches. It cannot outrank its sources, which are all 4.
  highlighted: { defaultVis: 4, maxVis: 4 },

  // The caller's own ACL restated. `isPublished` is derived from it in the redactor.
  read: { defaultVis: 0, maxVis: 0 },

  // The dial map itself. Selected so the redactor can read it, published to nobody.
  vis: { defaultVis: 0, maxVis: 0 }
};
