'use strict';

// Container `commentPeriods`, partitioned by `/projectId`: one project's periods read one partition;
// the open rail, the search list and a point read with no project fan out.

const cosmos = require('../db/cosmos-nosql');
const { canRead } = require('../helpers/access-sql');
const {
  eq, inList, selectWhere, selectFor, countWhere, pageOptions, orderByFrom, pageSlice, upsertItem,
  assertFilterable, readForWriteIn, oneRowOf, fetchAll, readPage, NOT_DELETED, withCriteria
} = require('./_sql');
const { cascadeAcl } = require('../helpers/acl-cascade');
const { cosmosKind, dialAllows } = require('../helpers/native-query');
const { levelOf } = require('../vis/level');
const projects = require('./projects');

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
  return readForWriteIn(CONTAINER, id, projectId, PARTITION_FIELD);
}

function criteriaFor(projectId) {
  return [eq(PARTITION_FIELD, String(projectId), '@projectId')];
}

/** Stored rows of one partition matching every criterion, unfiltered, like `readForWrite`. */
async function readForWriteWhere(projectId, criteria) {
  const all = [...criteriaFor(projectId), ...criteria];
  const { items } = await cosmos.query(CONTAINER, {
    query: `SELECT * FROM c WHERE ${all.map(c => c.clause).join(' AND ')}`,
    parameters: all.flatMap(c => c.params)
  }, { partitionKey: String(projectId) });
  return items;
}

/**
 * The one stored row whose `field` is `value`: in the partition first, then across partitions, so a
 * row a project move left under another parent is still found. Unfiltered, like `readForWrite`.
 */
async function readForWriteByField(field, value, projectId) {
  const criterion = eq(field, String(value), `@${field}`);
  if (projectId != null) {
    const [row] = await readForWriteWhere(projectId, [criterion]);
    if (row) return row;
  }
  const { items } = await cosmos.query(CONTAINER,
    { query: `SELECT * FROM c WHERE ${criterion.clause}`, parameters: criterion.params });
  return oneRowOf(CONTAINER, value, items, PARTITION_FIELD);
}

/** The row that names this Eagle period without being stored under its id: one DEMI owns (engage or demi). */
async function readForWriteByEagleId(eagleId, projectId) {
  return readForWriteByField('eagleId', eagleId, projectId);
}

/**
 * The ENGAGE row for this engagement URL that no Eagle period has claimed yet. A row already tied to
 * another Eagle id is left alone, so a second Eagle period on the same URL cannot overwrite its echo.
 */
async function readForWriteEngageByMetUrl(metURL, projectId) {
  if (!metURL) return null;
  const rows = await readForWriteWhere(projectId, [
    eq('sourceSystem', 'engage', '@sourceSystem'),
    eq('metURL', String(metURL), '@metURL')
  ]);
  return rows.find(row => !row.eagleId) || null;
}

/**
 * The periods of one parent as this caller may see them. `projectId` is the parent's DEMI `id`; a period may
 * hang off a `ProjectNotification` too (`helpers/parent-admit.js`), so reconcile walks both id spaces.
 */
async function listByProject(projectId, access, { pageNum, pageSize, sortBy } = {}) {
  const spec = byProjectSpec(projectId, access, orderByFrom(sortBy, SORTABLE, DEFAULT_ORDER));

  return readPage(CONTAINER, spec, { pageNum, pageSize, partitionKey: String(projectId) });
}

function byProjectSpec(projectId, access, orderBy) {
  return selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: criteriaFor(projectId),
    select: selectFor(CONTAINER, access, PARTITION_FIELD),
    orderBy
  });
}

/** Every period of one parent, past `listByProject`'s MAX_PAGE_SIZE cap — for the reconcile only. */
async function listEveryByProject(projectId, access) {
  return fetchAll(CONTAINER, byProjectSpec(projectId, access), { partitionKey: String(projectId) });
}

/**
 * Reference fields (dates included, to tell open from closed) of a bounded id set, in one query.
 * Cross-partition: the ids come off `updates.pcp` and `notifications.pcp`, which carry no project.
 */
async function listByIds(access, ids) {
  const unique = Array.from(new Set((ids || []).map(String)));
  if (unique.length === 0) return [];

  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [inList('id', unique, '@cpid')],
    select: 'c.id, c.isMet, c.metURL, c.dateStarted, c.dateCompleted'
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

// eagle-public keeps a period closing at exactly Pacific midnight open that whole day (`closesAt`). A
// one-second range, not equality, so any stored ISO spelling of that instant matches.
const CLOSING_DAY = '(c.dateCompleted >= @closingDayStart AND c.dateCompleted < @closingDayEnd)';

// `and[status]` against one `@now`; `upcoming` and `closed` complement `open`. The uncompared date must be
// set too: eagle-public's `getStatusCode` gives a period missing either date no status.
const STATUS_CLAUSES = {
  open: `(c.dateStarted <= @now AND (c.dateCompleted >= @now OR ${CLOSING_DAY}))`,
  upcoming: '(c.dateStarted > @now AND IS_STRING(c.dateCompleted))',
  closed: `(c.dateCompleted < @now AND NOT ${CLOSING_DAY} AND IS_STRING(c.dateStarted))`
};

/**
 * The project list's `pcp` statuses: `STATUS_CLAUSES` plus eagle-api's `pending`, starting within
 * 7 days. Kept apart so `/comment-periods?status=` and compat `/search` do not take `pending`.
 */
const PCP_CLAUSES = {
  ...STATUS_CLAUSES,
  pending: '(c.dateStarted > @now AND c.dateStarted <= @in7Days)'
};

const WEEK_MS = 7 * 86400000;

/** A clause of `clauses` as a criterion, bound to one clock read; only the parameters it names. */
function statusCriterion(status, now, clauses = STATUS_CLAUSES) {
  const at = now instanceof Date ? now : new Date();
  const dayStart = startOfPacificDay(at);
  const clause = clauses[status];
  const params = [
    { name: '@now', value: at.toISOString() },
    { name: '@closingDayStart', value: dayStart.toISOString() },
    { name: '@closingDayEnd', value: new Date(dayStart.getTime() + 1000).toISOString() },
    { name: '@in7Days', value: new Date(at.getTime() + WEEK_MS).toISOString() }
  ];
  return { clause, params: params.filter(p => clause.includes(p.name)) };
}

/** Shorter keywords match most project names, so they match period labels only. */
const NAME_MATCH_MIN_CHARS = 2;

/** Keyword text as every period list matches it: quotes dropped (CONTAINS has no phrases), spaces collapsed. */
function keywordsOf(text) {
  return String(text || '').replace(/"/g, '').replace(/\s+/g, ' ').trim();
}

/** DEMI ids of the projects this caller may see whose name contains `keywords`: the other arm of `keywordCriterion`. */
async function keywordProjectIds(access, keywords) {
  return keywords.length >= NAME_MATCH_MIN_CHARS ? projects.listIdsByName(access, keywords) : [];
}

/**
 * A case-blind substring of `informationLabel`, or a period of one of `projectIds`. Each arm skips a
 * row whose own dial hides that field, so a count cannot reveal the hidden value.
 */
function keywordCriterion(access, keywords, projectIds) {
  assertFilterable(CONTAINER, 'informationLabel', access);
  const level = levelOf(access);
  const label = `(${dialAllows('informationLabel', level)} AND CONTAINS(c.informationLabel, @keywords, true))`;
  const project = `(${dialAllows('projectId', level)} AND ARRAY_CONTAINS(@keywordProjects, c.projectId))`;
  return {
    clause: `(${label} OR ${project})`,
    params: [
      { name: '@keywords', value: String(keywords) },
      { name: '@keywordProjects', value: projectIds || [] }
    ]
  };
}

// A deleted period keeps its upstream `public` ACL (see `aclRowsForProject`), so `NOT_DELETED` is
// what leaves it out of every read below, not the ACL.

/** The one WHERE every cross-partition read and count here builds on. */
function listCriteria(access, { status, keywords, keywordProjectIds, now } = {}) {
  const criteria = [NOT_DELETED];
  if (status) {
    if (!STATUS_CLAUSES[status]) throw new Error(`[commentPeriods] no list clause for status '${status}'`);
    criteria.push(statusCriterion(status, now));
  }
  if (keywords) criteria.push(keywordCriterion(access, keywords, keywordProjectIds));
  return criteria;
}

async function countMatching(access, criteria, options = {}) {
  const spec = countWhere({ access, partitionField: PARTITION_FIELD, criteria });
  const { items } = await cosmos.query(CONTAINER, spec, options);
  return items[0] || 0;
}

/**
 * Open periods across every project, soonest to close first, capped not paged. Pass `countClosedSince` the
 * same `now` so the two agree; the fan-out stays cheap only while this container is small.
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
 * Periods closed since `since`. `closed` complements `listOpen`'s `open` only when both get the same `now`
 * (`openPeriods` in `controllers/search.js`), so no period counts as both.
 */
async function countClosedSince(access, since, now) {
  return countMatching(access, [
    ...listCriteria(access, { status: 'closed', now }),
    { clause: 'c.dateCompleted >= @since', params: [{ name: '@since', value: new Date(since).toISOString() }] }
  ]);
}

/**
 * Every period this caller may see, paged by `OFFSET` so any page is reachable; skipped rows are still read
 * server-side, cheap only while this container is small. Filters: `listCriteria`.
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

/** Any of `statuses` (keys of `clauses`), every clause bound to the same clock read. */
function anyStatusCriterion(statuses, now, clauses = STATUS_CLAUSES) {
  const parts = statuses.map(status => statusCriterion(status, now, clauses));
  const params = new Map();
  parts.forEach(part => part.params.forEach(p => params.set(p.name, p)));
  return { clause: `(${parts.map(part => part.clause).join(' OR ')})`, params: [...params.values()] };
}

/**
 * DEMI ids of the projects with a period in any of `statuses` (`PCP_STATUSES`) that this caller
 * may read: the project list's `pcp` filter. NO ORDER BY: cross-partition DISTINCT rejects it.
 */
async function projectIdsWithStatus(access, statuses, now = new Date()) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [NOT_DELETED, anyStatusCriterion(statuses, now, PCP_CLAUSES)],
    select: 'DISTINCT VALUE c.projectId'
  });
  return fetchAll(CONTAINER, spec);
}

const nativeBase = cosmosKind({
  container: CONTAINER, entity: CONTAINER, partitionField: PARTITION_FIELD, defaultOrder: DEFAULT_ORDER
});

/**
 * `GET /comment-periods`' repository, deleted periods left out. Generic filters cannot build `status`
 * (a clock comparison) or `q` (also the project name), so the caller passes validated values.
 */
function nativeRepository({ statuses = [], keywords = '', now = new Date() } = {}) {
  const fixed = [NOT_DELETED, ...(statuses.length ? [anyStatusCriterion(statuses, now)] : [])];
  // queryFirst drains the cross-partition iterator: a single fetched page can be empty while the row exists.
  const first = (access, field, value) => cosmos.queryFirst(CONTAINER, selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [...fixed, eq(field, String(value), '@byField')],
    select: selectFor(CONTAINER, access, PARTITION_FIELD)
  }), {});
  const { list, count } = withCriteria(nativeBase, fixed);
  // Keyed on the caller's access, so a lookup made under one caller is never reused for another.
  const lookups = new WeakMap();
  const keyed = read => async (access, opts) => {
    if (!lookups.has(access)) {
      lookups.set(access, keywordProjectIds(access, keywords).then(ids => keywordCriterion(access, keywords, ids)));
    }
    return read(access, { ...opts, criteria: [...(opts.criteria || []), await lookups.get(access)] });
  };
  return {
    list: keywords ? keyed(list) : list,
    count: keywords ? keyed(count) : count,
    getById: (access, id) => first(access, 'id', id),
    getByEagleId: (access, eagleId) => first(access, 'eagleId', eagleId)
  };
}

/** Whole-item write. A period that changed project moves partition — see `upsertItem`. */
async function upsert(item, existing) {
  return upsertItem(CONTAINER, PARTITION_FIELD, item, existing);
}

/** Removes a row: a stale-partition copy after a project move, or a staff delete with its `etag`. */
async function deleteById(id, projectId, etag) {
  return cosmos.remove(CONTAINER, String(id), String(projectId), { etag });
}

/** Tries before `nextCommentId` gives up: each lost round is another writer that just took a number. */
const NEXT_ID_TRIES = 3;

/**
 * Atomic next comment number, as eagle-api's `$inc` on `commentIdCount` (comment.js:380); null with no period.
 * A mirrored row may hold `null`, so the first number is a patch conditioned on there being none yet.
 */
async function nextCommentId(periodId, projectId) {
  let partition = projectId;
  if (partition == null) {
    const row = await readForWrite(periodId);
    if (!row) return null;
    partition = row[PARTITION_FIELD];
  }
  const steps = [
    [[{ op: 'incr', path: '/commentIdCount', value: 1 }], 'FROM c WHERE IS_NUMBER(c.commentIdCount)'],
    [[{ op: 'set', path: '/commentIdCount', value: 1 }], 'FROM c WHERE NOT IS_NUMBER(c.commentIdCount)']
  ];
  for (let tryNumber = 1; tryNumber <= NEXT_ID_TRIES; tryNumber++) {
    for (const [operations, condition] of steps) {
      try {
        const saved = await cosmos.patch(CONTAINER, String(periodId), String(partition), operations, condition);
        return saved ? saved.commentIdCount : null;
      } catch (err) {
        const code = err.code || err.statusCode;
        if (code === 404) return null;
        if (code !== 412) throw err;
      }
    }
  }
  throw new Error(`[commentPeriods] nextCommentId lost ${NEXT_ID_TRIES} rounds on ${periodId}`);
}

/**
 * ACL inputs per period of a project. The upstream ACL is `sources.<owner>.read`, never `read`, which the mirror
 * already narrowed to the project; `isDeleted` rides along because a deleted row's upstream copy still says public.
 */
async function aclRowsForProject(access, projectId) {
  // Callers pass systemAccess on purpose: a sealed child is skipped, and a `read`-less one heals on
  // its own next push, which reads it unfiltered (`readForWrite`).
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: criteriaFor(projectId),
    select: 'c.id, c.read, c.isDeleted, c.sourceSystem, c.sources.eagle.read AS eagleRead, '
      + 'c.sources.engage.read AS engageRead, c.sources.demi.read AS demiRead'
  });
  const { items } = await cosmos.query(CONTAINER, spec, { partitionKey: String(projectId) });
  const upstreamOf = { engage: 'engageRead', demi: 'demiRead' };
  return items.map(({ sourceSystem, engageRead, demiRead, eagleRead, ...row }) =>
    ({ ...row, eagleRead: { engageRead, demiRead, eagleRead }[upstreamOf[sourceSystem] || 'eagleRead'] }));
}

/**
 * Re-derive each period's ACL from its own and its project's on publish or takedown: the mirror applies
 * `constrainToProject` only at push time, so a period would keep its project's old state.
 */
async function setAclForProject(access, projectId, read) {
  return cascadeAcl(CONTAINER, projectId, await aclRowsForProject(access, projectId), read);
}

// ---- ENGAGE ingest (controllers/nosql/engage-comment-period.js) ----

/** The row ENGAGE already tied to this engagement, in this partition or, after a project move, another. */
async function readForWriteByEngagementId(engagementId, projectId) {
  return readForWriteByField('engagementId', engagementId, projectId);
}

/** The ENGAGE row whose sync-out deleted this Eagle period to recreate it under a new project, else null. */
async function readForWriteEngageByDroppedEagleId(eagleId) {
  const engage = eq('sourceSystem', 'engage', '@sourceSystem');
  const { items } = await cosmos.query(CONTAINER, {
    query: `SELECT * FROM c WHERE ${engage.clause} AND ARRAY_CONTAINS(c.syncOut.eagle.droppedIds, @eagleId)`,
    parameters: [...engage.params, { name: '@eagleId', value: String(eagleId) }]
  });
  return items[0] || null;
}

// ---- ENGAGE reconcile ----

/** Every ENGAGE-owned row, deleted ones too, across partitions and unfiltered — for reconcile-engage.js only. */
async function listEveryEngage() {
  const { clause, params } = eq('sourceSystem', 'engage', '@sourceSystem');
  return fetchAll(CONTAINER, { query: `SELECT * FROM c WHERE ${clause}`, parameters: params });
}

/**
 * Every row, deleted ones too, whose `syncVersion` the Eagle sync-out has not sent: never sent, failed,
 * or a create whose delivery died. Across partitions — for `src/sync-out/pending.js` only.
 */
async function listSyncPending() {
  return fetchAll(CONTAINER, {
    query: 'SELECT * FROM c WHERE c.syncVersion > 0 AND (NOT IS_NUMBER(c.syncOut.eagle.sentVersion) ' +
      'OR c.syncVersion > c.syncOut.eagle.sentVersion)'
  });
}

module.exports = {
  CONTAINER,
  PARTITION_FIELD,
  SORTABLE,
  DEFAULT_OPEN_ROWS,
  STATUSES: Object.keys(STATUS_CLAUSES),
  PCP_STATUSES: Object.keys(PCP_CLAUSES),
  startOfPacificDay,
  getById,
  readForWrite,
  readForWriteByEagleId,
  readForWriteEngageByMetUrl,
  readForWriteByEngagementId,
  readForWriteEngageByDroppedEagleId,
  listByProject,
  listEveryByProject,
  listByIds,
  listOpen,
  countClosedSince,
  listAll,
  countAll,
  countByProject,
  keywordsOf,
  keywordProjectIds,
  nativeRepository,
  projectIdsWithStatus,
  aclRowsForProject,
  setAclForProject,
  upsert,
  deleteById,
  nextCommentId,
  listEveryEngage,
  listSyncPending
};
