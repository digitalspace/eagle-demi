'use strict';

/**
 * Field visibility policy for a mirrored public comment. See catalog/projects.js for the rules.
 *
 * The one field here that is PII is `author`, and it is the whole reason this catalog exists: a
 * comment submitted anonymously carries a name in Mongo that the public site must never render.
 * The Eagle Comment model has no email field, so none is mirrored and none is catalogued.
 *
 * The staff-side halves of the model — `eaoNotes`, `proponentNotes`, `publishedNotes`,
 * `rejectedNotes`, `rejectedReason`, `location` — are not mirrored at all, so they need no entry.
 */
module.exports = {
  // Structural / identity.
  id: { defaultVis: 4, maxVis: 4 },
  eagleId: { defaultVis: 4, maxVis: 4 },
  periodId: { defaultVis: 4, maxVis: 4 },
  projectId: { defaultVis: 4, maxVis: 4 },
  sourceSystem: { defaultVis: 4, maxVis: 4 },
  isPublished: { defaultVis: 4, maxVis: 4 },

  // The comment itself.
  comment: { defaultVis: 4, maxVis: 4 },
  dateAdded: { defaultVis: 4, maxVis: 4 },
  isAnonymous: { defaultVis: 4, maxVis: 4 },
  documents: { defaultVis: 4, maxVis: 4 },
  commentId: { defaultVis: 4, maxVis: 4 },
  eaoStatus: { defaultVis: 4, maxVis: 4 },

  // The submitter's name, and public ONLY through the predicate: `isAnonymous` defaults to TRUE in
  // Eagle, so a row that never set it is unattributed and this stays withheld.
  author: { defaultVis: 2, maxVis: 4, when: 'commentAttributed' },

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
