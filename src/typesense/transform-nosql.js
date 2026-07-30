'use strict';

/**
 * DEMI NoSQL model -> Typesense documents.
 *
 * Replaces transform.js (Mongo-era) during the migration; both exist until the cutover. The old
 * one cannot be adapted, because it reads fields the NoSQL model does not have:
 *
 *   _id                     -> id
 *   doc.project             -> doc.projectId (already the canonical Track id)
 *   legislation_2018 blocks -> flat merged fields (merge/project.js resolves precedence at seed)
 *   type/milestone as ObjectId refs into `List` -> already resolved to LABELS at seed time
 *   sources.nrpti.recordCount -> project_fragments, with its own restricted ACL
 *
 * That last one is why **the `List` and PCP lookups are gone rather than ported**. DEMI has no
 * `List` collection at all, so `buildListLookup` would return an empty Map and
 * `MIN_LOOKUP_SIZE` would hard-abort the first production sync. `buildPcpLookup` existed only for
 * `transformRecentActivity`, which was unreachable: it is in TRANSFORMS but not in SCHEMAS, and
 * the sync iterates SCHEMAS.
 *
 * The output schemas in collections.js are unchanged — that is the contract the frontend
 * searches against — with one exception noted on `transformProject`.
 *
 * Access control is NOT enforced here. Typesense enforces it at query time via scoped search
 * keys embedding `filter_by: allowed_roles:=[...]`, which clients cannot bypass. This module's
 * only security duty is to copy `read[]` into `allowed_roles` faithfully.
 */

const PUBLIC_FALLBACK = ['public'];

function toTimestamp(value) {
  if (!value) return undefined;
  const t = new Date(value).getTime();
  return isNaN(t) ? undefined : t;
}

function str(value) {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  return s === '' ? undefined : s;
}

/**
 * GeoJSON `[lng, lat]` -> Typesense geopoint `[lat, lng]`.
 *
 * The swap is the classic bug in this codebase's data path: MongoDB and the merge engine store
 * lng-first, Typesense's geopoint type is lat-first. Getting it backwards puts every project in
 * the wrong hemisphere, and it fails silently because both are valid-looking numbers.
 */
function toGeopoint(centroid) {
  const coords = Array.isArray(centroid) ? centroid : centroid && centroid.coordinates;
  if (!Array.isArray(coords) || coords.length !== 2) return undefined;

  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return undefined;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined;

  return [lat, lng];
}

/**
 * The item's ACL, for Typesense to filter on.
 *
 * Falls back to `['public']` ONLY when the item is explicitly published, and to a deny-all empty
 * array otherwise. An item with no ACL and no publication flag must not become searchable by
 * everyone — that is the failure mode the whole read[] model exists to prevent. Every seeded item
 * carries an explicit read[] (a seed gate asserts it), so the fallback should never fire.
 */
function allowedRoles(item) {
  if (Array.isArray(item.read) && item.read.length > 0) return item.read;
  return item.isPublished === true ? [...PUBLIC_FALLBACK] : [];
}

/**
 * A child may never be more visible than its parent project.
 *
 * Enforced at write time in the API (`resolveDocumentAcl`), and again here, because the index is
 * a second copy of the data and a stale or hand-edited child would otherwise be searchable
 * beyond its project. Intersection, not union.
 */
function constrainToProject(childRoles, projectMeta) {
  if (!projectMeta || !Array.isArray(projectMeta.read) || projectMeta.read.length === 0) {
    return childRoles;
  }
  const parent = new Set(projectMeta.read);
  return childRoles.filter(r => parent.has(r));
}

function transformDocument(doc, projectLookup) {
  const projectId = str(doc.projectId);
  const projectMeta = projectId && projectLookup ? projectLookup.get(projectId) : undefined;

  // legislation is an int32 facet in the schema; the merged model may carry a year or a label.
  const legislation = Number(doc.legislation);

  return {
    id: String(doc.id),
    ...(str(doc.displayName) && { displayName: str(doc.displayName) }),
    ...(str(doc.documentFileName) && { documentFileName: str(doc.documentFileName) }),
    ...(str(doc.description) && { description: str(doc.description) }),
    ...(projectMeta && str(projectMeta.name) && { projectName: str(projectMeta.name) }),
    ...(projectId && { projectId }),
    // Already labels — resolved against `List` at seed time, so no lookup here.
    ...(str(doc.type) && { type: str(doc.type) }),
    ...(str(doc.milestone) && { milestone: str(doc.milestone) }),
    ...(str(doc.documentAuthorType) && { documentAuthorType: str(doc.documentAuthorType) }),
    ...(str(doc.projectPhase) && { projectPhase: str(doc.projectPhase) }),
    ...(Number.isInteger(legislation) && legislation > 0 && { legislation }),
    ...(str(doc.region || (projectMeta && projectMeta.region)) &&
      { region: str(doc.region || projectMeta.region) }),
    ...(projectMeta && projectMeta.centroid && { centroid: projectMeta.centroid }),
    ...(str(doc.fileExt) && { internalExt: str(doc.fileExt) }),
    ...(toTimestamp(doc.datePosted) !== undefined && { datePosted: toTimestamp(doc.datePosted) }),
    ...(toTimestamp(doc.dateUploaded) !== undefined &&
      { dateUploaded: toTimestamp(doc.dateUploaded) }),
    isFeatured: doc.isFeatured === true,
    ...(str(doc.documentSource) && { documentSource: str(doc.documentSource) }),
    popularity: 0,
    allowed_roles: constrainToProject(allowedRoles(doc), projectMeta)
  };
}

/**
 * A merged project.
 *
 * `nrptiRecordCount` is deliberately NOT emitted, though the schema still declares it optional.
 * The compliance aggregate now lives in `project_fragments` behind its own ACL
 * (`sysadmin`/`staff`/`demi-admin`/`compliance`); copying the count onto the project document —
 * which is public — would leak restricted data through the search index no matter what the
 * fragment's ACL said. It has no consumers in the frontend, so nothing regresses.
 */
function transformProject(project) {
  return {
    id: String(project.id),
    ...(str(project.name) && { name: str(project.name) }),
    ...(str(project.abbreviation || project.name) &&
      { displayName: str(project.abbreviation || project.name) }),
    ...(str(project.description) && { description: str(project.description) }),
    // The Eagle id stays searchable so a legacy EPIC link or bookmark still resolves.
    ...(str(project.eagleId) && { epicProjectId: str(project.eagleId) }),
    ...(str(project.region) && { region: str(project.region) }),
    ...(str(project.projectState) && { status: str(project.projectState) }),
    ...(str(project.currentPhaseName) && { currentPhaseName: str(project.currentPhaseName) }),
    ...(str(project.eacDecision) && { eacDecision: str(project.eacDecision) }),
    ...(str(project.projectType) && { type: str(project.projectType) }),
    sector: str(project.sector || project.projectType) || 'Other',
    ...(str(project.address) && { location: str(project.address) }),
    ...(str(project.proponentName) && { proponent: str(project.proponentName) }),
    ...(toTimestamp(project.updatedAt) !== undefined &&
      { updatedDate: toTimestamp(project.updatedAt) }),
    ...(toTimestamp(project.decisionDate) !== undefined &&
      { decisionDate: toTimestamp(project.decisionDate) }),
    ...(toGeopoint(project.centroid) && { centroid: toGeopoint(project.centroid) }),
    ...(str(project.regionalDistrict) && { regionalDistrict: str(project.regionalDistrict) }),
    ...(str(project.electoralDistrict) && { electoralDistrict: str(project.electoralDistrict) }),
    ...(str(project.municipality) && { municipality: str(project.municipality) }),
    popularity: 0,
    allowed_roles: allowedRoles(project)
  };
}

function transformRecord(record, projectLookup) {
  const projectId = str(record.projectId);
  const projectMeta = projectId && projectLookup ? projectLookup.get(projectId) : undefined;

  const issuedTo = record.issuedTo;
  const issuedToName = issuedTo && typeof issuedTo === 'object'
    ? str(issuedTo.fullName || issuedTo.companyName ||
        [issuedTo.firstName, issuedTo.lastName].filter(Boolean).join(' '))
    : str(issuedTo);

  return {
    id: String(record.id),
    recordName: str(record.recordName) || '(unnamed record)',
    ...(str(record.recordType) && { recordType: str(record.recordType) }),
    ...(str(record.dataset) && { nrptiSchemaName: str(record.dataset) }),
    ...(str(record.issuingAgency) && { issuingAgency: str(record.issuingAgency) }),
    // Prefer the canonical project name over NRPTI's own string: the whole point of resolving
    // through _epicProjectId is that the registry, not NRPTI, names the project.
    ...(str((projectMeta && projectMeta.name) || record.projectName) &&
      { projectName: str((projectMeta && projectMeta.name) || record.projectName) }),
    ...(issuedToName && { issuedToName }),
    ...(str(record.summary) && { summary: str(record.summary) }),
    ...(toTimestamp(record.dateIssued) !== undefined &&
      { dateIssued: toTimestamp(record.dateIssued) }),
    ...(projectId && { projectId }),
    allowed_roles: constrainToProject(allowedRoles(record), projectMeta)
  };
}

/**
 * A chunk of extracted document text — the unit Deep Search matches on.
 *
 * Chunks arrive via POST /documents/:id/chunks and are queried as `dataset=DocumentChunk`.
 * Expect roughly 50 per document, so this runs a few million times per full sync: keep it
 * allocation-light and never let it reach back into Cosmos.
 */
function transformDocumentChunk(chunk, projectLookup, documentLookup) {
  const projectId = str(chunk.projectId);
  const documentId = str(chunk.documentId);
  const projectMeta = projectId && projectLookup ? projectLookup.get(projectId) : undefined;
  const parent = documentId && documentLookup ? documentLookup.get(documentId) : undefined;

  const content = str(chunk.content);
  // A chunk with no content is not searchable and only costs index space.
  if (!content) return null;

  // The chunk inherits its parent document's visibility, then the project's. A chunk is a
  // fragment of the document, so it must never be findable when the document is not.
  const inherited = parent && Array.isArray(parent.read) && parent.read.length > 0
    ? parent.read
    : allowedRoles(chunk);

  return {
    id: String(chunk.id),
    content,
    documentId: documentId || '',
    projectId: projectId || '',
    pageNumber: Number.isFinite(Number(chunk.pageNumber)) ? Number(chunk.pageNumber) : 0,
    ...(str(parent && parent.type) && { documentType: str(parent.type) }),
    ...(str(parent && parent.milestone) && { milestone: str(parent.milestone) }),
    ...(toTimestamp(parent && parent.datePosted) !== undefined &&
      { datePosted: toTimestamp(parent.datePosted) }),
    ...(str((parent && parent.region) || (projectMeta && projectMeta.region)) &&
      { region: str((parent && parent.region) || projectMeta.region) }),
    ...(Number.isFinite(Number(chunk.chunkIndex)) && { chunkIndex: Number(chunk.chunkIndex) }),
    ...(str(parent && (parent.displayName || parent.documentFileName)) &&
      { documentName: str(parent.displayName || parent.documentFileName) }),
    ...(projectMeta && str(projectMeta.name) && { projectName: str(projectMeta.name) }),
    // No centroid: nothing geo-searches chunks, and a stored-but-unused pair of floats is
    // multiplied by three million rows.
    allowed_roles: constrainToProject(inherited, projectMeta)
  };
}

const TRANSFORMS = {
  Document: (item, lookups) => transformDocument(item, lookups.projects),
  Project: (item) => transformProject(item),
  Record: (item, lookups) => transformRecord(item, lookups.projects),
  DocumentChunk: (item, lookups) => transformDocumentChunk(item, lookups.projects, lookups.documents)
};

/**
 * Transform one item for a schema.
 *
 * A transform that throws yields null and a warning rather than aborting the sync — one
 * malformed item must not cost the entire reindex. The count guard in full-sync catches the case
 * where *many* items fail, which is the situation that actually matters.
 */
function transformItem(schemaName, item, lookups = {}) {
  const fn = TRANSFORMS[schemaName];
  if (!fn) return null;
  try {
    return fn(item, lookups);
  } catch (err) {
    console.warn(`Transform failed for ${schemaName} ${item && item.id}:`, err.message);
    return null;
  }
}

/**
 * Project metadata needed to denormalise onto children: name, region, centroid, and the ACL used
 * to constrain them.
 *
 * ~393 projects, so holding this is trivial — unlike a document lookup, which is 60,661.
 */
function buildProjectLookup(projects) {
  const map = new Map();
  for (const p of projects || []) {
    if (!p || !p.id) continue;
    map.set(String(p.id), {
      name: p.name || p.abbreviation || '',
      region: p.region || '',
      centroid: toGeopoint(p.centroid),
      read: Array.isArray(p.read) ? p.read : []
    });
  }
  return map;
}

module.exports = {
  toTimestamp,
  str,
  toGeopoint,
  allowedRoles,
  constrainToProject,
  transformDocument,
  transformProject,
  transformRecord,
  transformDocumentChunk,
  transformItem,
  buildProjectLookup,
  TRANSFORMS
};
