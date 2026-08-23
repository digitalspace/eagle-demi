'use strict';

/**
 * Pure transforms from upstream shapes into the DEMI NoSQL model.
 *
 * No I/O, no clients — every function here takes plain objects and returns plain objects, so the
 * seed rules are unit-testable against real upstream payloads. Projects are handled separately
 * in src/merge/project.js because they are a MERGE of two sources; everything here has one
 * source each.
 *
 * The consistent rule across all of them: **never carry an upstream claim we cannot honour.**
 * A document's `isPublished` is derived rather than copied, `contentExtracted` is reset, and a
 * record with no resolvable project is dropped instead of given a fabricated parent.
 */

const SECURE_ROLES = ['sysadmin', 'staff', 'demi-admin'];

/**
 * ACL for a seeded item.
 *
 * Upstream `read[]` is preserved VERBATIM when present — Eagle carries role types
 * already (`project-team`, `admin:nrced`, `public`), and rewriting them would either widen an
 * upstream restriction or silently drop a role. Privileged DEMI callers do not need to appear in
 * the list: `readClause` short-circuits them to `true`.
 *
 * With no upstream ACL the item fails closed. Every seeded item gets an explicit `read[]`, which
 * is the condition for deleting the legacy no-ACL tier from the visibility predicate.
 */
function seedAcl(upstreamRead) {
  if (Array.isArray(upstreamRead) && upstreamRead.length > 0) {
    return upstreamRead.filter(r => typeof r === 'string' && r.trim() !== '');
  }
  return [...SECURE_ROLES];
}

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

/**
 * Resolve a List ObjectId reference to its label.
 *
 * Eagle stores `type` and `milestone` as ObjectId refs into a 213-item `List` collection. DEMI
 * has no List container, so labels are resolved at seed time. An unresolvable ref keeps its raw
 * value rather than becoming null — losing the reference entirely would make the field
 * unrecoverable, while keeping it leaves a trail.
 */
function resolveListLabel(ref, listLookup) {
  if (!ref) return null;
  const key = String(ref);
  return (listLookup && listLookup.get(key)) || key;
}

/**
 * The raw List ObjectId, kept ALONGSIDE the label rather than instead of it.
 *
 * eagle-public's document filter panel sends List ObjectIds, never labels
 * (`documents-tab.component.ts:47`), so a row holding only the label has nothing for those values
 * to compare against: the filter matches zero rows under a 200, which reads as "no results" and
 * not as a broken filter. Resolving to a label and discarding the id is what made every one of
 * those filters inexpressible.
 */
function listRefId(ref) {
  return ref ? String(ref) : null;
}

/**
 * An Eagle document -> the DEMI `documents` model.
 *
 * @param {object}   doc          a record from eagle-api's Document search
 * @param {string}   projectId    canonical DEMI project id (the partition key)
 * @param {Map}      listLookup   List `_id` -> name
 * @param {object}   [opts]
 * @param {string}   [opts.now]   ISO timestamp, injected for deterministic tests
 */
function transformDocument(doc, projectId, listLookup, opts = {}) {
  if (!doc || !doc._id) {
    throw new TypeError('[seed] an Eagle document with _id is required');
  }
  if (!projectId) {
    throw new TypeError('[seed] a resolved projectId is required — never seed an orphan document');
  }

  const read = seedAcl(doc.read);

  return {
    // The Eagle _id is the stable natural key. Reusing it means a re-seed is idempotent and
    // epic.submit can later merge onto the same identity rather than creating a duplicate.
    id: String(doc._id),
    projectId: String(projectId),
    eagleId: String(doc._id),
    sourceSystem: 'eagle',

    displayName: doc.displayName || doc.documentFileName || '',
    documentFileName: doc.documentFileName || '',
    description: doc.description || '',

    // `internalURL` is the object key — `s3Key` is null on every Eagle document (0 of 2,961
    // sampled had one). Reading s3Key here would seed 60,661 documents with no file.
    s3Key: doc.internalURL || '',
    fileExt: (doc.internalExt || '').replace(/^\./, '').toLowerCase(),
    fileSize: toNumber(doc.internalSize),
    mimeType: doc.internalMime || '',

    type: resolveListLabel(doc.type, listLookup),
    typeId: listRefId(doc.type),
    milestone: resolveListLabel(doc.milestone, listLookup),
    milestoneId: listRefId(doc.milestone),
    projectPhase: resolveListLabel(doc.projectPhase, listLookup),
    projectPhaseId: listRefId(doc.projectPhase),
    documentAuthorType: resolveListLabel(doc.documentAuthorType, listLookup),
    documentAuthorTypeId: listRefId(doc.documentAuthorType),

    datePosted: toIsoOrNull(doc.datePosted),
    dateUploaded: toIsoOrNull(doc.dateUploaded),
    documentAuthor: doc.documentAuthor || '',
    documentSource: doc.documentSource || '',
    region: doc.region || '',
    eaoStatus: doc.eaoStatus || '',
    orcsClassification: doc.orcsClassification || '',
    edrmsRecordNumber: doc.edrmsRecordNumber || '',
    legislation: doc.legislation || null,

    read,
    // DERIVED from read[], not copied. Upstream `isPublished` is true on only 66% of documents
    // that are unambiguously public by their ACL, so copying it would hide a third of the
    // corpus. read[] is authoritative and isPublished is its mirror (ADR-004).
    isPublished: read.includes('public'),

    // Reset, not carried. The old database has `contentExtracted: true` on records with no
    // chunks behind them, and DEMI has no chunk data at all yet — importing the flag would tell
    // the extractor there is nothing to do.
    contentExtracted: false,
    contentExtractedAt: null,
    contentPageCount: 0,
    contentExtractionError: null,

    updatedAt: opts.now || new Date().toISOString()
  };
}

/**
 * A static boundary export -> the DEMI `boundaries` model.
 *
 * **Simplified geometry only.** Full-resolution GeoJSON is already a build artifact under
 * frontend/public/assets/geojson/ that the frontend prefers anyway; keeping it here put the
 * largest districts near the 2 MB item cap and made every write expensive to index. Dropping it
 * takes the largest item to 57 KB.
 *
 * No `read[]`: this is public reference data and the boundaries repository deliberately applies
 * no ACL predicate. Adding an empty one would make the standard clause match nothing and blank
 * the map.
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

  // Reference geography is public by default — that is what every seeded row is. `seedAcl`
  // preserves an upstream `read[]` verbatim when the source supplies one, so a restricted
  // shapefile keeps its restriction through a re-seed instead of being republished.
  const read = Array.isArray(item.read) && item.read.length > 0
    ? seedAcl(item.read)
    : ['public', ...SECURE_ROLES];

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
  SECURE_ROLES,
  seedAcl,
  toNumber,
  toIsoOrNull,
  resolveListLabel,
  listRefId,
  transformDocument,
  transformBoundary
};
