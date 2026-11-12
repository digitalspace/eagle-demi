'use strict';

const indexProjects = require('./index-projects');

// Stored project field -> index column(s): dials are stored in Cosmos names, hits arrive renamed by the data
// source. A rename missing here drops its dial silently; search-datasource-columns.test.js guards that.
const PROJECT_TO_INDEX = {
  // `name` reaches the index twice: itself, and again as `nameTokens` under the `filename` analyzer.
  name: ['name', 'nameTokens'],
  tags: ['tags', 'tagsTokens'],
  abbreviation: ['displayName'],
  proponentName: ['proponent'],
  // The label columns reach the index a second time, joined into `searchLabels`.
  sector: ['sector', 'searchLabels'],
  projectSubType: ['projectSubType', 'searchLabels'],
  projectState: ['status', 'searchLabels'],
  region: ['region', 'searchLabels'],
  eagleId: ['legacyEagleId'],
  projectType: ['type', 'searchLabels'],
  CEAAInvolvement: ['ceaaInvolvementId'],
  currentPhaseName: ['currentPhaseName', 'currentPhaseNameId', 'searchLabels'],
  eacDecision: ['eacDecision', 'eacDecisionId', 'searchLabels'],
  activeWork: ['activeWorkId', 'activeWorkAct', 'activeWorkType', 'activeWorkPhase']
};

// Dials restated on index field names; a key with no index counterpart is dropped, as a hit has nothing
// for it to restrict. Object.hasOwn: the dials are parsed from an index column, so `constructor` must not resolve.
function dialsForIndex(dials) {
  // A stored `vis` of JSON `null` parses without throwing; treat anything but an object as no dials.
  if (!dials || typeof dials !== 'object' || Array.isArray(dials)) return {};
  const out = {};
  for (const [key, dial] of Object.entries(dials)) {
    const targets = Object.hasOwn(PROJECT_TO_INDEX, key) ? PROJECT_TO_INDEX[key]
      : Object.hasOwn(indexProjects, key) ? [key] : [];
    for (const target of targets) out[target] = dial;
  }
  return out;
}

/** The stored project fields a projects index column is built from; a column that does not rename is its own. */
function storedFieldsOf(column) {
  const sources = Object.keys(PROJECT_TO_INDEX).filter(field => PROJECT_TO_INDEX[field].includes(column));
  return sources.length ? sources : [column];
}

module.exports = { PROJECT_TO_INDEX, dialsForIndex, storedFieldsOf };
