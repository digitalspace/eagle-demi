'use strict';

/**
 * Container `boundaries`, partitioned by `/type`: three values suit 281 small items listed by type.
 * Simplified geometry only; full GeoJSON nears the 2 MB item cap and ships in frontend/public/assets/geojson/.
 */

const cosmos = require('../db/cosmos-nosql');
const { selectWhere, countWhere, pageOptions, eq } = require('./_sql');
const { firstByIdAcross } = require('./_first-by-id');
const { canRead } = require('../helpers/access-sql');

const CONTAINER = 'boundaries';
const PARTITION_FIELD = 'type';

/**
 * No project axis, so the predicate is role-only. Scoping on a field the items lack would blank
 * the map for every project-scoped caller.
 */
const SCOPE_FIELD = null;

/**
 * Boundaries by type. Single-partition when a type is given.
 *
 * @param {object}  access              from resolveAccess()
 * @param {string}  [opts.type]         omit for all types (cross-partition; 281 items)
 * @param {boolean} [opts.withGeometry] default true: the frontend sends `geometry=simplified` or nothing, and both want polygons
 * @param {number}  [opts.pageSize]     bounded read; omit and the whole type is returned
 */
async function listByType(access, { type, withGeometry = true, pageSize, continuationToken } = {}) {
  const select = withGeometry ? '*' : 'c.id, c.type, c.name, c.code';

  const spec = selectWhere({
    access,
    partitionField: SCOPE_FIELD,
    criteria: type ? [eq('type', String(type), '@type')] : [],
    select,
    orderBy: 'c.name ASC'
  });

  const options = pageOptions({ pageSize, continuationToken });
  if (type) options.partitionKey = String(type);

  // `pageOptions` is the only clamp; the caller compares against the number that bounded the read,
  // or a junk `?pageSize` would hide a truncated page.
  const result = await cosmos.query(CONTAINER, spec, options);
  return { ...result, pageSize: options.maxItemCount };
}

/**
 * Point read by id. Gated with canRead(): `readItem` bypasses the query predicate entirely, so
 * without this a by-id fetch would return a restricted boundary that the list withholds.
 */
async function getById(access, id, type) {
  if (type) {
    const doc = await cosmos.readItem(CONTAINER, String(id), String(type));
    return canRead(doc, access, SCOPE_FIELD) ? doc : null;
  }

  return firstByIdAcross(CONTAINER, access, SCOPE_FIELD, id);
}

/**
 * `type` is optional: the frontend calls `/boundaries/<name>` without it, and with 281 items in 3
 * partitions the cross-partition fallback is cheap.
 */
async function getByName(access, name, type) {
  const scoped = type !== undefined && type !== null && String(type) !== '';

  const criteria = [];
  if (scoped) criteria.push(eq('type', String(type), '@type'));
  criteria.push(eq('name', String(name), '@name'));

  const spec = selectWhere({ access, partitionField: SCOPE_FIELD, criteria });

  // `queryFirst` fixes the page size at 1 itself and drains: unscoped this is cross-partition, and
  // one page of that can come back empty while the boundary exists.
  const options = scoped ? { partitionKey: String(type) } : {};

  return await cosmos.queryFirst(CONTAINER, spec, options);
}

/**
 * How many boundaries this caller may see. Shares the read predicate through `countWhere`, so a
 * restricted boundary cannot be inferred from a total that includes it.
 */
async function countVisible(access, { type } = {}) {
  const spec = countWhere({
    access,
    partitionField: SCOPE_FIELD,
    criteria: type ? [eq('type', String(type), '@type')] : []
  });
  const value = await cosmos.queryValue(CONTAINER, spec);
  return value || 0;
}

async function upsert(boundary) {
  return cosmos.upsert(CONTAINER, boundary);
}

/** Bulk load for the seeder — one call per type, since a batch shares a partition key. */
async function bulkUpsertForType(type, boundaries) {
  const operations = boundaries.map(resourceBody => ({
    operationType: 'Upsert',
    partitionKey: String(type),
    resourceBody
  }));
  return cosmos.bulkVerified(CONTAINER, operations);
}

async function deleteById(id, type) {
  return cosmos.remove(CONTAINER, String(id), String(type));
}

module.exports = {
  CONTAINER,
  PARTITION_FIELD,
  SCOPE_FIELD,
  listByType,
  getById,
  getByName,
  countVisible,
  upsert,
  bulkUpsertForType,
  deleteById
};
