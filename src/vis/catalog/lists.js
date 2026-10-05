'use strict';

/**
 * Field visibility policy for the `lists` container — Eagle `List` and `Organization` rows, told
 * apart by `kind`. See catalog/projects.js for the rules.
 *
 * ONE catalog for both kinds, because one container has one entity name and `catalogFor` is keyed
 * on it. That is safe only while every field of both kinds carries the same policy, which it does:
 * a List row is a lookup label, and an Organization is its published business card plus staff-side
 * fields at 2/2 that a List row never carries. Add a second container before adding a field whose
 * two kinds would disagree.
 */
module.exports = {
  // Structural / identity.
  id: { defaultVis: 4, maxVis: 4 },
  eagleId: { defaultVis: 4, maxVis: 4 },
  kind: { defaultVis: 4, maxVis: 4 },
  sourceSystem: { defaultVis: 4, maxVis: 4 },
  isPublished: { defaultVis: 4, maxVis: 4 },

  // Shared by both kinds.
  name: { defaultVis: 4, maxVis: 4 },

  // `List`: the lookup label, its group, and the public BC Laws URL an entry can carry.
  type: { defaultVis: 4, maxVis: 4 },
  item: { defaultVis: 4, maxVis: 4 },
  legislation: { defaultVis: 4, maxVis: 4 },
  listOrder: { defaultVis: 4, maxVis: 4 },

  // `Organization`: the business card eagle-public renders for a proponent.
  companyType: { defaultVis: 4, maxVis: 4 },
  province: { defaultVis: 4, maxVis: 4 },
  country: { defaultVis: 4, maxVis: 4 },
  address1: { defaultVis: 4, maxVis: 4 },
  city: { defaultVis: 4, maxVis: 4 },
  postal: { defaultVis: 4, maxVis: 4 },
  website: { defaultVis: 4, maxVis: 4 },

  // `Organization` staff-side fields (`staffFields` in the organization mirror).
  description: { defaultVis: 2, maxVis: 2 },
  address2: { defaultVis: 2, maxVis: 2 },
  company: { defaultVis: 2, maxVis: 2 },
  companyLegal: { defaultVis: 2, maxVis: 2 },
  parentCompany: { defaultVis: 2, maxVis: 2 },
  addedBy: { defaultVis: 2, maxVis: 2 },
  updatedBy: { defaultVis: 2, maxVis: 2 },
  dateAdded: { defaultVis: 2, maxVis: 2 },
  dateUpdated: { defaultVis: 2, maxVis: 2 },

  // Never public. Same entries, same reasons, as catalog/projects.js.
  read: { defaultVis: 0, maxVis: 0 },
  sources: { defaultVis: 0, maxVis: 0 },
  vis: { defaultVis: 0, maxVis: 0 },

  _rid: { defaultVis: 0, maxVis: 0 },
  _self: { defaultVis: 0, maxVis: 0 },
  _attachments: { defaultVis: 0, maxVis: 0 },
  _ts: { defaultVis: 0, maxVis: 0 },

  eaglePushedAt: { defaultVis: 2, maxVis: 2 },
  _etag: { defaultVis: 2, maxVis: 2 }
};
