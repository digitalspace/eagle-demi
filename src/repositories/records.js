'use strict';

/**
 * NRPTI compliance records — Cosmos NoSQL.
 *
 * Container `records`, partitioned by `/projectId`. 0 of 4,045 records are unlinked, so there
 * is no hot empty-string partition.
 *
 * These are REFERENCED, never folded into the project. The old sync embedded full record
 * objects into each project twice, each carrying the raw upstream payload — roughly 250
 * records before a project exceeded the 2 MB item cap, which Mongo's 16 MB limit was hiding.
 * Projects now carry only the bounded aggregate.
 */

const cosmos = require('../db/cosmos-nosql');
const { canRead } = require('../helpers/access-sql');
const { eq, contains, selectWhere, countWhere, pageOptions } = require('./_sql');

const CONTAINER = 'records';
const PARTITION_FIELD = 'projectId';

function buildCriteria({ projectId, dataset, agency, projectName }) {
  const criteria = [];
  if (projectId) criteria.push(eq('projectId', String(projectId), '@projectId'));
  if (dataset) criteria.push(eq('nrptiSchemaName', String(dataset), '@dataset'));
  if (agency) criteria.push(eq('issuingAgency', String(agency), '@agency'));

  // CONTAINS with the case-insensitive flag, not RegexMatch: caller input never becomes a
  // pattern, so the ReDoS and regex-injection surface of the old $regex path is gone along
  // with the escapeRegex helper that guarded it.
  if (projectName) criteria.push(contains('projectName', String(projectName), '@projectName'));

  return criteria;
}

async function listVisible(access, opts = {}) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: buildCriteria(opts),
    orderBy: 'c.dateIssued DESC'
  });

  const options = pageOptions({
    ...opts,
    partitionKey: opts.projectId ? String(opts.projectId) : undefined
  });

  return cosmos.query(CONTAINER, spec, options);
}

async function countVisible(access, opts = {}) {
  const spec = countWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: buildCriteria(opts)
  });
  const value = await cosmos.queryValue(CONTAINER, spec);
  return value || 0;
}

async function getById(access, id, projectId) {
  if (projectId) {
    const doc = await cosmos.readItem(CONTAINER, String(id), String(projectId));
    if (!doc) return null;
    return canRead(doc, access, PARTITION_FIELD) ? doc : null;
  }

  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [eq('id', String(id), '@id')]
  });
  const { items } = await cosmos.query(CONTAINER, spec, { maxItemCount: 1 });
  return items[0] || null;
}

async function upsert(record) {
  return cosmos.upsert(CONTAINER, record);
}

/** Bulk write for the seeder. All operations must share one partition key value. */
async function bulkUpsertForProject(projectId, records) {
  const operations = records.map(resourceBody => ({
    operationType: 'Upsert',
    partitionKey: String(projectId),
    resourceBody
  }));
  return cosmos.bulk(CONTAINER, operations);
}

module.exports = {
  CONTAINER,
  PARTITION_FIELD,
  buildCriteria,
  listVisible,
  countVisible,
  getById,
  upsert,
  bulkUpsertForProject
};
