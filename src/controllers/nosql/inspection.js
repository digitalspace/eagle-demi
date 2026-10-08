'use strict';

/**
 * Inspection controller — the Eagle mirror for `Inspection`, `InspectionElement` and
 * `InspectionItem`, and the only writer of `inspections`.
 *
 * Each row is capped by its parent through `eagleReadUnder`: an inspection by its project, an
 * element by its inspection, an item by its element. Eagle's default `['sysadmin','inspector']`
 * lands at level 2. Eagle links only downward (`elements[]`, `items[]`), so a child finds its
 * parent by the stored parent that lists it. eagle-api pushes a new child and its re-listed parent
 * at the same moment; a child that arrives first gets a 503, which eagle-api's push client retries.
 *
 * A child is gated by its own stored `read[]`, so a parent whose level moved re-derives the rows
 * under it, as a comment period does for its comments.
 */

const inspections = require('../../repositories/inspections');
const { eagleBaseAcl, eagleReadUnder } = require('../../seed/transform');
const { levelOfRead } = require('../../helpers/access-sql');
const { mirrorError } = require('../../helpers/duplicate-id');
const { auditEvent } = require('../../utils/audit');
const { logger } = require('../../utils/logger');
const { admitParent, refusalCode } = require('../../helpers/parent-admit');
const {
  eaglePush, upsertWithRetry, ignoreStalePush, pushConflict, underDeleteCeiling, refId
} = require('./eagle-mirror');
const { listHandler, getHandler } = require('./mirror-reads');

const { KINDS, ENTITY } = inspections;
const LABEL = 'Inspection Controller';

const ids = (list) => (Array.isArray(list) ? list.map(refId).filter(Boolean) : []);

/** Eagle's audit columns, shared by all three kinds. */
function auditFields(doc) {
  return {
    dateAdded: doc._createdDate || null,
    dateUpdated: doc._updatedDate || null,
    addedBy: doc._addedBy || '',
    updatedBy: doc._updatedBy || ''
  };
}

const FIELDS = {
  [KINDS.INSPECTION]: (doc) => ({
    inspectionId: doc.inspectionId || null,
    name: doc.name || '',
    label: doc.label || '',
    case: doc.case || '',
    email: doc.email || '',
    startDate: doc.startDate || null,
    endDate: doc.endDate || null,
    customProjectName: doc.customProjectName || '',
    elements: ids(doc.elements)
  }),
  [KINDS.ELEMENT]: (doc) => ({
    elementId: doc.elementId || null,
    title: doc.title || '',
    requirement: doc.requirement || '',
    description: doc.description || '',
    timestamp: doc.timestamp || null,
    items: ids(doc.items)
  }),
  [KINDS.ITEM]: (doc) => ({
    itemId: doc.itemId || null,
    type: doc.type || '',
    uri: doc.uri || '',
    geo: doc.geo && typeof doc.geo === 'object' ? doc.geo : {},
    caption: doc.caption || '',
    timestamp: doc.timestamp || null,
    internalURL: doc.internalURL || '',
    internalExt: doc.internalExt || '',
    internalSize: doc.internalSize || '',
    internalMime: doc.internalMime || ''
  })
};

/**
 * Where a row sits and the ceiling it is read under, or null when its parent is not stored.
 * `missing` says which answer a push gets: 404 for a project, 503 for a child that beat its parent.
 */
async function placeRow(kind, eagleId, doc) {
  if (kind === KINDS.INSPECTION) {
    // Eagle files an inspection without a project under `customProjectName`: no parent to cap by.
    if (!refId(doc.project)) return { inspection: eagleId, projectId: null, read: eagleBaseAcl(doc.read) };
    const project = await admitParent(doc.project, { childId: eagleId });
    if (!project) return { missing: 404 };
    return { inspection: eagleId, projectId: project.id, read: eagleReadUnder(doc.read, project.read) };
  }

  const parent = await inspections.findParent(kind, eagleId);
  if (!parent) {
    logger.warn(`[${LABEL}] no stored parent lists this ${kind} yet`, { eagleId });
    return { missing: 503 };
  }
  return {
    inspection: parent.inspection,
    projectId: parent.projectId,
    ...(kind === KINDS.ITEM && { element: parent.id }),
    read: eagleReadUnder(doc.read, parent.read)
  };
}

function mirrorItem(kind, eagleId, doc, place, read, existing) {
  return {
    id: eagleId,
    eagleId,
    kind,
    inspection: String(place.inspection),
    projectId: place.projectId === null ? null : String(place.projectId),
    ...(place.element && { element: String(place.element) }),
    sourceSystem: 'eagle',

    ...FIELDS[kind](doc),
    ...auditFields(doc),

    isDeleted: doc.isDeleted === true,
    isPublished: read.includes('public'),
    read,
    sources: { ...(existing && existing.sources), eagle: doc }
  };
}

/** Re-derive the rows under a parent whose level moved. Returns an error message, or null. */
async function cascade(saved) {
  try {
    const result = saved.kind === KINDS.INSPECTION
      ? await inspections.setAclForInspection(saved.inspection, saved.read)
      : await inspections.setAclForElement(saved.inspection, saved.id, saved.read);
    if (result.failed > 0) {
      logger.error(`[${LABEL}] ACL cascade partially failed`, { id: saved.id, ...result });
      return `ACL cascade failed for ${result.failed} row(s) under ${saved.id}`;
    }
    return null;
  } catch (err) {
    logger.error(`[${LABEL}] ACL cascade failed`, { id: saved.id, error: err.message, stack: err.stack });
    return `ACL cascade failed under ${saved.id}`;
  }
}

/**
 * Mirror one raw Eagle record of `kind`.
 *
 * @returns {Promise<{missing: number}|{status: 'conflict'}|{ignored: string, existing: object}
 *   |{saved: object, existing: object|null, cascadeError: string|null}>}
 */
async function mirrorFromEagle(kind, eagleId, doc, { pushedAt = null } = {}) {
  const place = await placeRow(kind, eagleId, doc);
  if (place.missing) return place;

  const read = underDeleteCeiling(place.read, doc);
  const written = await upsertWithRetry(
    inspections,
    (current) => mirrorItem(kind, eagleId, doc, place, read, current),
    () => inspections.readForWrite(eagleId, place.inspection),
    { pushedAt }
  );
  if (written.status === 'conflict' || written.ignored) return written;
  const { saved, existing } = written;

  // Moved inspection: the old partition still holds a listable copy.
  if (existing && String(existing.inspection) !== saved.inspection) {
    await inspections.deleteById(existing.id, existing.inspection);
  }

  const moved = kind !== KINDS.ITEM && existing && levelOfRead(existing.read) !== levelOfRead(saved.read);
  return { saved, existing, cascadeError: moved ? await cascade(saved) : null };
}

function upsertHandler(kind) {
  const targetType = ENTITY[kind];
  const action = `${targetType}.push`;
  return async (req, res) => {
    try {
      const push = eaglePush(req);
      if (!push) {
        return res.status(400).json({ error: 'body.doc._id must match the :eagleId in the path' });
      }
      const { eagleId, doc, pushedAt } = push;

      const written = await mirrorFromEagle(kind, eagleId, doc, { pushedAt });
      if (written.missing === 404) {
        return res.status(404).json({ error: 'Parent project not found', code: refusalCode(doc.project) });
      }
      if (written.missing === 503) {
        return res.status(503).json({ error: 'No stored parent lists this record yet. Push it again.' });
      }
      if (written.status === 'conflict') return pushConflict(res, { label: LABEL, eagleId });
      const { saved, existing, ignored, cascadeError } = written;
      if (ignored) {
        return ignoreStalePush(req, res, {
          label: LABEL, action, targetType, current: existing, projectId: existing.projectId, pushedAt
        });
      }

      auditEvent(req, {
        action,
        targetType,
        targetId: saved.id,
        projectId: saved.projectId,
        detail: { eagleId, inspection: saved.inspection, isDeleted: saved.isDeleted }
      });
      if (cascadeError) return res.status(500).json({ error: cascadeError });
      return res.json({ id: saved.id, action: 'upsert' });
    } catch (err) {
      return mirrorError(res, err, 'inspection controller failed');
    }
  };
}

function readers(kind, notFound) {
  const entity = ENTITY[kind];
  return {
    list: listHandler(entity, (access, query, page) => inspections.listVisible(access, kind, {
      projectId: query.project, inspectionId: query.inspection, elementId: query.element, ...page
    })),
    get: getHandler(entity, notFound,
      (access, id, query) => inspections.getById(access, kind, id, query.inspection))
  };
}

const inspectionReads = readers(KINDS.INSPECTION, 'Inspection not found');
const elementReads = readers(KINDS.ELEMENT, 'Inspection element not found');
const itemReads = readers(KINDS.ITEM, 'Inspection item not found');

exports.mirrorFromEagle = mirrorFromEagle;
exports.upsertInspectionFromEagle = upsertHandler(KINDS.INSPECTION);
exports.upsertElementFromEagle = upsertHandler(KINDS.ELEMENT);
exports.upsertItemFromEagle = upsertHandler(KINDS.ITEM);
exports.getInspections = inspectionReads.list;
exports.getInspection = inspectionReads.get;
exports.getInspectionElements = elementReads.list;
exports.getInspectionElement = elementReads.get;
exports.getInspectionItems = itemReads.list;
exports.getInspectionItem = itemReads.get;
