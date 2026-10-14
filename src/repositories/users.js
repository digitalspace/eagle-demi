'use strict';

/**
 * Users repository — Cosmos NoSQL.
 *
 * Container `users` (Eagle `User`), partitioned by `/id`. A user is not project data, so `id` is
 * also the field the scope and team arms compare: no project scope or team holds a user id, so a
 * project-scoped caller reads no user at all rather than every user.
 *
 * A user pushed with `isDeleted` stays stored for the reconcile; no read here serves it
 * (`NOT_DELETED`), as eagle-api's search never did.
 */

const cosmos = require('../db/cosmos-nosql');
const { canRead } = require('../helpers/access-sql');
const { cosmosKind } = require('../helpers/native-query');
const {
  selectWhere, selectFor, countWhere, readPage, upsertItem, readForWriteIn, fetchAll, NOT_DELETED, withCriteria
} = require('./_sql');

const CONTAINER = 'users';
const PARTITION_FIELD = 'id';
const ENTITY = 'users';

/** Point read, then the same predicate the list runs. */
async function getById(access, id) {
  const item = await cosmos.readItem(CONTAINER, String(id), String(id));
  return item && item.isDeleted !== true && canRead(item, access, PARTITION_FIELD) ? item : null;
}

/** The stored row, unfiltered: a mirror write asks whether it exists, not who may read it. */
async function readForWrite(id) {
  return readForWriteIn(CONTAINER, id, id, PARTITION_FIELD);
}

function visibleSpec(access) {
  return selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [NOT_DELETED],
    select: selectFor(ENTITY, access, PARTITION_FIELD),
    orderBy: 'c.id ASC'
  });
}

/** One offset page (`pageNum`, `pageSize`) of the users this caller may read, in id order, as `/search` pages. */
async function listPage(access, { pageNum, pageSize } = {}) {
  return readPage(CONTAINER, visibleSpec(access), { pageNum, pageSize });
}

/** The same predicate as the read, so the total never counts a user the page could not hold. */
async function countVisible(access) {
  const { items } = await cosmos.query(CONTAINER, countWhere({ access, partitionField: PARTITION_FIELD, criteria: [NOT_DELETED] }), {});
  return items[0] || 0;
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

/** The native list contract's reads (`helpers/native-query.js`); by id keeps the point read above. */
const native = {
  ...withCriteria(cosmosKind({
    container: CONTAINER, entity: ENTITY, partitionField: PARTITION_FIELD, defaultOrder: 'c.id ASC'
  }), [NOT_DELETED]),
  getById
};

module.exports = {
  CONTAINER, PARTITION_FIELD, getById, readForWrite, listPage, countVisible, upsert, listAclRows, native
};
