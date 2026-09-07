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
const { eq, inList, selectWhere, selectFor, countWhere, pageOptions, orderByFrom, pageSlice, upsertItem } = require('./_sql');

const CONTAINER = 'lists';
const PARTITION_FIELD = 'kind';
/** Null is load-bearing, not a placeholder — see the header. */
const SCOPE_FIELD = null;

const KINDS = Object.freeze({ LIST: 'List', ORGANIZATION: 'Organization' });

/**
 * Order keys PER KIND. `type`, `item`, `legislation` and `listOrder` live on `List` rows only and
 * the Organization mirror writes none of them, so one shared allow-list would let
 * `?sortBy=listOrder` on Organizations emit an ORDER BY over a property those rows lack — which
 * drops every one of them (see `orderByFrom` in ./_sql). Every key here is an included path in the
 * `lists` container indexing policy (azure/modules/cosmos-nosql.bicep); an unindexed ORDER BY
 * cannot be served at all.
 */
const SORTABLE = Object.freeze({
  [KINDS.LIST]: ['name', 'type', 'listOrder'],
  [KINDS.ORGANIZATION]: ['name', 'companyType']
});
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

/**
 * Name and id for a bounded set of rows of one kind, in one query — the label a foreign row refers
 * to, like `notifications.proponent`, which stores an Organization id and renders as its name.
 */
async function listByIds(access, ids, kind) {
  const unique = Array.from(new Set((ids || []).map(String)));
  if (unique.length === 0) return [];

  const spec = selectWhere({
    access,
    partitionField: SCOPE_FIELD,
    criteria: [eq(PARTITION_FIELD, String(kind), '@kind'), inList('id', unique, '@lid')],
    select: 'c.id, c.name'
  });

  const { items } = await cosmos.query(CONTAINER, spec, { partitionKey: String(kind) });
  return items;
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
    orderBy: orderByFrom(opts.sortBy, SORTABLE[kind] || [], DEFAULT_ORDER)
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
  return upsertItem(CONTAINER, PARTITION_FIELD, item, existing);
}

module.exports = {
  CONTAINER,
  PARTITION_FIELD,
  SCOPE_FIELD,
  KINDS,
  FILTERS,
  SORTABLE,
  getById,
  listByIds,
  listByKind,
  countByKind,
  upsert
};
