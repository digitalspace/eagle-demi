'use strict';

/**
 * NRPTI (CORE) mines, one row per mine and linked project, partitioned by `/projectId`, 7-day TTL: the
 * sync re-upserts every linked mine, so a dropped link expires. A scalar `projectId` is the scope axis.
 */

const cosmos = require('../db/cosmos-nosql');
const { eq, selectWhere, pageOptions } = require('./_sql');

const CONTAINER = 'mines';
const PARTITION_FIELD = 'projectId';
const SCOPE_FIELD = 'projectId';

/** One page of one project's mines this caller may read; single-partition. */
async function listByProject(access, projectId, { pageSize, continuationToken } = {}) {
  const spec = selectWhere({
    access,
    partitionField: SCOPE_FIELD,
    criteria: [eq(PARTITION_FIELD, String(projectId), '@projectId')],
    orderBy: 'c.id ASC'
  });
  return cosmos.query(CONTAINER, spec, pageOptions({ pageSize, continuationToken, partitionKey: String(projectId) }));
}

async function upsert(mine) {
  return cosmos.upsert(CONTAINER, mine);
}

module.exports = {
  CONTAINER,
  PARTITION_FIELD,
  SCOPE_FIELD,
  listByProject,
  upsert
};
