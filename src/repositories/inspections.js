'use strict';

/**
 * Inspections repository — Cosmos NoSQL.
 *
 * Container `inspections` holds three Eagle kinds, told apart by `kind`: `Inspection`,
 * `InspectionElement` and `InspectionItem`. Partitioned by `/inspection`, the DEMI id of the
 * inspection a row belongs to (its own id on an `Inspection` row), so one inspection with all its
 * elements and items is one partition: the parent a child is capped by is read in-partition, and an
 * ACL cascade is one single-partition batch. `projectId` rides on every row as the scope axis, as
 * on `comments`; an inspection Eagle filed without a project carries null and no scoped caller reads it.
 *
 * Eagle's own `inspectionId`, `elementId` and `itemId` are the inspector app's client ids and are
 * stored as Eagle sends them; the parent links are `inspection` and `element`.
 */

const cosmos = require('../db/cosmos-nosql');
const { canRead, levelOfRead, systemAccess } = require('../helpers/access-sql');
const { cascadeAcl } = require('../helpers/acl-cascade');
const { eq, selectWhere, selectFor, pageOptions, upsertItem, readForWriteIn, fetchAll } = require('./_sql');

const CONTAINER = 'inspections';
const PARTITION_FIELD = 'inspection';
const SCOPE_FIELD = 'projectId';
const ACL_SELECT = 'c.id, c.read, c.isDeleted, c.sources.eagle.read AS eagleRead';

const KINDS = Object.freeze({
  INSPECTION: 'Inspection',
  ELEMENT: 'InspectionElement',
  ITEM: 'InspectionItem'
});

/** vis catalog entity per kind. */
const ENTITY = Object.freeze({
  [KINDS.INSPECTION]: 'inspections',
  [KINDS.ELEMENT]: 'inspectionElements',
  [KINDS.ITEM]: 'inspectionItems'
});

/** The parent kind and the array on it that lists a child's id. */
const PARENT = Object.freeze({
  [KINDS.ELEMENT]: { kind: KINDS.INSPECTION, field: 'elements' },
  [KINDS.ITEM]: { kind: KINDS.ELEMENT, field: 'items' }
});

/** Point read with the inspection; without it, the predicate runs in a cross-partition query. */
async function getById(access, kind, id, inspectionId) {
  if (inspectionId) {
    const item = await cosmos.readItem(CONTAINER, String(id), String(inspectionId));
    return item && item.kind === kind && canRead(item, access, SCOPE_FIELD) ? item : null;
  }
  const spec = selectWhere({
    access,
    partitionField: SCOPE_FIELD,
    criteria: [eq('kind', kind, '@kind'), eq('id', String(id), '@id')]
  });
  return cosmos.queryFirst(CONTAINER, spec, {});
}

/** The stored row, unfiltered: a mirror write asks whether it exists, not who may read it. */
async function readForWrite(id, inspectionId) {
  return readForWriteIn(CONTAINER, id, inspectionId, PARTITION_FIELD);
}

/**
 * The stored parent whose `elements[]` or `items[]` lists this child, unfiltered — Eagle links
 * downward only. Two claimants: the narrower one, so a child is never stored wider than either.
 */
async function findParent(childKind, childId) {
  const parent = PARENT[childKind];
  const { items } = await cosmos.query(CONTAINER, {
    query: `SELECT * FROM c WHERE c.kind = @kind AND ARRAY_CONTAINS(c.${parent.field}, @child)`,
    parameters: [{ name: '@kind', value: parent.kind }, { name: '@child', value: String(childId) }]
  });
  if (items.length === 0) return null;
  return items.reduce((a, b) => (levelOfRead(b.read) < levelOfRead(a.read) ? b : a));
}

/** One page of one kind this caller may read, single-partition when `inspectionId` is given. */
async function listVisible(access, kind, { projectId, inspectionId, elementId, pageSize, continuationToken } = {}) {
  const criteria = [eq('kind', kind, '@kind')];
  if (projectId) criteria.push(eq(SCOPE_FIELD, String(projectId), '@projectId'));
  if (inspectionId) criteria.push(eq(PARTITION_FIELD, String(inspectionId), '@inspection'));
  if (elementId) criteria.push(eq('element', String(elementId), '@element'));

  const spec = selectWhere({
    access,
    partitionField: SCOPE_FIELD,
    criteria,
    select: selectFor(ENTITY[kind], access, SCOPE_FIELD),
    orderBy: 'c.id ASC'
  });
  return cosmos.query(CONTAINER, spec, pageOptions({
    pageSize, continuationToken, partitionKey: inspectionId ? String(inspectionId) : undefined
  }));
}

/** Whole-item write. A child moved to another inspection changes partition — see `upsertItem`. */
async function upsert(item, existing) {
  return upsertItem(CONTAINER, PARTITION_FIELD, item, existing);
}

/** Removes the row a child moved to another inspection left in its old partition. */
async function deleteById(id, inspectionId) {
  return cosmos.remove(CONTAINER, String(id), String(inspectionId));
}

/** The ACL inputs a cascade derives from. systemAccess skips a sealed row, as the comment cascade does. */
function aclSpec(criteria) {
  return selectWhere({ access: systemAccess(), partitionField: SCOPE_FIELD, criteria, select: ACL_SELECT });
}

/** The ACL inputs of one kind in one inspection, optionally under one element. */
async function aclRows(inspectionId, kind, elementId) {
  const criteria = [eq(PARTITION_FIELD, String(inspectionId), '@inspection'), eq('kind', kind, '@kind')];
  if (elementId) criteria.push(eq('element', String(elementId), '@element'));
  const { items } = await cosmos.query(CONTAINER, aclSpec(criteria), { partitionKey: String(inspectionId) });
  return items;
}

function sum(a, b) {
  return { succeeded: a.succeeded + b.succeeded, failed: a.failed + b.failed };
}

/** Re-derive the items of one element from the element's ACL. */
async function setAclForElement(inspectionId, elementId, read) {
  const rows = await aclRows(inspectionId, KINDS.ITEM, elementId);
  const { succeeded, failed } = await cascadeAcl(CONTAINER, inspectionId, rows, read);
  return { succeeded, failed };
}

/** Re-derive every element from the inspection's ACL, then every item from its element's new one. */
async function setAclForInspection(inspectionId, read) {
  const elements = await cascadeAcl(CONTAINER, inspectionId, await aclRows(inspectionId, KINDS.ELEMENT), read);
  let total = { succeeded: elements.succeeded, failed: elements.failed };
  for (const element of elements.rows) {
    total = sum(total, await setAclForElement(inspectionId, element.id, element.read));
  }
  return total;
}

/**
 * Re-derive every inspection of one project from the project's ACL, then the chain under each.
 * Cross-partition: one partition per inspection, and a project holds few.
 */
async function setAclForProject(projectId, read) {
  const spec = aclSpec([eq('kind', KINDS.INSPECTION, '@kind'), eq(SCOPE_FIELD, String(projectId), '@projectId')]);
  const { items } = await cosmos.query(CONTAINER, spec);
  let total = { succeeded: 0, failed: 0 };
  for (const row of items) {
    const own = await cascadeAcl(CONTAINER, row.id, [row], read);
    total = sum(total, own);
    total = sum(total, await setAclForInspection(row.id, own.rows[0].read));
  }
  return total;
}

/** Every row of all three kinds with its ACL inputs and parent links — for the reconcile only. */
async function listAclRows(access) {
  return fetchAll(CONTAINER, selectWhere({
    access,
    partitionField: SCOPE_FIELD,
    select: `${ACL_SELECT}, c.kind, c.projectId, c.inspection, c.element, c.isPublished, c.sealedAt`
  }));
}

module.exports = {
  listAclRows,
  CONTAINER,
  PARTITION_FIELD,
  SCOPE_FIELD,
  KINDS,
  ENTITY,
  getById,
  readForWrite,
  findParent,
  listVisible,
  upsert,
  deleteById,
  setAclForElement,
  setAclForInspection,
  setAclForProject
};
