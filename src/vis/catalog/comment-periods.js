'use strict';

/**
 * Field visibility policy for a mirrored comment period. See catalog/projects.js for the rules.
 *
 * The public fields are what eagle-public renders on the engagement tab today, so they are 4/4.
 * The staff-side fields of the Eagle model are 2/2: staff read them in eagle-api, and nothing here
 * may publish them.
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
  metBannerImageUrl: { defaultVis: 4, maxVis: 4 },
  informationLabel: { defaultVis: 4, maxVis: 4 },
  instructions: { defaultVis: 4, maxVis: 4 },
  // Rendered on the public card and the comments page, exactly as `instructions` is.
  additionalText: { defaultVis: 4, maxVis: 4 },
  openHouses: { defaultVis: 4, maxVis: 4 },
  relatedDocuments: { defaultVis: 4, maxVis: 4 },
  commentTip: { defaultVis: 4, maxVis: 4 },

  // Staff-side fields (`staffFields` in the comment-period mirror).
  ceaaAdditionalText: { defaultVis: 2, maxVis: 2 },
  ceaaInformationLabel: { defaultVis: 2, maxVis: 2 },
  ceaaRelatedDocuments: { defaultVis: 2, maxVis: 2 },
  classificationRoles: { defaultVis: 2, maxVis: 2 },
  classifiedPercent: { defaultVis: 2, maxVis: 2 },
  commenterRoles: { defaultVis: 2, maxVis: 2 },
  commentIdCount: { defaultVis: 2, maxVis: 2 },
  dateCompletedEst: { defaultVis: 2, maxVis: 2 },
  dateStartedEst: { defaultVis: 2, maxVis: 2 },
  dateUpdated: { defaultVis: 2, maxVis: 2 },
  downloadRoles: { defaultVis: 2, maxVis: 2 },
  isClassified: { defaultVis: 2, maxVis: 2 },
  isResolved: { defaultVis: 2, maxVis: 2 },
  isVetted: { defaultVis: 2, maxVis: 2 },
  metURLAdmin: { defaultVis: 2, maxVis: 2 },
  milestone: { defaultVis: 2, maxVis: 2 },
  periodType: { defaultVis: 2, maxVis: 2 },
  phase: { defaultVis: 2, maxVis: 2 },
  phaseName: { defaultVis: 2, maxVis: 2 },
  publishedPercent: { defaultVis: 2, maxVis: 2 },
  rangeOption: { defaultVis: 2, maxVis: 2 },
  rangeType: { defaultVis: 2, maxVis: 2 },
  resolvedPercent: { defaultVis: 2, maxVis: 2 },
  userCan: { defaultVis: 2, maxVis: 2 },
  vettedPercent: { defaultVis: 2, maxVis: 2 },
  vettingRoles: { defaultVis: 2, maxVis: 2 },

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
