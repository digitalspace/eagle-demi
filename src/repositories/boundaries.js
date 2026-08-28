'use strict';

/**
 * Administrative boundaries — Cosmos NoSQL.
 *
 * Container `boundaries`, partitioned by `/type` (Regional District / Municipality /
 * Electoral District). Three partition values is normally an anti-pattern; it is correct here
 * because there are 281 items totalling a few MB, and the only list query filters on type.
 *
 * **Gated like every other repository.** This container used to be the one exception: no `read[]`
 * on the items, no `access` argument on any function, so a boundary could not be restricted even
 * in principle. That held only while the corpus was public reference geodata — the moment a
 * staff-only shapefile arrives it would have been world-readable on insert, silently.
 *
 * Two things make this different from the project-partitioned containers:
 *
 *  1. **No project axis.** Boundaries are geography, not project data, so `visibilityFor` is
 *     called with a NULL partition field — role ACL applies, project scope does not. Scoping them
 *     on a field the items do not carry would match nothing and blank the map for every
 *     project-scoped caller. See `scopeClause`.
 *  2. **Every row carries `read[]`.** `seed/transform.js` stamps reference geography `public`, so a
 *     boundary is governed by the ordinary role predicate like every other container. Rows seeded
 *     before the ACL existed carry neither field and are invisible until the boundaries seed stage
 *     is re-run over them.
 *
 * Items store SIMPLIFIED geometry only. Full-resolution GeoJSON is a build artifact already
 * emitted to frontend/public/assets/geojson/ and already preferred by the frontend; keeping
 * it here put the largest districts at ~1.6 MB against a 2 MB cap and made every write
 * enormously expensive to index.
 */

const cosmos = require('../db/cosmos-nosql');
const { selectWhere, countWhere, pageOptions, eq } = require('./_sql');
const { canRead } = require('../helpers/access-sql');

const CONTAINER = 'boundaries';
const PARTITION_FIELD = 'type';

/**
 * Boundaries have no project axis, so the visibility predicate is role-only. Passing `null` here
 * is load-bearing, not a placeholder — see the header.
 */
const SCOPE_FIELD = null;

/**
 * Boundaries by type. Single-partition when a type is given.
 *
 * @param {object}  access              from resolveAccess()
 * @param {string}  [opts.type]         omit for all types (cross-partition; 281 items)
 * @param {boolean} [opts.withGeometry] default true — the caller opts OUT. The frontend sends
 *                                      `geometry=simplified` for its default fidelity and nothing
 *                                      at all on the bbox path, so defaulting to false silently
 *                                      strips the polygons from both.
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

  // `pageSize` back OUT, because `pageOptions` is the only clamp and the caller has to compare
  // against the number that actually bounded the read. The controller used to clamp a second time
  // for that comparison, and the two disagreed: `?pageSize=abc` gave the controller NaN while this
  // bounded at 1000, so a genuinely truncated page compared false and reported nothing.
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

  const spec = selectWhere({
    access,
    partitionField: SCOPE_FIELD,
    criteria: [eq('id', String(id), '@id')]
  });
  const { items } = await cosmos.query(CONTAINER, spec, { maxItemCount: 1 });
  return items[0] || null;
}

/**
 * Look up a boundary by name.
 *
 * `type` is OPTIONAL. It is the partition key, so supplying it makes this a single-partition
 * query — but the frontend calls `/boundaries/<name>` with no type at all, and requiring it turned
 * `type` into the string "undefined", which matches nothing and 404s every time. With only 281
 * items across 3 partitions, the cross-partition fallback is cheap.
 */
async function getByName(access, name, type) {
  const scoped = type !== undefined && type !== null && String(type) !== '';

  const criteria = [];
  if (scoped) criteria.push(eq('type', String(type), '@type'));
  criteria.push(eq('name', String(name), '@name'));

  const spec = selectWhere({ access, partitionField: SCOPE_FIELD, criteria });

  const options = { maxItemCount: 1 };
  if (scoped) options.partitionKey = String(type);

  const { items } = await cosmos.query(CONTAINER, spec, options);
  return items[0] || null;
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
