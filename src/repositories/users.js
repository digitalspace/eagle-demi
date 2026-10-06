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
const {
  selectWhere, selectFor, countWhere, pageOptions, readPage, upsertItem, readForWriteIn, fetchAll
} = require('./_sql');

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

function visibleSpec(access) {
  return selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    select: selectFor(ENTITY, access, PARTITION_FIELD),
    orderBy: 'c.id ASC'
  });
}

/** One page of the users this caller may read, in id order. */
async function listVisible(access, { pageSize, continuationToken } = {}) {
  return cosmos.query(CONTAINER, visibleSpec(access), pageOptions({ pageSize, continuationToken }));
}

/** One offset page (`pageNum`, `pageSize`) of `listVisible`'s rows, as `/search` pages. */
async function listPage(access, { pageNum, pageSize } = {}) {
  return readPage(CONTAINER, visibleSpec(access), { pageNum, pageSize });
}

/** The same predicate as the read, so the total never counts a user the page could not hold. */
async function countVisible(access) {
  const { items } = await cosmos.query(CONTAINER, countWhere({ access, partitionField: PARTITION_FIELD }), {});
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

module.exports = {
  CONTAINER, PARTITION_FIELD, getById, readForWrite, listVisible, listPage, countVisible, upsert, listAclRows
};
