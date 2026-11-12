'use strict';

/**
 * Field visibility for a mirrored public comment (rules in catalog/projects.js). `author` is the PII:
 * an anonymous comment still holds a name in Mongo the public must never see.
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
  dateUpdated: { defaultVis: 4, maxVis: 4 },
  // Free text the commenter typed. Public in eagle-api too — it is in the `ALLOWED_FIELDS` its
  // `publicGet` sanitises against and that read runs as `['public']`.
  location: { defaultVis: 4, maxVis: 4 },
  submittedCAC: { defaultVis: 4, maxVis: 4 },
  isAnonymous: { defaultVis: 4, maxVis: 4 },
  documents: { defaultVis: 4, maxVis: 4 },
  commentId: { defaultVis: 4, maxVis: 4 },
  eaoStatus: { defaultVis: 4, maxVis: 4 },

  // The submitter's name, and public ONLY through the predicate: `isAnonymous` defaults to TRUE in
  // Eagle, so a row that never set it is unattributed and this stays withheld.
  author: { defaultVis: 2, maxVis: 4, when: 'commentAttributed' },

  // Staff-side review fields (`staffFields` in the comment mirror).
  datePosted: { defaultVis: 2, maxVis: 2 },
  eaoNotes: { defaultVis: 2, maxVis: 2 },
  proponentNotes: { defaultVis: 2, maxVis: 2 },
  proponentStatus: { defaultVis: 2, maxVis: 2 },
  publishedNotes: { defaultVis: 2, maxVis: 2 },
  rejectedNotes: { defaultVis: 2, maxVis: 2 },
  rejectedReason: { defaultVis: 2, maxVis: 2 },
  valuedComponents: { defaultVis: 2, maxVis: 2 },
  // Stamped by a DEMI write (domain/comments.js); the mirror does not carry them.
  addedBy: { defaultVis: 2, maxVis: 2 },
  updatedBy: { defaultVis: 2, maxVis: 2 },

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
