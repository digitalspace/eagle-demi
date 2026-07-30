'use strict';

/**
 * Administrative boundaries — Cosmos NoSQL.
 *
 * Container `boundaries`, partitioned by `/type` (Regional District / Municipality /
 * Electoral District). Three partition values is normally an anti-pattern; it is correct here
 * because there are 244 items totalling a few MB, and the only list query filters on type.
 *
 * Reference geodata: public by nature, so no read ACL applies. The visibility predicate is
 * deliberately absent rather than forgotten — see listByType.
 *
 * Items store SIMPLIFIED geometry only. Full-resolution GeoJSON is a build artifact already
 * emitted to frontend/public/assets/geojson/ and already preferred by the frontend; keeping
 * it here put the largest districts at ~1.6 MB against a 2 MB cap and made every write
 * enormously expensive to index.
 */

const cosmos = require('../db/cosmos-nosql');

const CONTAINER = 'boundaries';
const PARTITION_FIELD = 'type';

/**
 * Boundaries by type. Single-partition when a type is given.
 *
 * No ACL predicate: this is public reference data with no `read[]`, and applying the standard
 * visibility clause would match nothing and blank the map. That is a deliberate exception, so
 * it is stated here rather than left to be inferred.
 *
 * @param {string}  [type]              omit for all types (cross-partition; 244 items)
 * @param {boolean} [withGeometry=true] false projects geometry out — much cheaper for the
 *                                      typeahead and name lists the frontend loads first
 */
async function listByType(type, { withGeometry = true } = {}) {
  const select = withGeometry ? '*' : 'c.id, c.type, c.name, c.code';

  const spec = type
    ? {
      query: `SELECT ${select} FROM c WHERE c.type = @type ORDER BY c.name ASC`,
      parameters: [{ name: '@type', value: String(type) }]
    }
    : {
      query: `SELECT ${select} FROM c ORDER BY c.name ASC`,
      parameters: []
    };

  const options = type ? { partitionKey: String(type) } : {};
  return cosmos.query(CONTAINER, spec, options);
}

async function getById(id, type) {
  if (type) return cosmos.readItem(CONTAINER, String(id), String(type));

  const { items } = await cosmos.query(CONTAINER, {
    query: 'SELECT * FROM c WHERE c.id = @id',
    parameters: [{ name: '@id', value: String(id) }]
  }, { maxItemCount: 1 });
  return items[0] || null;
}

async function getByName(name, type) {
  const { items } = await cosmos.query(CONTAINER, {
    query: 'SELECT * FROM c WHERE c.type = @type AND c.name = @name',
    parameters: [
      { name: '@type', value: String(type) },
      { name: '@name', value: String(name) }
    ]
  }, { partitionKey: String(type), maxItemCount: 1 });
  return items[0] || null;
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
  listByType,
  getById,
  getByName,
  upsert,
  bulkUpsertForType,
  deleteById
};
