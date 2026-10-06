'use strict';

/**
 * Field visibility policies for the `inspections` container: Eagle `Inspection`,
 * `InspectionElement` and `InspectionItem`, one entity each because the kinds carry different
 * fields. See catalog/projects.js for the rules. The inspector's `email` and the stored-file
 * internals are 2/2; who added or edited a row is 2/2, as on organizations.
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
