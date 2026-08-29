'use strict';

const indexProjects = require('./index-projects');

/**
 * Stored project field -> the index column(s) it becomes. `PATCH /projects/:id/visibility` stores
 * dial keys in the COSMOS vocabulary, but a search hit arrives in the INDEX one because the data
 * source renames columns (`azure/search/datasources/demi-projects-ds.json`), so a dial must be
 * translated before it is applied to a hit. Values are arrays: one stored object fans out to a
 * label column and an id column. Held from both directions: test/vis/search-drift.test.js checks
 * the entries that exist against the catalogs, and test/azure/search-datasource-columns.test.js
 * checks that every alias the data source introduces has an entry here — a rename with none is a
 * dial that resolves to no field on a hit and is dropped without an error.
 */
const PROJECT_TO_INDEX = {
  abbreviation: ['displayName'],
  proponentName: ['proponent'],
  projectState: ['status'],
  eagleId: ['legacyEagleId'],
  projectType: ['type'],
  CEAAInvolvement: ['ceaaInvolvementId'],
  currentPhaseName: ['currentPhaseName', 'currentPhaseNameId'],
  eacDecision: ['eacDecision', 'eacDecisionId']
};

/**
 * The same dials restated on index field names. A key that does not rename passes through; a key
 * with no index counterpart is dropped, because there is nothing on a hit for it to restrict.
 * Object.hasOwn: the dials are parsed from an index column, so `constructor` must not resolve.
 */
function dialsForIndex(dials) {
  const out = {};
  for (const [key, dial] of Object.entries(dials)) {
    const targets = Object.hasOwn(PROJECT_TO_INDEX, key) ? PROJECT_TO_INDEX[key]
      : Object.hasOwn(indexProjects, key) ? [key] : [];
    for (const target of targets) out[target] = dial;
  }
  return out;
}

module.exports = { PROJECT_TO_INDEX, dialsForIndex };
