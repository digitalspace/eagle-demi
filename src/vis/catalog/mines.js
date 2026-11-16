'use strict';

/**
 * Field visibility for the `mines` container: one row per NRPTI mine and linked EPIC project.
 * The upstream reference is staff-only.
 */
const ROW_PLANE = require('./row-plane');

module.exports = {
  ...ROW_PLANE,
  projectId: { defaultVis: 4, maxVis: 4 },
  mineId: { defaultVis: 4, maxVis: 4 },
  mineNo: { defaultVis: 4, maxVis: 4 },
  name: { defaultVis: 4, maxVis: 4 },
  permitNumber: { defaultVis: 4, maxVis: 4 },
  permittee: { defaultVis: 4, maxVis: 4 },
  status: { defaultVis: 4, maxVis: 4 },
  type: { defaultVis: 4, maxVis: 4 },
  commodities: { defaultVis: 4, maxVis: 4 },
  region: { defaultVis: 4, maxVis: 4 },
  tailingsImpoundments: { defaultVis: 4, maxVis: 4 },
  location: { defaultVis: 4, maxVis: 4 },
  summary: { defaultVis: 4, maxVis: 4 },
  description: { defaultVis: 4, maxVis: 4 },
  links: { defaultVis: 4, maxVis: 4 },
  syncedAt: { defaultVis: 4, maxVis: 4 },
  source: { defaultVis: 2, maxVis: 2 }
};
