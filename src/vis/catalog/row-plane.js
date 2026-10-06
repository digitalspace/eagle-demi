'use strict';

/**
 * The entries every Eagle mirror row carries beside its own fields: identity, the derived publish
 * flag, and the never-public ACL, raw payload, dial map and Cosmos system fields. Same levels and
 * reasons as catalog/projects.js. Not an entity: catalog/index.js never lists it.
 */
module.exports = Object.freeze({
  id: { defaultVis: 4, maxVis: 4 },
  eagleId: { defaultVis: 4, maxVis: 4 },
  sourceSystem: { defaultVis: 4, maxVis: 4 },
  isPublished: { defaultVis: 4, maxVis: 4 },
  // Eagle no longer holds the record. A fact about the row; `read` is what hides it.
  isDeleted: { defaultVis: 4, maxVis: 4 },

  read: { defaultVis: 0, maxVis: 0 },
  sources: { defaultVis: 0, maxVis: 0 },
  vis: { defaultVis: 0, maxVis: 0 },

  _rid: { defaultVis: 0, maxVis: 0 },
  _self: { defaultVis: 0, maxVis: 0 },
  _attachments: { defaultVis: 0, maxVis: 0 },
  _ts: { defaultVis: 0, maxVis: 0 },

  eaglePushedAt: { defaultVis: 2, maxVis: 2 },
  _etag: { defaultVis: 2, maxVis: 2 }
});
