'use strict';

/**
 * Field visibility for a mirrored Eagle `User` (rules in catalog/projects.js). Every contact field
 * is 2/2, even on a published user row; `password` and `salt` are never stored.
 */
const ROW_PLANE = require('./row-plane');

module.exports = {
  ...ROW_PLANE,

  firstName: { defaultVis: 4, maxVis: 4 },
  middleName: { defaultVis: 4, maxVis: 4 },
  lastName: { defaultVis: 4, maxVis: 4 },
  displayName: { defaultVis: 4, maxVis: 4 },
  salutation: { defaultVis: 4, maxVis: 4 },
  title: { defaultVis: 4, maxVis: 4 },
  department: { defaultVis: 4, maxVis: 4 },
  org: { defaultVis: 4, maxVis: 4 },
  orgName: { defaultVis: 4, maxVis: 4 },

  email: { defaultVis: 2, maxVis: 2 },
  phoneNumber: { defaultVis: 2, maxVis: 2 },
  cellPhoneNumber: { defaultVis: 2, maxVis: 2 },
  faxNumber: { defaultVis: 2, maxVis: 2 },
  address1: { defaultVis: 2, maxVis: 2 },
  address2: { defaultVis: 2, maxVis: 2 },
  city: { defaultVis: 2, maxVis: 2 },
  province: { defaultVis: 2, maxVis: 2 },
  country: { defaultVis: 2, maxVis: 2 },
  postalCode: { defaultVis: 2, maxVis: 2 },
  notes: { defaultVis: 2, maxVis: 2 },

  // Stamped by a DEMI write (domain/users.js); the mirror does not carry them.
  addedBy: { defaultVis: 2, maxVis: 2 },
  updatedBy: { defaultVis: 2, maxVis: 2 },
  dateAdded: { defaultVis: 2, maxVis: 2 },
  dateUpdated: { defaultVis: 2, maxVis: 2 }
};
