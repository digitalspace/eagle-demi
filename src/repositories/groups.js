'use strict';

/**
 * Groups repository — Cosmos NoSQL.
 *
 * Container `groups` (Eagle `Group`, a project's contact group), partitioned by `/projectId`: a
 * group belongs to one project and every list is "the groups of this project". `projectId` is the
 * DEMI project id, as `documents` and `commentPeriods` store it.
 *
 * A group Eagle deleted stays stored, flagged `isDeleted`, for the reconcile and the ACL cascade;
 * no read here serves it (`NOT_DELETED`), as eagle-api's search never did.
 */

const cosmos = require('../db/cosmos-nosql');
const { systemAccess } = require('../helpers/access-sql');
const { cascadeAcl } = require('../helpers/acl-cascade');
const { cosmosKind } = require('../helpers/native-query');
const {
  eq, selectWhere, selectFor, countWhere, pageOptions, readPage, upsertItem, readForWriteIn, fetchAll,
  NOT_DELETED, withCriteria
} = require('./_sql');

const CONTAINER = 'groups';
const PARTITION_FIELD = 'projectId';
const ENTITY = 'groups';

/** The read predicate, narrowed to one id across every partition. */
async function getById(access, id, select) {
  const spec = selectWhere({
    access, partitionField: PARTITION_FIELD, criteria: [NOT_DELETED, eq('id', String(id), '@id')], select
  });
  return cosmos.queryFirst(CONTAINER, spec, {});
}

/** The stored row, unfiltered: a mirror write asks whether it exists, not who may read it. */
async function readForWrite(id, projectId) {
  return readForWriteIn(CONTAINER, id, projectId, PARTITION_FIELD);
}

function criteriaFor(projectId) {
  return [NOT_DELETED, ...(projectId ? [eq(PARTITION_FIELD, String(projectId), '@projectId')] : [])];
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

/** One offset page (`pageNum`, `pageSize`) of the groups this caller may read, as `/search` pages. */
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

/** Removes one row: a moved group's old copy, or a staff delete on the revision it read (`etag`). */
async function deleteById(id, projectId, etag) {
  return cosmos.remove(CONTAINER, String(id), String(projectId), { etag });
}

/**
 * Re-derive every group of one project from the project's ACL. systemAccess skips a sealed row. A
 * row DEMI created takes its own ACL from `sources.demi.read`, since `read` is already narrowed.
 */
async function setAclForProject(projectId, read) {
  const spec = selectWhere({
    access: systemAccess(),
    partitionField: PARTITION_FIELD,
    criteria: [eq(PARTITION_FIELD, String(projectId), '@projectId')],
    select: 'c.id, c.read, c.isDeleted, c.sourceSystem, c.sources.eagle.read AS eagleRead, c.sources.demi.read AS demiRead'
  });
  const { items } = await cosmos.query(CONTAINER, spec, { partitionKey: String(projectId) });
  const rows = items.map(({ sourceSystem, demiRead, eagleRead, ...row }) =>
    ({ ...row, eagleRead: sourceSystem === 'demi' ? demiRead : eagleRead }));
  return cascadeAcl(CONTAINER, projectId, rows, read);
}

/** Every row's ACL inputs, whole container — for the reconcile only. */
async function listAclRows(access) {
  return fetchAll(CONTAINER, selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    select: 'c.id, c.projectId, c.read, c.isPublished, c.isDeleted, c.sealedAt, c.sources.eagle.read AS eagleRead'
  }));
}

/** The native list contract's reads (`helpers/native-query.js`). */
const native = {
  ...withCriteria(cosmosKind({
    container: CONTAINER, entity: ENTITY, partitionField: PARTITION_FIELD, defaultOrder: 'c.id ASC'
  }), [NOT_DELETED]),
  getById: (access, id) => getById(access, id, selectFor(ENTITY, access, PARTITION_FIELD))
};

module.exports = {
  CONTAINER, PARTITION_FIELD, getById, readForWrite, listPage, countVisible, upsert, deleteById,
  setAclForProject, listAclRows, native
};
