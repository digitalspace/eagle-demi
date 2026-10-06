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
const { canRead, levelOfRead } = require('../helpers/access-sql');
const { cascadeAcl } = require('../helpers/acl-cascade');
const {
  eq, selectWhere, selectFor, countWhere, pageOptions, readPage, upsertItem, readForWriteIn
} = require('./_sql');

const CONTAINER = 'inspections';
const PARTITION_FIELD = 'inspection';
const SCOPE_FIELD = 'projectId';

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

function criteriaFor(kind, { projectId, inspectionId, elementId }) {
  const criteria = [eq('kind', kind, '@kind')];
  if (projectId) criteria.push(eq(SCOPE_FIELD, String(projectId), '@projectId'));
  if (inspectionId) criteria.push(eq(PARTITION_FIELD, String(inspectionId), '@inspection'));
  if (elementId) criteria.push(eq('element', String(elementId), '@element'));
  return criteria;
}

function visibleSpec(access, kind, filters) {
  return selectWhere({
    access,
    partitionField: SCOPE_FIELD,
    criteria: criteriaFor(kind, filters),
    select: selectFor(ENTITY[kind], access, SCOPE_FIELD),
    orderBy: 'c.id ASC'
  });
}

const partitionOf = (inspectionId) => (inspectionId ? String(inspectionId) : undefined);

/** One page of one kind this caller may read, single-partition when `inspectionId` is given. */
async function listVisible(access, kind, { projectId, inspectionId, elementId, pageSize, continuationToken } = {}) {
  return cosmos.query(CONTAINER, visibleSpec(access, kind, { projectId, inspectionId, elementId }), pageOptions({
    pageSize, continuationToken, partitionKey: partitionOf(inspectionId)
  }));
}

/** One offset page (`pageNum`, `pageSize`) of `listVisible`'s rows, as `/search` pages. */
async function listPage(access, kind, { projectId, inspectionId, elementId, pageNum, pageSize } = {}) {
  return readPage(CONTAINER, visibleSpec(access, kind, { projectId, inspectionId, elementId }), {
    pageNum, pageSize, partitionKey: partitionOf(inspectionId)
  });
}

/** The same predicate as the read. */
async function countVisible(access, kind, filters = {}) {
  const spec = countWhere({ access, partitionField: SCOPE_FIELD, criteria: criteriaFor(kind, filters) });
  const { items } = await cosmos.query(CONTAINER, spec, pageOptions({ partitionKey: partitionOf(filters.inspectionId) }));
  return items[0] || 0;
}

/** Whole-item write. A child moved to another inspection changes partition — see `upsertItem`. */
async function upsert(item, existing) {
  return upsertItem(CONTAINER, PARTITION_FIELD, item, existing);
}

/** Removes the row a child moved to another inspection left in its old partition. */
async function deleteById(id, inspectionId) {
  return cosmos.remove(CONTAINER, String(id), String(inspectionId));
}

/** The ACL inputs of one kind in one inspection, optionally under one element. Unfiltered on purpose. */
async function aclRows(inspectionId, kind, elementId) {
  const criteria = ['c.inspection = @inspection', 'c.kind = @kind'];
  const parameters = [{ name: '@inspection', value: String(inspectionId) }, { name: '@kind', value: kind }];
  if (elementId) {
    criteria.push('c.element = @element');
    parameters.push({ name: '@element', value: String(elementId) });
  }
  const { items } = await cosmos.query(CONTAINER, {
    query: `SELECT c.id, c.read, c.isDeleted, c.sources.eagle.read AS eagleRead FROM c WHERE ${criteria.join(' AND ')}`,
    parameters
  }, { partitionKey: String(inspectionId) });
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

module.exports = {
  CONTAINER,
  PARTITION_FIELD,
  SCOPE_FIELD,
  KINDS,
  ENTITY,
  getById,
  readForWrite,
  findParent,
  listVisible,
  listPage,
  countVisible,
  upsert,
  deleteById,
  setAclForElement,
  setAclForInspection
};
