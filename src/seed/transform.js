'use strict';

/**
 * Pure upstream-to-DEMI transforms, no I/O. Never carry an upstream claim DEMI cannot honour:
 * derive `isPublished`, reset `contentExtracted`, drop a record with no resolvable project.
 */

const { readForLevel } = require('../helpers/access-sql');
const { naturalSortKey } = require('../helpers/natural-sort');
const { eagleBaseAcl, eagleReadUnder } = require('../helpers/eagle-acl');

/** `internalSize` arrives as a number OR a numeric string (261 of 2,961 sampled were strings). */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toIsoOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** An unresolvable List ref keeps its raw value, not null, so the reference is not lost. */
function resolveListLabel(ref, listLookup) {
  if (!ref) return null;
  const key = String(ref);
  return (listLookup && listLookup.get(key)) || key;
}

/**
 * Kept beside the label: eagle-public's filter panel sends List ObjectIds, and a label-only row
 * silently matches zero rows.
 */
function listRefId(ref) {
  return ref ? String(ref) : null;
}

const { EXTRACTION_FIELDS, DEMI_OWNED_FIELDS, holdLevel } = require('../repositories/documents');

function carriedDemiState(existing) {
  if (!existing) return {};
  return Object.fromEntries(
    DEMI_OWNED_FIELDS.filter(f => existing[f] !== undefined).map(f => [f, existing[f]])
  );
}

/**
 * An upsert replaces the row, so a raised re-stamp flag is carried or a push would clear it. The
 * token is kept verbatim: an in-flight re-stamp's clear is guarded on it.
 */
function carriedPending(existing) {
  if (!existing || existing.parentFieldsPending !== true) return {};
  return {
    parentFieldsPending: true,
    parentFieldsPendingAt: existing.parentFieldsPendingAt || null
  };
}

/**
 * An Eagle document -> the DEMI `documents` model.
 *
 * @param {object}   doc              a record from eagle-api's Document search
 * @param {string}   projectId        canonical DEMI project id (the partition key)
 * @param {Map}      listLookup       List `_id` -> name
 * @param {object}   [opts]
 * @param {string}   [opts.now]       ISO timestamp, injected for deterministic tests
 * @param {object}   [opts.existing]  the stored row; its DEMI-owned state is carried over
 * @param {string[]} [opts.projectRead] the parent project's ACL, which this one is narrowed against
 */
function transformDocument(doc, projectId, listLookup, opts = {}) {
  if (!doc || !doc._id) {
    throw new TypeError('[seed] an Eagle document with _id is required');
  }
  if (!projectId) {
    throw new TypeError('[seed] a resolved projectId is required — never seed an orphan document');
  }

  // A document may never out-rank its project. Notification-parented rows have no project ACL to
  // narrow against and stay verbatim.
  const read = opts.projectRead ? eagleReadUnder(doc.read, opts.projectRead) : eagleBaseAcl(doc.read);

  const displayName = doc.displayName || doc.documentFileName || '';

  // A row DEMI narrowed or took down keeps the lower level, on a push and on a re-seed alike.
  return holdLevel({
    // The Eagle _id is the stable natural key. Reusing it means a re-seed is idempotent and
    // epic.submit can later merge onto the same identity rather than creating a duplicate.
    id: String(doc._id),
    projectId: String(projectId),
    eagleId: String(doc._id),
    sourceSystem: 'eagle',

    displayName,
    // The index sorts strings by codepoint, so the padded key is what puts "Item 2" before
    // "Item 10". Derived here rather than in the data source: Cosmos SQL cannot zero-pad.
    displayNameSort: naturalSortKey(displayName),
    documentFileName: doc.documentFileName || '',
    description: doc.description || '',

    // `internalURL` is the object key — `s3Key` is null on every Eagle document (0 of 2,961
    // sampled had one). Reading s3Key here would seed 60,661 documents with no file.
    s3Key: doc.internalURL || '',
    fileExt: (doc.internalExt || '').replace(/^\./, '').toLowerCase(),
    fileSize: toNumber(doc.internalSize),
    mimeType: doc.internalMime || '',
    uploadSha256: typeof doc.internalOriginalSha256 === 'string' ? doc.internalOriginalSha256 : null,

    type: resolveListLabel(doc.type, listLookup),
    typeId: listRefId(doc.type),
    milestone: resolveListLabel(doc.milestone, listLookup),
    milestoneId: listRefId(doc.milestone),
    projectPhase: resolveListLabel(doc.projectPhase, listLookup),
    projectPhaseId: listRefId(doc.projectPhase),
    documentAuthorType: resolveListLabel(doc.documentAuthorType, listLookup),
    documentAuthorTypeId: listRefId(doc.documentAuthorType),

    datePosted: toIsoOrNull(doc.datePosted),
    // Staff's manual order for a project's documents (eagle-admin application sort). Eagle
    // defaults it to 0, so null means the record never carried one.
    sortOrder: toNumber(doc.sortOrder),
    dateUploaded: toIsoOrNull(doc.dateUploaded),
    documentAuthor: doc.documentAuthor || '',
    documentSource: doc.documentSource || '',
    isFeatured: doc.isFeatured === true,
    region: doc.region || '',
    eaoStatus: doc.eaoStatus || '',
    orcsClassification: doc.orcsClassification || '',
    edrmsRecordNumber: doc.edrmsRecordNumber || '',
    legislation: doc.legislation || null,

    read,
    // Eagle's read before the project cap, which `documents.setAclForProject` re-derives from.
    ownRead: eagleBaseAcl(doc.read),
    // Derived, not copied: upstream `isPublished` is false on a third of documents whose ACL is
    // public. read[] is authoritative (ADR-004).
    isPublished: read.includes('public'),

    // Eagle's `contentExtracted` lies, so these come from the stored DEMI row; resetting them would
    // orphan the chunks and re-queue the corpus.
    contentExtracted: false,
    contentExtractedAt: null,
    contentPageCount: 0,
    contentExtractionError: null,
    ...carriedDemiState(opts.existing),
    ...carriedPending(opts.existing),

    updatedAt: opts.now || new Date().toISOString()
  }, opts.existing);
}

/**
 * Simplified geometry only: full-resolution districts near the 2 MB item cap, and the frontend
 * ships its own full GeoJSON.
 */
function transformBoundary(item, opts = {}) {
  if (!item || !item._id) {
    throw new TypeError('[seed] a boundary with _id is required');
  }
  if (!item.type) {
    throw new TypeError(`[seed] boundary ${item._id} has no type — that is the partition key`);
  }

  const geometry = item.simplifiedGeometry || null;
  if (!geometry) {
    throw new TypeError(`[seed] boundary ${item._id} has no simplifiedGeometry`);
  }

  // Public by default, but an upstream `read[]` is kept so a restricted shapefile stays
  // restricted through a re-seed.
  const read = Array.isArray(item.read) && item.read.length > 0
    ? eagleBaseAcl(item.read)
    : readForLevel(4);

  return {
    id: String(item._id),
    type: item.type,
    name: item.name || '',
    code: item.code ? String(item.code) : '',
    simplifiedGeometry: geometry,
    read,
    // read[] is authoritative; isPublished mirrors it, never the other way round.
    isPublished: read.includes('public'),
    updatedAt: opts.now || new Date().toISOString()
  };
}

module.exports = {
  EXTRACTION_FIELDS,
  eagleBaseAcl,
  eagleReadUnder,
  toNumber,
  toIsoOrNull,
  resolveListLabel,
  listRefId,
  transformDocument,
  transformBoundary
};
