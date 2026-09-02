'use strict';

/**
 * Field visibility policy for a stored document. Same contract as catalog/projects.js: `defaultVis`
 * is the baseline level a field is visible at, `maxVis` the ceiling a per-record dial may raise it
 * to, and a field absent from this table is removed from every response.
 *
 * Authored from `transformDocument` (src/seed/transform.js), the four keys `createDocument` adds and
 * the two `patchExtraction` adds. Day-one defaults reproduce the output of the `publicView` this
 * replaced (docs/rbac-architecture.md §2 item 3), so everything it let through is 4/4.
 */
module.exports = {
  // Structural / identity.
  id: { defaultVis: 4, maxVis: 4 },
  projectId: { defaultVis: 4, maxVis: 4 },
  eagleId: { defaultVis: 4, maxVis: 4 },
  sourceSystem: { defaultVis: 4, maxVis: 4 },
  isPublished: { defaultVis: 4, maxVis: 4 },
  isDeleted: { defaultVis: 4, maxVis: 4 },
  createdAt: { defaultVis: 4, maxVis: 4 },
  updatedAt: { defaultVis: 4, maxVis: 4 },
  // Only a sealed record carries one, and only a `compliance` caller (level 2) reads a sealed
  // record — so a released row keeps the timestamp without publishing it.
  sealedAt: { defaultVis: 2, maxVis: 2 },

  // Descriptive metadata, all of it rendered by eagle-public's document list today.
  displayName: { defaultVis: 4, maxVis: 4 },
  documentFileName: { defaultVis: 4, maxVis: 4 },
  description: { defaultVis: 4, maxVis: 4 },
  fileExt: { defaultVis: 4, maxVis: 4 },
  fileSize: { defaultVis: 4, maxVis: 4 },
  mimeType: { defaultVis: 4, maxVis: 4 },
  type: { defaultVis: 4, maxVis: 4 },
  typeId: { defaultVis: 4, maxVis: 4 },
  milestone: { defaultVis: 4, maxVis: 4 },
  milestoneId: { defaultVis: 4, maxVis: 4 },
  projectPhase: { defaultVis: 4, maxVis: 4 },
  projectPhaseId: { defaultVis: 4, maxVis: 4 },
  documentAuthorType: { defaultVis: 4, maxVis: 4 },
  documentAuthorTypeId: { defaultVis: 4, maxVis: 4 },
  datePosted: { defaultVis: 4, maxVis: 4 },
  dateUploaded: { defaultVis: 4, maxVis: 4 },
  documentAuthor: { defaultVis: 4, maxVis: 4 },
  documentSource: { defaultVis: 4, maxVis: 4 },
  isFeatured: { defaultVis: 4, maxVis: 4 },
  region: { defaultVis: 4, maxVis: 4 },
  eaoStatus: { defaultVis: 4, maxVis: 4 },
  legislation: { defaultVis: 4, maxVis: 4 },

  // Records-management identifiers; public by policy (answered by Daniel for the EAO, 2026-08-28; docs/rbac-architecture.md §3 question 2).
  orcsClassification: { defaultVis: 4, maxVis: 4 },
  edrmsRecordNumber: { defaultVis: 4, maxVis: 4 },

  // Extraction state, written by patchExtraction. `extraction` is the sanitised provenance object.
  contentExtracted: { defaultVis: 4, maxVis: 4 },
  contentExtractedAt: { defaultVis: 4, maxVis: 4 },
  contentPageCount: { defaultVis: 4, maxVis: 4 },
  contentExtractionError: { defaultVis: 4, maxVis: 4 },
  extractionMethod: { defaultVis: 4, maxVis: 4 },
  extraction: { defaultVis: 4, maxVis: 4 },

  // Never public. `s3Key` is the object-store key — the bytes are reached through
  // GET /documents/:id/download, which reads it off the raw repository row. `ownRead` is the
  // pre-cascade ACL, so it is the same role vocabulary as `read`.
  s3Key: { defaultVis: 0, maxVis: 0 },
  read: { defaultVis: 0, maxVis: 0 },
  ownRead: { defaultVis: 0, maxVis: 0 },
  vis: { defaultVis: 0, maxVis: 0 },

  // Cosmos system fields.
  _rid: { defaultVis: 0, maxVis: 0 },
  _self: { defaultVis: 0, maxVis: 0 },
  _attachments: { defaultVis: 0, maxVis: 0 },
  _ts: { defaultVis: 0, maxVis: 0 },

  // Writers need it back for optimistic concurrency; every WRITE_ROLES holder is level 2 or lower.
  _etag: { defaultVis: 2, maxVis: 2 }
};
