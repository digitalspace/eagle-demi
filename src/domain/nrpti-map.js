'use strict';

// Maps NRPTI public search rows onto DEMI `mines` and `regulatoryRecords` rows. Pure; the sync script
// fetches and writes. Links only by EPIC project id; names are never read.

const { PUBLIC_READ } = require('./_write');

const MINE_DATASET = 'MineBCMI';

const RECORD_KINDS = Object.freeze({
  Inspection: 'inspection',
  Order: 'order',
  AdministrativePenalty: 'administrativePenalty',
  Warning: 'warning',
  Certificate: 'certificate',
  Permit: 'permit',
  Agreement: 'agreement',
  ConstructionPlan: 'constructionPlan',
  ManagementPlan: 'managementPlan',
  SelfReport: 'selfReport'
});

const RECORD_DATASETS = Object.freeze(Object.keys(RECORD_KINDS));
const DATASETS = Object.freeze([MINE_DATASET, ...RECORD_DATASETS]);

const REASONS = Object.freeze({ eagleOrigin: 'eagleOrigin', noEpicId: 'noEpicId', unknownEpicId: 'unknownEpicId' });

// NRPTI's placeholder for a name it will not publish.
const UNPUBLISHED = 'Unpublished';

const text = (value) => (typeof value === 'string' && value.trim() ? value : null);
const isPublic = (item) => !Array.isArray(item?.read) || item.read.includes('public');

function sourceOf(row, upstream) {
  return { system: 'nrpti', upstream, id: String(row._id), updatedAt: row.dateUpdated || null };
}

function pointOf(location) {
  const coordinates = location?.coordinates;
  const valid = Array.isArray(coordinates) && coordinates.length === 2 && coordinates.every(Number.isFinite);
  return valid ? { type: 'Point', coordinates: [...coordinates] } : null;
}

function issuedToOf(issuedTo) {
  if (!issuedTo || !isPublic(issuedTo)) return null;
  const name = text(issuedTo.companyName) || text(issuedTo.fullName);
  return name && name !== UNPUBLISHED ? name : null;
}

// The master row often has no description; a published flavour (LNG, NRCED, BCMI) carries it.
function summaryOf(row) {
  if (text(row.description)) return row.description;
  const flavour = (row.flavours || []).find(f => isPublic(f) && (text(f.summary) || text(f.description)));
  return flavour ? text(flavour.summary) || flavour.description : null;
}

function documentsOf(documents) {
  return (documents || [])
    .filter(doc => doc && typeof doc === 'object' && text(doc.url) && isPublic(doc))
    .map(doc => ({ fileName: text(doc.fileName), url: doc.url }));
}

/** `{ row }` for a record on a linked project, or `{ reason }` naming why it was dropped. */
function mapRecord(row, dataset, eagleIdToProjectId, syncedAt = new Date().toISOString()) {
  const kind = RECORD_KINDS[dataset];
  if (!kind) throw new Error(`mapRecord: unknown NRPTI dataset ${dataset}`);
  if (row.sourceSystemRef === 'epic') return { reason: REASONS.eagleOrigin };
  const eagleId = text(row._epicProjectId);
  if (!eagleId) return { reason: REASONS.noEpicId };
  const projectId = eagleIdToProjectId.get(eagleId);
  if (!projectId) return { reason: REASONS.unknownEpicId };
  return {
    row: {
      id: `nrpti-${row._id}`,
      projectId,
      eagleId,
      kind,
      title: text(row.recordName),
      subtype: text(row.recordSubtype),
      issuedAt: row.dateIssued || null,
      issuingAgency: text(row.issuingAgency),
      issuedTo: issuedToOf(row.issuedTo),
      summary: summaryOf(row),
      documents: documentsOf(row.documents),
      source: sourceOf(row, row.sourceSystemRef || null),
      read: [...PUBLIC_READ],
      syncedAt
    }
  };
}

function mineFields(row) {
  return {
    mineId: row._sourceRefId,
    mineNo: text(row.mineNo),
    name: text(row.name),
    // BCMI hides the permit number when the mine's owner asked it to.
    permitNumber: row.showPermitNumber === false ? null : text(row.permitNumber),
    permittee: text(row.permittee),
    status: text(row.status),
    type: text(row.type),
    commodities: [...new Set((row.commodities || []).filter(text))],
    region: text(row.region),
    tailingsImpoundments: Number.isFinite(row.tailingsImpoundments) ? row.tailingsImpoundments : null,
    location: pointOf(row.location),
    summary: text(row.summary),
    description: text(row.description),
    links: (row.links || []).filter(link => text(link?.url)).map(link => ({ url: link.url, title: text(link.title) })),
    source: sourceOf(row, 'core')
  };
}

/** `{ rows }`, one per linked project the mine names, or `{ reason }` when it links to none. */
function mapMine(row, eagleIdToProjectId, syncedAt = new Date().toISOString()) {
  if (row.sourceSystemRef === 'epic') return { reason: REASONS.eagleOrigin };
  const eagleIds = [...new Set((row._epicProjectIds || []).filter(text))];
  if (!eagleIds.length) return { reason: REASONS.noEpicId };
  const byProject = new Map();
  for (const eagleId of eagleIds) {
    const projectId = eagleIdToProjectId.get(eagleId);
    if (projectId && !byProject.has(projectId)) byProject.set(projectId, eagleId);
  }
  if (!byProject.size) return { reason: REASONS.unknownEpicId };
  const fields = mineFields(row);
  const rows = [...byProject].map(([projectId, eagleId]) => ({
    id: `${fields.mineId}:${projectId}`, projectId, eagleId, ...fields, read: [...PUBLIC_READ], syncedAt
  }));
  return { rows };
}

module.exports = { MINE_DATASET, RECORD_KINDS, RECORD_DATASETS, DATASETS, REASONS, mapRecord, mapMine };
