'use strict';

/**
 * Comment periods repository — Cosmos NoSQL.
 *
 * Container `commentPeriods` (Eagle `CommentPeriod`), partitioned by `/projectId`. "The periods of
 * this project" is a single-partition query; the open rail and the unscoped search list fan out
 * across partitions, as does the point read with no project context.
 */

const cosmos = require('../db/cosmos-nosql');
const { canRead } = require('../helpers/access-sql');
const {
  eq, inList, selectWhere, selectFor, countWhere, pageOptions, orderByFrom, pageSlice, upsertItem,
  assertFilterable, readForWriteIn
} = require('./_sql');
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

/** The stored row, unfiltered: a mirror write asks whether it exists, not who may read it. */
async function readForWrite(id, projectId) {
  return readForWriteIn(CONTAINER, id, projectId);
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

const PACIFIC_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Vancouver', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
});

/** Pacific wall-clock time of `at`, as if it were UTC, to the second. */
function pacificWallMs(at) {
  const p = Object.fromEntries(PACIFIC_PARTS.formatToParts(at).map(part => [part.type, part.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}

/** The instant 00:00 Pacific began on `now`'s Pacific date. */
function startOfPacificDay(now) {
  const wall = pacificWallMs(now);
  const midnightWall = wall - (wall % 86400000);
  // Offset read at 08:00Z that date: 00:00 PST or 01:00 PDT, both before a 02:00 DST switch.
  const probe = new Date(midnightWall + 8 * 3600000);
  return new Date(midnightWall - (pacificWallMs(probe) - probe.getTime()));
}

/**
 * eagle-public keeps a period whose `dateCompleted` is exactly Pacific midnight open to the end of
 * that day (`closesAt`). A one-second range, not equality, so any stored ISO spelling of that
 * instant matches, as the client's second-resolution check does.
 */
const CLOSING_DAY = '(c.dateCompleted >= @closingDayStart AND c.dateCompleted < @closingDayEnd)';

/**
 * `and[status]`, against ONE `@now`. `open` is `listOpen`'s clause; the other two are its complements,
 * and the date a clause does not compare must still be set, because eagle-public's `getStatusCode`
 * gives a period missing either date no status at all.
 */
const STATUS_CLAUSES = {
  open: `(c.dateStarted <= @now AND (c.dateCompleted >= @now OR ${CLOSING_DAY}))`,
  upcoming: '(c.dateStarted > @now AND IS_STRING(c.dateCompleted))',
  closed: `(c.dateCompleted < @now AND NOT ${CLOSING_DAY} AND IS_STRING(c.dateStarted))`
};

/** A status clause as a criterion, bound to one clock read; only the parameters it names. */
function statusCriterion(status, now) {
  const at = now instanceof Date ? now : new Date();
  const dayStart = startOfPacificDay(at);
  const clause = STATUS_CLAUSES[status];
  const params = [
    { name: '@now', value: at.toISOString() },
    { name: '@closingDayStart', value: dayStart.toISOString() },
    { name: '@closingDayEnd', value: new Date(dayStart.getTime() + 1000).toISOString() }
  ];
  return { clause, params: params.filter(p => clause.includes(p.name)) };
}

/**
 * A deleted period keeps its upstream `public` ACL (see `aclRowsForProject`), so the ACL alone would
 * still list it. `IS_BOOL` first: a missing flag must read as "not deleted", not as undefined.
 */
const NOT_DELETED = { clause: 'NOT (IS_BOOL(c.isDeleted) AND c.isDeleted = true)', params: [] };

/** The one WHERE every cross-partition read and count here builds on. */
function listCriteria(access, { status, keywords, keywordProjectIds, now } = {}) {
  const criteria = [NOT_DELETED];
  if (status) {
    if (!STATUS_CLAUSES[status]) throw new Error(`[commentPeriods] no list clause for status '${status}'`);
    criteria.push(statusCriterion(status, now));
  }
  if (keywords) {
    assertFilterable(CONTAINER, 'informationLabel', access);
    criteria.push({
      clause: '(CONTAINS(c.informationLabel, @keywords, true) OR ARRAY_CONTAINS(@keywordProjects, c.projectId))',
      params: [
        { name: '@keywords', value: String(keywords) },
        { name: '@keywordProjects', value: keywordProjectIds || [] }
      ]
    });
  }
  return criteria;
}

async function countMatching(access, criteria, options = {}) {
  const spec = countWhere({ access, partitionField: PARTITION_FIELD, criteria });
  const { items } = await cosmos.query(CONTAINER, spec, options);
  return items[0] || 0;
}

/**
 * The periods that are open RIGHT NOW, across every project — the home page's engagement rail.
 *
 * Cross-partition, because "open" is not a property of any single project, and capped rather than
 * paged: a continuation token over every partition is not a page anybody asks for twice.
 *
 * Measured on `demi-cosmos-test`, 2026-09-17: 3.27 RU and 29-49 ms warm for the open page, against
 * 2.89 RU for a single-partition read of the same container. The fan-out is nearly free because
 * this container is small — that is the assumption to re-check if it ever stops being one.
 *
 * `dateStarted <= now <= dateCompleted` (or closing today, see CLOSING_DAY), against ONE `@now` so
 * the window cannot straddle two clock reads. `dateCompleted` is also the order — soonest to close
 * first, which is the order the rail renders and the reason a period is worth showing at all.
 *
 * @param {number} [opts.limit]  rows, clamped by `pageOptions` to MAX_PAGE_SIZE
 * @param {Date}   [opts.now]    shared clock read — pass the SAME value `countClosedSince` gets,
 *   so the two reads agree on "now" instead of each capturing its own a moment apart
 */
async function listOpen(access, { limit, now } = {}) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: listCriteria(access, { status: 'open', now }),
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
 * The `closed` clause is the exact complement of `listOpen`'s `open` ONLY because both reads are
 * given the same `now` — see `openPeriods` in `controllers/search.js`, which captures it once and
 * passes it to both. A period cannot be counted as both open and recently closed on the same
 * request. Cross-partition, like `listOpen`, and a COUNT rather than a page because nothing renders
 * these rows.
 *
 * @param {string|Date} since  the start of the window, inclusive
 * @param {Date}        now    the SAME clock read passed to `listOpen` for this request
 */
async function countClosedSince(access, since, now) {
  return countMatching(access, [
    ...listCriteria(access, { status: 'closed', now }),
    { clause: 'c.dateCompleted >= @since', params: [{ name: '@since', value: new Date(since).toISOString() }] }
  ]);
}

/**
 * Every period this caller may see, across all projects, paged — the search page's list.
 *
 * `OFFSET @skip LIMIT @size` in the query, so any page of the whole filtered set is reachable; the
 * offset is still read and discarded server-side, which is cheap only while this container is small.
 *
 * @param {string}   [opts.status]             a `STATUSES` value; absent is every status
 * @param {string}   [opts.keywords]           matched on `informationLabel`, or via `keywordProjectIds`
 * @param {string[]} [opts.keywordProjectIds]  DEMI ids of the projects whose name matched
 * @param {Date}     [opts.now]                one clock read, shared with `countAll`
 */
async function listAll(access, { pageNum, pageSize, sortBy, ...filters } = {}) {
  const { skip, size } = pageSlice({ pageNum, pageSize });
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: listCriteria(access, filters),
    select: selectFor(CONTAINER, access, PARTITION_FIELD),
    orderBy: orderByFrom(sortBy, SORTABLE, DEFAULT_ORDER)
  });
  spec.query += ' OFFSET @skip LIMIT @size';
  spec.parameters.push({ name: '@skip', value: skip }, { name: '@size', value: size });

  return cosmos.queryPage(CONTAINER, spec, { size, skip });
}

async function countAll(access, filters) {
  return countMatching(access, listCriteria(access, filters));
}

/** The same predicate as the read, so the total cannot describe rows the page may not carry. */
async function countByProject(projectId, access) {
  return countMatching(access, criteriaFor(projectId), { partitionKey: String(projectId) });
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
  // Callers pass systemAccess on purpose: a sealed child is skipped, and a `read`-less one heals on
  // its own next push, which reads it unfiltered (`readForWrite`).
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
  STATUSES: Object.keys(STATUS_CLAUSES),
  startOfPacificDay,
  getById,
  readForWrite,
  listByProject,
  listByIds,
  listOpen,
  countClosedSince,
  listAll,
  countAll,
  countByProject,
  aclRowsForProject,
  setAclForProject,
  upsert,
  deleteById
};
