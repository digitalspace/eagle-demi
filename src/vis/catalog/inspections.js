'use strict';

/**
 * Field visibility for the `inspections` container, one entity per kind because the kinds carry
 * different fields. Inspector email, stored-file internals and row authorship are 2/2.
 */
const ROW_PLANE = require('./row-plane');

const SHARED = {
  ...ROW_PLANE,
  kind: { defaultVis: 4, maxVis: 4 },
  projectId: { defaultVis: 4, maxVis: 4 },
  inspection: { defaultVis: 4, maxVis: 4 },
  dateAdded: { defaultVis: 4, maxVis: 4 },
  dateUpdated: { defaultVis: 4, maxVis: 4 },
  // Written by the ACL cascade.
  updatedAt: { defaultVis: 4, maxVis: 4 },
  addedBy: { defaultVis: 2, maxVis: 2 },
  updatedBy: { defaultVis: 2, maxVis: 2 }
};

const inspections = {
  ...SHARED,
  inspectionId: { defaultVis: 4, maxVis: 4 },
  name: { defaultVis: 4, maxVis: 4 },
  label: { defaultVis: 4, maxVis: 4 },
  case: { defaultVis: 4, maxVis: 4 },
  startDate: { defaultVis: 4, maxVis: 4 },
  endDate: { defaultVis: 4, maxVis: 4 },
  customProjectName: { defaultVis: 4, maxVis: 4 },
  elements: { defaultVis: 4, maxVis: 4 },
  email: { defaultVis: 2, maxVis: 2 }
};

const inspectionElements = {
  ...SHARED,
  elementId: { defaultVis: 4, maxVis: 4 },
  title: { defaultVis: 4, maxVis: 4 },
  requirement: { defaultVis: 4, maxVis: 4 },
  description: { defaultVis: 4, maxVis: 4 },
  timestamp: { defaultVis: 4, maxVis: 4 },
  items: { defaultVis: 4, maxVis: 4 }
};

const inspectionItems = {
  ...SHARED,
  element: { defaultVis: 4, maxVis: 4 },
  itemId: { defaultVis: 4, maxVis: 4 },
  type: { defaultVis: 4, maxVis: 4 },
  uri: { defaultVis: 4, maxVis: 4 },
  geo: { defaultVis: 4, maxVis: 4 },
  caption: { defaultVis: 4, maxVis: 4 },
  timestamp: { defaultVis: 4, maxVis: 4 },
  internalURL: { defaultVis: 2, maxVis: 2 },
  internalExt: { defaultVis: 2, maxVis: 2 },
  internalSize: { defaultVis: 2, maxVis: 2 },
  internalMime: { defaultVis: 2, maxVis: 2 }
};

module.exports = { inspections, inspectionElements, inspectionItems };
