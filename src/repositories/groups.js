'use strict';

/**
 * Groups repository — Cosmos NoSQL.
 *
 * Container `groups` (Eagle `Group`, a project's contact group), partitioned by `/projectId`: a
 * group belongs to one project and every list is "the groups of this project". `projectId` is the
 * DEMI project id, as `documents` and `commentPeriods` store it.
 */

const cosmos = require('../db/cosmos-nosql');
const { canRead, systemAccess } = require('../helpers/access-sql');
const { cascadeAcl } = require('../helpers/acl-cascade');
const {
  eq, selectWhere, selectFor, countWhere, pageOptions, readPage, upsertItem, readForWriteIn, fetchAll
} = require('./_sql');

const CONTAINER = 'groups';
const PARTITION_FIELD = 'projectId';
const ENTITY = 'groups';

/** Point read with the project; without it, the predicate runs in a cross-partition query. */
async function getById(access, id, projectId) {
  if (projectId) {
    const item = await cosmos.readItem(CONTAINER, String(id), String(projectId));
    return item && canRead(item, access, PARTITION_FIELD) ? item : null;
  }
  const spec = selectWhere({ access, partitionField: PARTITION_FIELD, criteria: [eq('id', String(id), '@id')] });
  return cosmos.queryFirst(CONTAINER, spec, {});
}

/** The stored row, unfiltered: a mirror write asks whether it exists, not who may read it. */
async function readForWrite(id, projectId) {
  return readForWriteIn(CONTAINER, id, projectId, PARTITION_FIELD);
}

function criteriaFor(projectId) {
  return projectId ? [eq(PARTITION_FIELD, String(projectId), '@projectId')] : [];
}

function visibleSpec(access, projectId) {
  return selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: criteriaFor(projectId),
    select: selectFor(ENTITY, access, PARTITION_FIELD),
    orderBy: 'c.id ASC'
  });
}

const partitionOf = (projectId) => (projectId ? String(projectId) : undefined);

/** One page of the groups this caller may read, single-partition when `projectId` is given. */
async function listVisible(access, { projectId, pageSize, continuationToken } = {}) {
  return cosmos.query(CONTAINER, visibleSpec(access, projectId), pageOptions({
    pageSize, continuationToken, partitionKey: partitionOf(projectId)
  }));
}

/** One offset page (`pageNum`, `pageSize`) of `listVisible`'s rows, as `/search` pages. */
async function listPage(access, { projectId, pageNum, pageSize } = {}) {
  return readPage(CONTAINER, visibleSpec(access, projectId), {
    pageNum, pageSize, partitionKey: partitionOf(projectId)
  });
}

/** The same predicate as the read. */
async function countVisible(access, { projectId } = {}) {
  const spec = countWhere({ access, partitionField: PARTITION_FIELD, criteria: criteriaFor(projectId) });
  const { items } = await cosmos.query(CONTAINER, spec, pageOptions({ partitionKey: partitionOf(projectId) }));
  return items[0] || 0;
}

/** Whole-item write. A group moved to another project changes partition — see `upsertItem`. */
async function upsert(item, existing) {
  return upsertItem(CONTAINER, PARTITION_FIELD, item, existing);
}

/** Removes the row a group moved to another project left in its old partition. */
async function deleteById(id, projectId) {
  return cosmos.remove(CONTAINER, String(id), String(projectId));
}

/** Re-derive every group of one project from the project's ACL. systemAccess skips a sealed row. */
async function setAclForProject(projectId, read) {
  const spec = selectWhere({
    access: systemAccess(),
    partitionField: PARTITION_FIELD,
    criteria: [eq(PARTITION_FIELD, String(projectId), '@projectId')],
    select: 'c.id, c.read, c.isDeleted, c.sources.eagle.read AS eagleRead'
  });
  const { items } = await cosmos.query(CONTAINER, spec, { partitionKey: String(projectId) });
  return cascadeAcl(CONTAINER, projectId, items, read);
}

/** Every row's ACL inputs, whole container — for the reconcile only. */
async function listAclRows(access) {
  return fetchAll(CONTAINER, selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    select: 'c.id, c.projectId, c.read, c.isPublished, c.isDeleted, c.sealedAt, c.sources.eagle.read AS eagleRead'
  }));
}

module.exports = {
  CONTAINER, PARTITION_FIELD, getById, readForWrite, listVisible, listPage, countVisible, upsert, deleteById,
  setAclForProject, listAclRows
};
