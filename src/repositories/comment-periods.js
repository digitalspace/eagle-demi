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
const { cascadeAcl } = require('../helpers/acl-cascade');

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
 * @param {string} projectId  the DEMI project id — `mirrorItem` stores the parent's `id`, not its
 *   `eagleId`, so both project-partitioned containers answer a scoped caller on the same value
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

/**
 * The ACL inputs of every period in one project.
 *
 * `sources.eagle.read` is the period's own upstream ACL. `read` cannot stand in for it: the mirror
 * has already narrowed that to the project (`constrainToProject`), so a period pushed under a
 * private project reads private whatever Eagle published it as.
 */
async function aclRowsForProject(access, projectId) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: criteriaFor(projectId),
    select: 'c.id, c.read, c.sources.eagle.read AS eagleRead'
  });
  const { items } = await cosmos.query(CONTAINER, spec, { partitionKey: String(projectId) });
  return items;
}

/**
 * Re-derive every period's ACL from its own and its project's — the project-publish transition.
 *
 * Both directions: the mirror can only apply `constrainToProject` at push time, so without this a
 * period pushed while its project was private stayed private after the project published, and one
 * pushed while it was public stayed public after a takedown.
 */
async function setAclForProject(access, projectId, read) {
  return cascadeAcl(CONTAINER, projectId, await aclRowsForProject(access, projectId), read);
}

module.exports = {
  CONTAINER,
  PARTITION_FIELD,
  SORTABLE,
  getById,
  listByProject,
  listByIds,
  countByProject,
  aclRowsForProject,
  setAclForProject,
  upsert,
  deleteById
};
