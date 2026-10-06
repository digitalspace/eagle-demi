'use strict';

/**
 * Groups repository — Cosmos NoSQL.
 *
 * Container `groups` (Eagle `Group`, a project's contact group), partitioned by `/projectId`: a
 * group belongs to one project and every list is "the groups of this project". `projectId` is the
 * DEMI project id, as `documents` and `commentPeriods` store it.
 */

const cosmos = require('../db/cosmos-nosql');
const { canRead } = require('../helpers/access-sql');
const { eq, selectWhere, selectFor, pageOptions, upsertItem, readForWriteIn } = require('./_sql');

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

/** One page of the groups this caller may read, single-partition when `projectId` is given. */
async function listVisible(access, { projectId, pageSize, continuationToken } = {}) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: projectId ? [eq(PARTITION_FIELD, String(projectId), '@projectId')] : [],
    select: selectFor(ENTITY, access, PARTITION_FIELD),
    orderBy: 'c.id ASC'
  });
  return cosmos.query(CONTAINER, spec, pageOptions({
    pageSize, continuationToken, partitionKey: projectId ? String(projectId) : undefined
  }));
}

/** Whole-item write. A group moved to another project changes partition — see `upsertItem`. */
async function upsert(item, existing) {
  return upsertItem(CONTAINER, PARTITION_FIELD, item, existing);
}

/** Removes the row a group moved to another project left in its old partition. */
async function deleteById(id, projectId) {
  return cosmos.remove(CONTAINER, String(id), String(projectId));
}

module.exports = { CONTAINER, PARTITION_FIELD, getById, readForWrite, listVisible, upsert, deleteById };
