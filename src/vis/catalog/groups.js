'use strict';

/**
 * Field visibility policy for a mirrored Eagle `Group`, a project's contact group. See
 * catalog/projects.js for the rules. Membership names people, so `members` and `links` are 2/2.
 */
const ROW_PLANE = require('./row-plane');

module.exports = {
  ...ROW_PLANE,

  projectId: { defaultVis: 4, maxVis: 4 },
  name: { defaultVis: 4, maxVis: 4 },

  members: { defaultVis: 2, maxVis: 2 },
  links: { defaultVis: 2, maxVis: 2 },

  // Stamped by a DEMI write (domain/groups.js); the mirror does not carry them.
  addedBy: { defaultVis: 2, maxVis: 2 },
  updatedBy: { defaultVis: 2, maxVis: 2 },
  dateAdded: { defaultVis: 2, maxVis: 2 },
  dateUpdated: { defaultVis: 2, maxVis: 2 }
};
