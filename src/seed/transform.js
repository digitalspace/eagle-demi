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
 * Upstream `read[]` is preserved VERBATIM when present — Eagle and NRPTI both carry role types
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
    milestone: resolveListLabel(doc.milestone, listLookup),
    projectPhase: resolveListLabel(doc.projectPhase, listLookup),

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
 * An NRPTI record -> the DEMI `records` model.
 *
 * Returns null when `_epicProjectId` does not resolve. That is the entire replacement for the
 * fuzzy name-matching apparatus: no `normalizeProjectName`, no hardcoded "conuma coal" /
 * "chetwynd" cases, no `$regex` name match, and above all **no auto-created project**. The old
 * seeder invented one project per unmatched location string and produced 3,382 junk rows.
 */
function transformRecord(record, projectIndex, opts = {}) {
  if (!record || !record._id) {
    throw new TypeError('[seed] an NRPTI record with _id is required');
  }

  const projectId = projectIndex.resolve(record._epicProjectId);
  if (!projectId) return null;

  const read = seedAcl(record.read);

  return {
    id: String(record._id),
    projectId: String(projectId),
    sourceSystem: 'nrpti',
    nrptiId: String(record._id),

    dataset: record._schemaName || '',
    recordName: record.recordName || '',
    recordType: record.recordType || '',
    projectName: record.projectName || '',
    issuingAgency: record.issuingAgency || '',
    issuedTo: record.issuedTo || null,
    dateIssued: toIsoOrNull(record.dateIssued),
    sourceSystemRef: record.sourceSystemRef || '',

    read,
    isPublished: read.includes('public'),
    updatedAt: opts.now || new Date().toISOString()
  };
}

/**
 * Bounded compliance aggregate for a project's records.
 *
 * The old code embedded full record objects into each project **twice**
 * (`sync-nrpti.js:356,364`), each carrying its raw upstream payload — a ~250-record ceiling
 * against the 2 MB item limit that the Mongo API's 16 MB limit had been masking. Only these
 * counters go on the project side; the records themselves live in their own container.
 */
function emptySummary() {
  return {
    recordCount: 0,
    orderCount: 0,
    inspectionCount: 0,
    ticketCount: 0,
    lastRecordDate: null
  };
}

/**
 * Fold one record into a summary, in place.
 *
 * Incremental so the seeder can stream: records are written per project in batches and never all
 * held in memory, but the aggregate still needs every record. Five counters per project is
 * nothing; 100,000 record objects is not.
 */
function accumulateRecord(summary, record) {
  summary.recordCount++;
  const dataset = (record.dataset || '').toLowerCase();
  if (dataset === 'order') summary.orderCount++;
  else if (dataset === 'inspection') summary.inspectionCount++;
  else if (dataset === 'ticket') summary.ticketCount++;

  if (record.dateIssued &&
      (!summary.lastRecordDate || record.dateIssued > summary.lastRecordDate)) {
    summary.lastRecordDate = record.dateIssued;
  }
  return summary;
}

function summarizeRecords(records) {
  const summary = emptySummary();
  for (const r of records || []) accumulateRecord(summary, r);
  return summary;
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

  return {
    id: String(item._id),
    type: item.type,
    name: item.name || '',
    code: item.code ? String(item.code) : '',
    simplifiedGeometry: geometry,
    updatedAt: opts.now || new Date().toISOString()
  };
}

module.exports = {
  SECURE_ROLES,
  seedAcl,
  toNumber,
  toIsoOrNull,
  resolveListLabel,
  transformDocument,
  transformRecord,
  emptySummary,
  accumulateRecord,
  summarizeRecords,
  transformBoundary
};
