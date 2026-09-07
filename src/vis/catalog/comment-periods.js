'use strict';

/**
 * Field visibility policy for a mirrored comment period. See catalog/projects.js for the rules.
 *
 * Everything here is what eagle-public renders on the public engagement tab today, so it is 4/4.
 * The staff-only halves of the Eagle model — `metURLAdmin`, the vetting and classification roles
 * and percentages, `eaoNotes` — are not mirrored at all, so they need no entry.
 */
module.exports = {
  // Structural / identity.
  id: { defaultVis: 4, maxVis: 4 },
  eagleId: { defaultVis: 4, maxVis: 4 },
  projectId: { defaultVis: 4, maxVis: 4 },
  sourceSystem: { defaultVis: 4, maxVis: 4 },
  isPublished: { defaultVis: 4, maxVis: 4 },
  // Public like `isPublished`, and for the same reason: it is the state of the record, not a fact
  // about it. A deleted period is level 2 anyway, so only staff ever see this reading true.
  isDeleted: { defaultVis: 4, maxVis: 4 },

  // The period itself.
  dateStarted: { defaultVis: 4, maxVis: 4 },
  dateCompleted: { defaultVis: 4, maxVis: 4 },
  dateAdded: { defaultVis: 4, maxVis: 4 },
  // `isMet` says the period is run in Engage rather than here, and `metURL` is where it lives.
  isMet: { defaultVis: 4, maxVis: 4 },
  metURL: { defaultVis: 4, maxVis: 4 },
  informationLabel: { defaultVis: 4, maxVis: 4 },
  instructions: { defaultVis: 4, maxVis: 4 },
  openHouses: { defaultVis: 4, maxVis: 4 },
  relatedDocuments: { defaultVis: 4, maxVis: 4 },
  commentTip: { defaultVis: 4, maxVis: 4 },

  // Never public. Same entries, same reasons, as catalog/projects.js.
  read: { defaultVis: 0, maxVis: 0 },
  sources: { defaultVis: 0, maxVis: 0 },
  vis: { defaultVis: 0, maxVis: 0 },

  _rid: { defaultVis: 0, maxVis: 0 },
  _self: { defaultVis: 0, maxVis: 0 },
  _attachments: { defaultVis: 0, maxVis: 0 },
  _ts: { defaultVis: 0, maxVis: 0 },

  _etag: { defaultVis: 2, maxVis: 2 }
};
