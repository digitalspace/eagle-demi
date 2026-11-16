'use strict';

/**
 * NRPTI compliance records (inspections, orders, permits and the rest, by `kind`), partitioned by
 * `/projectId`, 7-day TTL: the sync re-upserts every linked record, so a dropped one expires.
 */

const cosmos = require('../db/cosmos-nosql');
const { eq, selectWhere, selectFor, pageOptions } = require('./_sql');

const CONTAINER = 'regulatoryRecords';
const PARTITION_FIELD = 'projectId';
const SCOPE_FIELD = 'projectId';

/** One page of one project's records this caller may read; single-partition. */
async function listByProject(access, projectId, { pageSize, continuationToken } = {}) {
  const spec = selectWhere({
    access,
    partitionField: SCOPE_FIELD,
    criteria: [eq(PARTITION_FIELD, String(projectId), '@projectId')],
    select: selectFor('regulatoryRecords', access, SCOPE_FIELD),
    orderBy: 'c.id ASC'
  });
  return cosmos.query(CONTAINER, spec, pageOptions({ pageSize, continuationToken, partitionKey: String(projectId) }));
}

async function upsert(record) {
  return cosmos.upsert(CONTAINER, record);
}

module.exports = {
  CONTAINER,
  PARTITION_FIELD,
  SCOPE_FIELD,
  listByProject,
  upsert
};
