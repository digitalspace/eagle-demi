'use strict';

/**
 * Lookups repository — Cosmos NoSQL.
 *
 * Container `lists`, partitioned by `/kind`: Eagle `List` rows and Eagle `Organization` rows in one
 * container, discriminated by `kind`. Two logical partitions is normally an anti-pattern; it is
 * correct here for the same reason as `boundaries` — a few thousand tiny rows whose only query is
 * "everything of this kind", so a container each would buy nothing.
 *
 * Neither kind is project data, so `visibilityFor` is called with a NULL partition field: role ACL
 * applies, project scope does not.
 */

const cosmos = require('../db/cosmos-nosql');
const { canRead } = require('../helpers/access-sql');
const { eq, selectWhere, selectFor, countWhere, pageOptions, orderByFrom, pageSlice } = require('./_sql');

const CONTAINER = 'lists';
const PARTITION_FIELD = 'kind';
/** Null is load-bearing, not a placeholder — see the header. */
const SCOPE_FIELD = null;

const KINDS = Object.freeze({ LIST: 'List', ORGANIZATION: 'Organization' });

const SORTABLE = ['name', 'type', 'listOrder'];
const DEFAULT_ORDER = 'c.name ASC';

/** Filter keys a caller may narrow a kind by, and the field each lands on. */
const FILTERS = Object.freeze({ type: 'type', companyType: 'companyType', legislation: 'legislation' });

async function getById(access, id, kind) {
  if (kind) {
    const item = await cosmos.readItem(CONTAINER, String(id), String(kind));
    if (!item) return null;
    return canRead(item, access, SCOPE_FIELD) ? item : null;
  }

  const spec = selectWhere({
    access,
    partitionField: SCOPE_FIELD,
    criteria: [eq('id', String(id), '@id')]
  });
  const { items } = await cosmos.query(CONTAINER, spec, { maxItemCount: 1 });
  return items[0] || null;
}

function criteriaFor(kind, opts) {
  const criteria = [eq(PARTITION_FIELD, String(kind), '@kind')];
  for (const [key, field] of Object.entries(FILTERS)) {
    // Presence, not truthiness: '' is a real stored value on every Organization that has no
    // companyType, and a falsy test would widen "the unclassified ones" to "all of them".
    if (opts[key] !== undefined && opts[key] !== null) {
      criteria.push(eq(field, String(opts[key]), `@${key}`));
    }
  }
  return criteria;
}

/**
 * Every row of one kind this caller may see.
 *
 * @param {string} kind  one of KINDS
 * @param {object} [opts]  filter keys from FILTERS, plus `pageNum` / `pageSize` / `sortBy`
 */
async function listByKind(kind, access, opts = {}) {
  const spec = selectWhere({
    access,
    partitionField: SCOPE_FIELD,
    criteria: criteriaFor(kind, opts),
    select: selectFor(CONTAINER, access, PARTITION_FIELD),
    orderBy: orderByFrom(opts.sortBy, SORTABLE, DEFAULT_ORDER)
  });

  const { skip, fetch } = pageSlice(opts);
  const { items } = await cosmos.query(CONTAINER, spec,
    pageOptions({ pageSize: fetch, partitionKey: String(kind) }));
  return skip > 0 ? items.slice(skip) : items;
}

async function countByKind(kind, access, opts = {}) {
  const spec = countWhere({ access, partitionField: SCOPE_FIELD, criteria: criteriaFor(kind, opts) });
  const { items } = await cosmos.query(CONTAINER, spec, { partitionKey: String(kind) });
  return items[0] || 0;
}

/**
 * Whole-item write. Takes `kind: 'List'` rows from the backfill as well as the `kind:
 * 'Organization'` rows the Eagle mirror pushes — `List` has no eagle-api write path.
 */
async function upsert(item, existing) {
  if (!existing) return cosmos.create(CONTAINER, item);
  return cosmos.replace(CONTAINER, item.id, item.kind, item, existing._etag);
}

module.exports = {
  CONTAINER,
  PARTITION_FIELD,
  SCOPE_FIELD,
  KINDS,
  FILTERS,
  SORTABLE,
  getById,
  listByKind,
  countByKind,
  upsert
};
