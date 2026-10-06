'use strict';

/**
 * Field visibility policy for a mirrored Eagle `User`. See catalog/projects.js for the rules.
 *
 * EVERY CONTACT FIELD IS 2/2: email, the phone and fax numbers and the postal address reach staff
 * and never the public, even on a user row Eagle published. The name card is 4/4 and still hidden
 * behind the row ACL, which Eagle's default `['sysadmin']` lands at level 2. Eagle's `password` and
 * `salt` are never stored, so neither is catalogued.
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
  notes: { defaultVis: 2, maxVis: 2 }
};
