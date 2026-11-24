'use strict';

/**
 * Container `users`, partitioned by `/id`, also the scope axis: no scope holds a user id, so a scoped
 * caller reads no user. An `isDeleted` row stays for the reconcile; reads skip it (`NOT_DELETED`).
 */

const cosmos = require('../db/cosmos-nosql');
const { canRead } = require('../helpers/access-sql');
const { cosmosKind } = require('../helpers/native-query');
const {
  eq, selectWhere, upsertItem, readForWriteIn, fetchAll, NOT_DELETED, withCriteria
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

async function upsert(item, existing) {
  return upsertItem(CONTAINER, PARTITION_FIELD, item, existing);
}

/** The users of one organization, for its rename. `/org` is not indexed, so this scans the container. */
async function listByOrg(access, orgId) {
  return fetchAll(CONTAINER, selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [eq('org', String(orgId), '@org'), NOT_DELETED]
  }));
}

/**
 * Every row's ACL inputs, whole container — for the reconcile only. A row DEMI owns carries no
 * `eagleRead`: a later push still stores an Eagle copy, but the row's read is DEMI's, not derived from it.
 */
async function listAclRows(access) {
  const rows = await fetchAll(CONTAINER, selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    select: 'c.id, c.read, c.isPublished, c.isDeleted, c.sealedAt, c.sourceSystem, c.sources.eagle.read AS eagleRead'
  }));
  return rows.map(({ sourceSystem, eagleRead, ...row }) => (sourceSystem === 'demi' ? row : { ...row, eagleRead }));
}

/** The native list contract's reads (`helpers/native-query.js`); by id keeps the point read above. */
const native = {
  ...withCriteria(cosmosKind({
    container: CONTAINER, entity: ENTITY, partitionField: PARTITION_FIELD, defaultOrder: 'c.id ASC'
  }), [NOT_DELETED]),
  getById
};

module.exports = {
  CONTAINER, PARTITION_FIELD, getById, readForWrite, upsert, listByOrg, listAclRows, native
};
