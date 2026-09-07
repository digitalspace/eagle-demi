'use strict';

/**
 * Field visibility policy for a mirrored project notification. See catalog/projects.js for the
 * rules.
 *
 * A notification is a public record of a project the EAO was told about; everything the model
 * carries beyond the ACL is already on the public notifications page, so it is 4/4.
 */
module.exports = {
  // Structural / identity.
  id: { defaultVis: 4, maxVis: 4 },
  eagleId: { defaultVis: 4, maxVis: 4 },
  sourceSystem: { defaultVis: 4, maxVis: 4 },
  isPublished: { defaultVis: 4, maxVis: 4 },

  // The notification itself.
  name: { defaultVis: 4, maxVis: 4 },
  type: { defaultVis: 4, maxVis: 4 },
  subType: { defaultVis: 4, maxVis: 4 },
  proponent: { defaultVis: 4, maxVis: 4 },
  nature: { defaultVis: 4, maxVis: 4 },
  region: { defaultVis: 4, maxVis: 4 },
  location: { defaultVis: 4, maxVis: 4 },
  decision: { defaultVis: 4, maxVis: 4 },
  decisionDate: { defaultVis: 4, maxVis: 4 },
  notificationReceivedDate: { defaultVis: 4, maxVis: 4 },
  trigger: { defaultVis: 4, maxVis: 4 },
  description: { defaultVis: 4, maxVis: 4 },
  centroid: { defaultVis: 4, maxVis: 4 },
  notificationThresholdValue: { defaultVis: 4, maxVis: 4 },
  notificationThresholdUnits: { defaultVis: 4, maxVis: 4 },
  associatedProjectId: { defaultVis: 4, maxVis: 4 },
  associatedProjectName: { defaultVis: 4, maxVis: 4 },

  // The Engage-managed comment period a notification can carry, same three fields as a period.
  pcp: { defaultVis: 4, maxVis: 4 },
  isMet: { defaultVis: 4, maxVis: 4 },
  metURL: { defaultVis: 4, maxVis: 4 },
  dateStarted: { defaultVis: 4, maxVis: 4 },
  dateCompleted: { defaultVis: 4, maxVis: 4 },

  // Never public. Same entries, same reasons, as catalog/projects.js. `read` is the ACL array, not
  // a read flag — the plan's field list names it beside the content fields and it is neither.
  read: { defaultVis: 0, maxVis: 0 },
  sources: { defaultVis: 0, maxVis: 0 },
  vis: { defaultVis: 0, maxVis: 0 },

  _rid: { defaultVis: 0, maxVis: 0 },
  _self: { defaultVis: 0, maxVis: 0 },
  _attachments: { defaultVis: 0, maxVis: 0 },
  _ts: { defaultVis: 0, maxVis: 0 },

  _etag: { defaultVis: 2, maxVis: 2 }
};
