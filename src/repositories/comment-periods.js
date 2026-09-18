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

/** `listOpen` when the caller named no limit. A rail, not a registry — see `listOpen`. */
const DEFAULT_OPEN_ROWS = 20;

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
  // Pages are drained, not sampled: one page of a cross-partition lookup can come back empty while
  // the row exists, and the caller reads that as "no such comment period".
  return await cosmos.queryFirst(CONTAINER, spec, {});
}

function criteriaFor(projectId) {
  return [eq(PARTITION_FIELD, String(projectId), '@projectId')];
}

/**
 * The periods of one parent, as this caller may see them.
 *
 * @param {string} projectId  the DEMI id of the parent the periods hang off. Usually a project,
 *   but `helpers/parent-admit.js` also admits a `ProjectNotification`, and the mirror partitions a
 *   period under whichever parent it picked — so `reconcile-eagle.js` walks both id spaces here.
 *   Always the parent's `id`, never its `eagleId`, so a caller scoped to a project passes the same
 *   value the projects container answers on.
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

/**
 * The periods that are open RIGHT NOW, across every project — the home page's engagement rail.
 *
 * THE ONE CROSS-PARTITION LIST in this container. Every other read here binds a parent and passes
 * `partitionKey`; this one cannot, because "open" is not a property of any single project. The
 * fan-out is the cost of that, so the read is capped rather than paged: a continuation token over
 * every partition is not a page anybody asks for twice.
 *
 * Measured on `demi-cosmos-test`, 2026-09-17: 3.27 RU and 29-49 ms warm for the open page, against
 * 2.89 RU for a single-partition read of the same container. The fan-out is nearly free because
 * this container is small — that is the assumption to re-check if it ever stops being one.
 *
 * `dateStarted <= now <= dateCompleted`, both bounds inclusive, against ONE `@now` so the window
 * cannot straddle two clock reads. `dateCompleted` is also the order — soonest to close first,
 * which is the order the rail renders and the reason a period is worth showing at all.
 *
 * @param {number} [opts.limit]  rows, clamped by `pageOptions` to MAX_PAGE_SIZE
 * @param {Date}   [opts.now]    shared clock read — pass the SAME value `countClosedSince` gets,
 *   so the two reads agree on "now" instead of each capturing its own a moment apart
 */
async function listOpen(access, { limit, now } = {}) {
  const nowIso = (now instanceof Date ? now : new Date()).toISOString();
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [{
      // ONE bound value, read twice: two `new Date()` calls could land either side of a boundary
      // and admit a period that is neither started nor unfinished at any single instant.
      clause: '(c.dateStarted <= @now AND c.dateCompleted >= @now)',
      params: [{ name: '@now', value: nowIso }]
    }],
    select: selectFor(CONTAINER, access, PARTITION_FIELD),
    orderBy: 'c.dateCompleted ASC'
  });

  // Only a positive integer counts as a caller-named limit — zero, negative or non-numeric all
  // fall back to the documented default BY RULE, not by `||` accidentally catching zero too.
  const pageSize = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_OPEN_ROWS;
  // No `partitionKey`, and NEVER an absent pageSize: `pageOptions` drops `maxItemCount` for an
  // undefined one, which puts `cosmos.query` on the fetchAll path and drains the container.
  const { items } = await cosmos.query(CONTAINER, spec, pageOptions({ pageSize }));
  return items;
}

/**
 * How many periods closed since `since` — the "and N closed recently" line beside the open rail.
 *
 * `dateCompleted < @now` is the exact complement of `listOpen`'s `>= @now` ONLY because both reads
 * are given the same `now` — see `openPeriods` in `controllers/search.js`, which captures it once
 * and passes it to both. A period cannot be counted as both open and recently closed on the same
 * request. Cross-partition, like `listOpen`, and a COUNT rather than a page because nothing renders
 * these rows.
 *
 * @param {string|Date} since  the start of the window, inclusive
 * @param {Date}        now    the SAME clock read passed to `listOpen` for this request
 */
async function countClosedSince(access, since, now) {
  const spec = countWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [{
      clause: '(c.dateCompleted >= @since AND c.dateCompleted < @closedNow)',
      params: [
        { name: '@since', value: new Date(since).toISOString() },
        { name: '@closedNow', value: (now instanceof Date ? now : new Date()).toISOString() }
      ]
    }]
  });
  const { items } = await cosmos.query(CONTAINER, spec, {});
  return items[0] || 0;
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
 *
 * `isDeleted` rides along because that upstream ACL outlives the record: a deleted period's raw
 * copy still says `public`, and `deriveAcls` needs the flag to refuse to act on it.
 */
async function aclRowsForProject(access, projectId) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: criteriaFor(projectId),
    select: 'c.id, c.read, c.isDeleted, c.sources.eagle.read AS eagleRead'
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
  DEFAULT_OPEN_ROWS,
  getById,
  listByProject,
  listByIds,
  listOpen,
  countClosedSince,
  countByProject,
  aclRowsForProject,
  setAclForProject,
  upsert,
  deleteById
};
