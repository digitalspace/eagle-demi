'use strict';

const { redactForAccess, redactAllForAccess } = require('../../vis/redact');
const { levelOf } = require('../../vis/level');
const { EAGLE_STAFF_FIELDS } = require('../../merge/project');
const { dialsForIndex } = require('../../vis/catalog/index-projects-renames');
const eagleQuery = require('../../search/eagle-query');
const { andOData } = require('../../search/native-index');
const { dialExclusion } = require('../../search/project-dials');
const { normalizeSubType } = require('../../search/sub-type');
const projectsRepo = require('../../repositories/projects');

/**
 * A stored GeoJSON point as the frontend wants it: `[lng, lat]`. Cosmos, the index and the frontend
 * all use that order, so nothing is swapped here.
 */
function geoPoint(centroid) {
  const coords = Array.isArray(centroid) ? centroid : centroid && centroid.coordinates;
  if (!Array.isArray(coords) || coords.length !== 2) return [-125.0, 54.0];
  const [lng, lat] = coords.map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return [-125.0, 54.0];
  return [lng, lat];
}

/**
 * Label rows under the CALLER's access, never systemAccess(): a label must not outlive the row's ACL.
 * An unreadable project still gets a stub label, since eagle-public's row template throws without one.
 */
async function labelWithProjectNames(access, docs) {
  const projectIds = docs.map(d => d.project).filter(Boolean);
  if (projectIds.length === 0) return;
  // Redacted before anything reads a field off it, like every other repository row on this route
  // (docs/rbac-architecture.md §2 item 9).
  const parents = redactAllForAccess('projects', await projectsRepo.listByIds(access, projectIds), access);
  const byId = new Map(parents.map(p => [String(p.id), p]));
  for (const doc of docs) {
    const parent = byId.get(String(doc.project));
    doc.projectName = (parent && parent.name) || 'Associated Project';
    // The DEMI project id, kept separately: `project._id` below is the EAGLE ObjectId and neither
    // is derived from the other. See wiki Search-Query-Construction#project-id-spaces.
    doc.projectId = String(doc.project);
    doc.project = eagleQuery.ref((parent && parent.eagleId) || doc.project, doc.projectName);
  }
}

const STAFF_LEVEL = 2;

/** eagle-api's staff project fields, copied off a REDACTED row only: level 3-4 never gets one. */
function staffProjectFields(redacted) {
  const out = {};
  for (const key of EAGLE_STAFF_FIELDS) {
    if (redacted && redacted[key] !== undefined) out[key] = redacted[key];
  }
  return out;
}

/**
 * The staff fields for an INDEX page, which does not carry them: the same ids read back from
 * Cosmos under the caller's access and redacted. No read at all below level 2.
 */
async function staffFieldsByProjectId(access, ids) {
  if (levelOf(access) > STAFF_LEVEL || ids.length === 0) return new Map();
  const rows = redactAllForAccess('projects', await projectsRepo.listRowsByIds(access, ids), access);
  return new Map(rows.map(row => [String(row.id), staffProjectFields(row)]));
}

/** `filter` less the projects whose own dial hides from this caller a column the read sorts, filters or searches on. */
async function withoutDialHidden(access, filter, fields, keywords, searchedColumns) {
  const hidden = await dialExclusion(access, fields, keywords ? searchedColumns : undefined);
  return hidden ? andOData(filter, hidden) : filter;
}

/**
 * One `projects` INDEX hit, redacted for this caller. The dials arrive as a JSON string; a malformed
 * one fails closed to no dials, every field at its `defaultVis`.
 */
function redactIndexProject(hit, access) {
  let dials;
  try {
    dials = JSON.parse(hit.vis || '{}');
  } catch {
    dials = {};
  }
  return redactForAccess('index-projects', { ...hit, vis: dialsForIndex(dials) }, access);
}

/** The stored `activeWork` object, rebuilt from the four flat columns the index keeps it in. */
function indexActiveWork(doc) {
  const columns = [doc.activeWorkId, doc.activeWorkAct, doc.activeWorkType, doc.activeWorkPhase];
  // Not keyed on the id alone: the index nulls a non-numeric id that Cosmos still holds.
  if (columns.every(value => value == null)) return null;
  return {
    trackWorkId: doc.activeWorkId ?? null,
    eaAct: doc.activeWorkAct ?? null,
    workType: doc.activeWorkType ?? null,
    currentPhase: doc.activeWorkPhase ?? null
  };
}

/**
 * The wire `sector`, falling back to Track's sub-type when the STORED row has none. Asked of the
 * stored row, not the redacted one, or a sector a dial withholds would come back as the sub-type.
 */
function wireSector(stored, shown, legislationYear) {
  const text = v => (typeof v === 'string' ? v.trim() : '');
  if (text(stored.sector)) return text(shown.sector) || 'Other';
  return normalizeSubType(shown.projectSubType, legislationYear) || 'Other';
}

module.exports = {
  geoPoint,
  labelWithProjectNames,
  staffProjectFields,
  staffFieldsByProjectId,
  withoutDialHidden,
  redactIndexProject,
  indexActiveWork,
  wireSector
};
