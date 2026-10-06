'use strict';

/**
 * Users repository — Cosmos NoSQL.
 *
 * Container `users` (Eagle `User`), partitioned by `/id`. A user is not project data, so `id` is
 * also the field the scope and team arms compare: no project scope or team holds a user id, so a
 * project-scoped caller reads no user at all rather than every user.
 */

const cosmos = require('../db/cosmos-nosql');
const { canRead } = require('../helpers/access-sql');
const { selectWhere, selectFor, pageOptions, upsertItem, readForWriteIn, fetchAll } = require('./_sql');

const CONTAINER = 'users';
const PARTITION_FIELD = 'id';
const ENTITY = 'users';

/** Point read, then the same predicate the list runs. */
async function getById(access, id) {
  const item = await cosmos.readItem(CONTAINER, String(id), String(id));
  return item && canRead(item, access, PARTITION_FIELD) ? item : null;
}

/** The stored row, unfiltered: a mirror write asks whether it exists, not who may read it. */
async function readForWrite(id) {
  return readForWriteIn(CONTAINER, id, id, PARTITION_FIELD);
}

/** One page of the users this caller may read, in id order. */
async function listVisible(access, { pageSize, continuationToken } = {}) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    select: selectFor(ENTITY, access, PARTITION_FIELD),
    orderBy: 'c.id ASC'
  });
  return cosmos.query(CONTAINER, spec, pageOptions({ pageSize, continuationToken }));
}

async function upsert(item, existing) {
  return upsertItem(CONTAINER, PARTITION_FIELD, item, existing);
}

/** Every row's ACL inputs, whole container — for the reconcile only. */
async function listAclRows(access) {
  return fetchAll(CONTAINER, selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    select: 'c.id, c.read, c.isPublished, c.isDeleted, c.sealedAt, c.sources.eagle.read AS eagleRead'
  }));
}

module.exports = { CONTAINER, PARTITION_FIELD, getById, readForWrite, listVisible, upsert, listAclRows };
