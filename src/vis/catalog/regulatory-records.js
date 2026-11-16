'use strict';

/**
 * Field visibility for the `regulatoryRecords` container: NRPTI inspections, orders, permits and
 * the like, linked to an EPIC project. The upstream reference is staff-only.
 */
const ROW_PLANE = require('./row-plane');

module.exports = {
  ...ROW_PLANE,
  projectId: { defaultVis: 4, maxVis: 4 },
  kind: { defaultVis: 4, maxVis: 4 },
  title: { defaultVis: 4, maxVis: 4 },
  subtype: { defaultVis: 4, maxVis: 4 },
  issuedAt: { defaultVis: 4, maxVis: 4 },
  issuingAgency: { defaultVis: 4, maxVis: 4 },
  summary: { defaultVis: 4, maxVis: 4 },
  documents: { defaultVis: 4, maxVis: 4 },
  syncedAt: { defaultVis: 4, maxVis: 4 },
  // Can name a private person. NRPTI's own age rule is not carried, so staff only until a dial raises it.
  issuedTo: { defaultVis: 2, maxVis: 4 },
  source: { defaultVis: 2, maxVis: 2 }
};
