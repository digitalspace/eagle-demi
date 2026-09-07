'use strict';

/**
 * Comment periods repository — Cosmos NoSQL.
 *
 * Container `commentPeriods` (Eagle `CommentPeriod`), partitioned by `/projectId`. The only list is
 * "the periods of this project", so that is a single-partition query; the point read has no project
 * context and is cross-partition, but returns one item.
 */

const cosmos = require('../db/cosmos-nosql');
const { canRead } = require('../helpers/access-sql');
const { eq, inList, selectWhere, selectFor, countWhere, pageOptions, orderByFrom, pageSlice, upsertItem } = require('./_sql');

const CONTAINER = 'commentPeriods';
const PARTITION_FIELD = 'projectId';

/** Order keys the mirror writes on every row, so a single-property ORDER BY drops nothing. */
const SORTABLE = ['dateStarted', 'dateCompleted', 'dateAdded'];
const DEFAULT_ORDER = 'c.dateStarted DESC';

/** Point read. With the project it is single-partition; without, the predicate runs in the query. */
async function getById(access, id, projectId) {
  if (projectId) {
    const item = await cosmos.readItem(CONTAINER, String(id), String(projectId));
    if (!item) return null;
    return canRead(item, access, PARTITION_FIELD) ? item : null;
  }

  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [eq('id', String(id), '@id')]
  });
  const { items } = await cosmos.query(CONTAINER, spec, { maxItemCount: 1 });
  return items[0] || null;
}

function criteriaFor(projectId) {
  return [eq(PARTITION_FIELD, String(projectId), '@projectId')];
}

/**
 * The periods of one project, as this caller may see them.
 *
 * @param {string} projectId  the EAGLE project id, which is what the mirror stores
 */
async function listByProject(projectId, access, { pageNum, pageSize, sortBy } = {}) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: criteriaFor(projectId),
    select: selectFor(CONTAINER, access, PARTITION_FIELD),
    orderBy: orderByFrom(sortBy, SORTABLE, DEFAULT_ORDER)
  });

  const { skip, fetch } = pageSlice({ pageNum, pageSize });
  const { items } = await cosmos.query(CONTAINER, spec,
    pageOptions({ pageSize: fetch, partitionKey: String(projectId) }));
  return skip > 0 ? items.slice(skip) : items;
}

/**
 * The three fields a period is REFERRED to by, for a bounded set of period ids, in one query.
 *
 * Cross-partition — the ids arrive off `updates.pcp` and `notifications.pcp`, which carry no
 * project — but the set is one page of rows and only the reference is projected.
 */
async function listByIds(access, ids) {
  const unique = Array.from(new Set((ids || []).map(String)));
  if (unique.length === 0) return [];

  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [inList('id', unique, '@cpid')],
    select: 'c.id, c.isMet, c.metURL'
  });

  const { items } = await cosmos.query(CONTAINER, spec, {});
  return items;
}

/** The same predicate as the read, so the total cannot describe rows the page may not carry. */
async function countByProject(projectId, access) {
  const spec = countWhere({ access, partitionField: PARTITION_FIELD, criteria: criteriaFor(projectId) });
  const { items } = await cosmos.query(CONTAINER, spec, { partitionKey: String(projectId) });
  return items[0] || 0;
}

/** Whole-item write. A period that changed project moves partition — see `upsertItem`. */
async function upsert(item, existing) {
  return upsertItem(CONTAINER, PARTITION_FIELD, item, existing);
}

/** Removes a row left in a stale partition by a period that changed project. */
async function deleteById(id, projectId) {
  return cosmos.remove(CONTAINER, String(id), String(projectId));
}

module.exports = {
  CONTAINER,
  PARTITION_FIELD,
  SORTABLE,
  getById,
  listByProject,
  listByIds,
  countByProject,
  upsert,
  deleteById
};
