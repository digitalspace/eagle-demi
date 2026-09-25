'use strict';

/**
 * Updates repository — Cosmos NoSQL.
 *
 * Container `updates` (Eagle `RecentActivity`), partitioned by `/id` (the Eagle `_id`). Rows are
 * small, read whole and written only by the Eagle mirror, so every access is a point read or a
 * point write.
 *
 * `notifiedAt` is the publish-notify claim: it is set by a CONDITIONAL patch, so two concurrent
 * pushes of the same newly published update produce one notification, not two.
 */

const cosmos = require('../db/cosmos-nosql');
const { canRead, credentialField, systemAccess, TIER } = require('../helpers/access-sql');
const { levelOf, ROLE_LEVELS } = require('../vis/level');
const projects = require('./projects');
const config = require('../config');
const { logger } = require('../utils/logger');
const {
  eq, inList, isDefinedAndNotNull, selectWhere, selectFor, countWhere, pageOptions, orderByFrom,
  pageSlice
} = require('./_sql');

const CONTAINER = 'updates';
const PARTITION_FIELD = 'id';
/**
 * The project axis a SCOPED caller is confined to. Holds the EAGLE project id — `doc.project` as
 * eagle-api pushed it — unlike `commentPeriods.projectId`, which holds the DEMI one. Callers
 * filtering this container must not translate the id first; the caller's own ACCESS scope, which is
 * in DEMI ids, is translated the other way by `inEagleIdSpace` below.
 */
const SCOPE_FIELD = 'projectId';

const SORTABLE = ['dateAdded', 'dateUpdated', 'publishDate'];
const DEFAULT_ORDER = 'c.dateAdded DESC';
/**
 * eagle-public's news search asks for `-score`, the relevance rank its Mongo text search produced.
 * A Cosmos read has no rank, and newest-first is the order the same page shows without a query.
 */
const SORT_ALIASES = { score: 'dateAdded' };

/**
 * The field a sort on `publishDate` runs on. An ORDER BY leaves out every row that lacks its field,
 * so until src/scripts/backfill-update-publish-date.js has filled the rows written before mirrorItem
 * filled it, `config.updatesPublishDateFallback` keeps such sorts on `dateAdded`.
 */
function publishOrderField() {
  return config.updatesPublishDateFallback ? 'dateAdded' : 'publishDate';
}

/**
 * The three states `pinned` can be stored in — the mirror writes `doc.pinned` straight through, so
 * an Eagle record that never set it lands here undefined. Cosmos drops a row from `c.pinned != true`
 * when the property is absent, so "not pinned" is spelled out rather than negated.
 */
const PINNED = { clause: '(IS_DEFINED(c.pinned) AND c.pinned = true)', params: [] };
const UNPINNED = {
  clause: '(NOT IS_DEFINED(c.pinned) OR IS_NULL(c.pinned) OR c.pinned = false)',
  params: []
};

/** eagle-api answers `?top=true` with at most this many rows in total — listTop's default. */
const TOP_ROWS = 4;

/** The one `status` a public caller may see, once its `publishDate` has passed. */
const PUBLISHED = 'published';

/**
 * Does the publish gate apply to this caller? Staff level and narrower see drafts and scheduled
 * rows; idir and public see `status === 'published' && publishDate <= now`. A row with no `status`
 * predates the field and is governed by `read[]` alone, as before.
 */
function isLiveGated(access) {
  return levelOf(access) > ROLE_LEVELS.staff;
}

/**
 * When a row went public, for display. mirrorItem stores `dateAdded` as `publishDate` when Eagle
 * sends none; `dateAdded` covers a row written before it did, until the backfill has run.
 */
function publishedAt(item) {
  return typeof item.publishDate === 'string' && item.publishDate ? item.publishDate : (item.dateAdded || null);
}

/**
 * The gate's predicate, with the status and the time as whatever references the caller binds.
 * On `publishDate` alone, so the range filter can use its index: a gated row without one stays
 * hidden, and mirrorItem never writes a row without one.
 */
function liveClause(statusRef, nowRef) {
  return '(NOT IS_DEFINED(c.status) OR IS_NULL(c.status) OR ' +
    `(c.status = ${statusRef} AND c.publishDate <= ${nowRef}))`;
}

/** The gate as a SQL criterion. */
function liveCriteria(access, now = new Date().toISOString()) {
  if (!isLiveGated(access)) return [];
  return [{
    clause: liveClause('@liveStatus', '@liveNow'),
    params: [{ name: '@liveStatus', value: PUBLISHED }, { name: '@liveNow', value: now }]
  }];
}

/** The same gate on a fetched row: a point read bypasses the query predicate. */
function isLive(item, access, now = new Date().toISOString()) {
  if (!isLiveGated(access) || item.status === undefined || item.status === null) return true;
  return item.status === PUBLISHED && typeof item.publishDate === 'string' && item.publishDate <= now;
}

/** Nobody has claimed the notification yet. An absent field and an explicit null both count. */
const UNCLAIMED_CLAUSE = '(NOT IS_DEFINED(c.notifiedAt) OR IS_NULL(c.notifiedAt))';

/** Who took the claim. Only a 'demi' claim can have sent an email DEMI may later cancel. */
const NOTIFIED_BY = Object.freeze({ DEMI: 'demi', EAGLE: 'eagle', BACKFILL: 'backfill' });

/**
 * A claim unsent this long is taken to be a run that died mid-send, and a later tick may take it
 * over. Longer than any one run: a send waits at most two 10-second attempts.
 */
const NOTIFY_LEASE_MS = 30 * 60 * 1000;
/** Tries at a send that got no answer (5xx, timeout), in total. A refusal (4xx) is never retried. */
const NOTIFY_MAX_ATTEMPTS = 3;
/** How far back an announce reaches, scheduled or pushed. An update published longer ago is not news. */
const NOTIFY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The oldest instant still inside the notify window at `now`. */
function notifyWindowStart(now) {
  return new Date(Date.parse(now) - NOTIFY_WINDOW_MS).toISOString();
}

/**
 * Is the row recent enough to announce at `now`? Measured as listDueForNotify measures it: a
 * DEMI-claimed row from `notifyClaimedAt`, an unclaimed one from `publishDate`.
 */
function isInNotifyWindow(item, now) {
  const from = typeof item.notifyClaimedAt === 'string' ? item.notifyClaimedAt : item.publishDate;
  return typeof from === 'string' && from >= notifyWindowStart(now);
}

/** The DEMI send bookkeeping a whole-item write must carry across, like `notifiedAt`. */
const NOTIFY_STATE_FIELDS = [
  'notifyClaimedAt', 'notifySentAt', 'notifyFailedAt', 'notifyCancelledAt', 'notifyAttempts'
];

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** A patch condition takes no parameters, so an instant is interpolated — and checked first. */
function instantLiteral(value) {
  if (!ISO_INSTANT.test(String(value))) throw new TypeError(`[updates] not an ISO instant: ${value}`);
  return `"${value}"`;
}

/** A DEMI claim that ran out without a send, a refusal, or its last attempt. */
function staleLeaseClause(now) {
  const before = instantLiteral(new Date(Date.parse(now) - NOTIFY_LEASE_MS).toISOString());
  return `(IS_STRING(c.notifyClaimedAt) AND c.notifyClaimedAt < ${before} ` +
    'AND NOT IS_STRING(c.notifySentAt) AND NOT IS_STRING(c.notifyFailedAt) ' +
    `AND c.notifyAttempts < ${NOTIFY_MAX_ATTEMPTS})`;
}

/**
 * The row may be announced at `now`: published, through the public gate, inside the notify window,
 * and either unclaimed or holding a dead lease. Checked IN the claim, so a row archived or
 * rescheduled after the timer listed it fails the claim instead of being announced from a stale read.
 */
function announceableClause(now) {
  const at = instantLiteral(now);
  const since = instantLiteral(notifyWindowStart(now));
  return `c.isPublished = true AND ${liveClause(`"${PUBLISHED}"`, at)} ` +
    `AND ((${UNCLAIMED_CLAUSE} AND c.publishDate >= ${since}) ` +
    `OR (${staleLeaseClause(now)} AND c.notifyClaimedAt >= ${since}))`;
}

/** Every DEMI project id the caller's access binds into `SCOPE_FIELD` — scope, teams, credentials. */
function demiProjectIds(access) {
  if (!access) return [];
  const ids = [];
  if (access.tier === TIER.SCOPED && Array.isArray(access.projectScope)) ids.push(...access.projectScope);
  ids.push(...(access.teams || []));
  for (const cred of access.credentials || []) {
    if (credentialField(cred, SCOPE_FIELD) !== SCOPE_FIELD) continue;
    ids.push(...((cred.scope && cred.scope.ids) || []));
  }
  return Array.from(new Set(ids.map(String)));
}

/**
 * The same access, with every project axis rewritten into THIS container's id space.
 *
 * `projectScope`, `teams` and credential scopes all carry DEMI project ids, while `projectId` here
 * holds the EAGLE one — so binding them straight in matches nothing and a scoped credential reads
 * zero updates of its own project. Translated on read rather than stored as a second id on the row,
 * because a second id would need every mirrored update backfilled before it meant anything.
 *
 * ONE query, and only for a caller that carries such an id — an anonymous or privileged read is
 * untouched. Read under systemAccess(): this maps ids the credential was ISSUED with, so it must
 * not turn on whether the caller may read the project record itself. An id with no Eagle
 * counterpart drops out, which empties the scope rather than widening it.
 */
async function inEagleIdSpace(access) {
  const demiIds = demiProjectIds(access);
  if (demiIds.length === 0) return access;

  const rows = await projects.listByIds(systemAccess(), demiIds);
  const eagleById = new Map(rows.filter(p => p.eagleId).map(p => [String(p.id), String(p.eagleId)]));
  const translate = (ids) => (ids || []).map(id => eagleById.get(String(id))).filter(Boolean);

  const translated = { ...access };
  if (Array.isArray(access.projectScope)) translated.projectScope = translate(access.projectScope);
  if (Array.isArray(access.teams)) translated.teams = translate(access.teams);
  if (Array.isArray(access.credentials)) {
    translated.credentials = access.credentials.map(cred => (
      credentialField(cred, SCOPE_FIELD) === SCOPE_FIELD
        ? { ...cred, scope: { ...cred.scope, ids: translate((cred.scope || {}).ids) } }
        : cred));
  }
  return translated;
}

async function getById(access, id) {
  const item = await cosmos.readItem(CONTAINER, String(id), String(id));
  if (!item) return null;
  // The Cosmos partition is /id; the project axis a SCOPED caller is confined to is projectId.
  return canRead(item, await inEagleIdSpace(access), 'projectId') && isLive(item, access) ? item : null;
}

/** The stored row, unfiltered: a mirror write asks whether it exists, not who may read it. */
async function readForWrite(id) {
  return cosmos.readItem(CONTAINER, String(id), String(id));
}

/**
 * The keyword criterion: the text fields the `activities` index searches, less `notificationName`,
 * so a news search that matched there matches here. `true` is CONTAINS' case-insensitive
 * flag — without it a search for "site c" misses "Site C".
 */
function keywordCriteria(keywords) {
  const text = String(keywords || '').trim();
  if (!text) return [];
  return [{
    clause: '(CONTAINS(c.headline, @keywords, true) OR CONTAINS(c.content, @keywords, true) OR ' +
      'CONTAINS(c.shortHeadline, @keywords, true) OR CONTAINS(c.summary, @keywords, true))',
    params: [{ name: '@keywords', value: text }]
  }];
}

/**
 * `and[type]` as an IN over the stored `type`.
 *
 * No `types` key, and an emptied one (`and[type]=`), both add no clause — an empty `and[type]=` has
 * to read the same way here as it does on the index path, where `eagleQuery.buildFilter` drops a
 * key that produced zero terms instead of narrowing to none. A cleared filter-panel checkbox means
 * "show everything", not "show nothing".
 */
function typeCriteria(types) {
  if (!types || !types.length) return [];
  return [inList('type', types.map(String), '@type')];
}

/**
 * "Documents attached" — `and[documentUrl]`, which asks whether the field is FILLED rather than
 * what it holds.
 *
 * The mirror writes `documentUrl: null` when Eagle sent none and older rows carry `''`, so both
 * spellings of "no attachment" are named. The two clauses are exact complements by construction,
 * because the index path answers the same key with a complementary pair
 * (`eagle-query` PRESENCE_KEYS / `presenceTerm`) and one URL must not mean two different things
 * depending on whether keywords are on.
 */
const HAS_DOCUMENT = (() => {
  const filled = isDefinedAndNotNull('documentUrl');
  return { clause: `(${filled.clause} AND c.documentUrl != '')`, params: [] };
})();
const NO_DOCUMENT = { clause: `(NOT ${HAS_DOCUMENT.clause})`, params: [] };

function documentCriteria(hasDocument) {
  if (hasDocument === true) return [HAS_DOCUMENT];
  if (hasDocument === false) return [NO_DOCUMENT];
  return [];
}

/**
 * The posted-on window: `dateAddedFrom` inclusive, `dateAddedBefore` exclusive.
 *
 * Both arrive as ISO instants already rounded to whole UTC days by the caller
 * (`controllers/search.js` `activityWindow`), which is what makes `and[dateAddedEnd]` cover its own
 * day — the same arithmetic `eagle-query`'s `rangeTerm` does for the index path.
 *
 * A STRING compare, like `comment-periods.js` listOpen: `dateAdded` is stored as the ISO text
 * eagle-api pushed, Cosmos has no date type, and ISO-8601 in UTC sorts as text the way it sorts as
 * time — which is also why `DEFAULT_ORDER` can order by it. A row with no `dateAdded` at all
 * compares as undefined and drops out, which is the fail-closed direction for a dated window.
 */
function dateCriteria(dateAddedFrom, dateAddedBefore) {
  return [
    ...(dateAddedFrom ? [{
      clause: 'c.dateAdded >= @dateAddedFrom',
      params: [{ name: '@dateAddedFrom', value: dateAddedFrom }]
    }] : []),
    ...(dateAddedBefore ? [{
      clause: 'c.dateAdded < @dateAddedBefore',
      params: [{ name: '@dateAddedBefore', value: dateAddedBefore }]
    }] : [])
  ];
}

function criteriaFor(access, { projectId, keywords, types, hasDocument, dateAddedFrom, dateAddedBefore }) {
  return [
    ...liveCriteria(access),
    ...(projectId ? [eq(SCOPE_FIELD, String(projectId), '@projectId')] : []),
    ...typeCriteria(types),
    ...documentCriteria(hasDocument),
    ...dateCriteria(dateAddedFrom, dateAddedBefore),
    ...keywordCriteria(keywords)
  ];
}

/**
 * The updates this caller may see, newest first.
 *
 * @param {object}   [opts.projectId]        an EAGLE project id — see SCOPE_FIELD
 * @param {string[]} [opts.types]            `and[type]` values, ORed together — see typeCriteria
 * @param {boolean}  [opts.hasDocument]      `and[documentUrl]` — see documentCriteria
 * @param {string}   [opts.dateAddedFrom]    inclusive ISO lower bound — see dateCriteria
 * @param {string}   [opts.dateAddedBefore]  EXCLUSIVE ISO upper bound — see dateCriteria
 */
async function list(access, {
  projectId, keywords, types, hasDocument, dateAddedFrom, dateAddedBefore,
  pageNum, pageSize, sortBy
} = {}) {
  const spec = selectWhere({
    access: await inEagleIdSpace(access),
    partitionField: SCOPE_FIELD,
    criteria: criteriaFor(access, { projectId, keywords, types, hasDocument, dateAddedFrom, dateAddedBefore }),
    select: selectFor(CONTAINER, access, PARTITION_FIELD),
    orderBy: orderByFrom(sortBy, SORTABLE, DEFAULT_ORDER, { ...SORT_ALIASES, publishDate: publishOrderField() })
  });

  const { skip, fetch } = pageSlice({ pageNum, pageSize });
  const { items } = await cosmos.query(CONTAINER, spec, pageOptions({ pageSize: fetch }));
  return skip > 0 ? items.slice(skip) : items;
}

/**
 * A named set of updates, whole rows, in ONE query — how the keyword search reads back what the
 * index ranked. The index carries ids and no text, so the row a caller receives is always the
 * stored one, under the caller's own ACL: a row the index still holds and Cosmos no longer admits
 * simply drops out, which is the fail-closed direction.
 *
 * Cosmos answers in its own order; the caller re-imposes the ranking it asked for.
 */
async function listByIds(access, ids) {
  const unique = Array.from(new Set((ids || []).map(String)));
  if (unique.length === 0) return [];

  const spec = selectWhere({
    access: await inEagleIdSpace(access),
    partitionField: SCOPE_FIELD,
    criteria: [inList(PARTITION_FIELD, unique, '@uid'), ...liveCriteria(access)],
    select: selectFor(CONTAINER, access, PARTITION_FIELD)
  });

  const { items } = await cosmos.query(CONTAINER, spec, pageOptions({ pageSize: unique.length }));
  return items;
}

/** The same predicate as the read, so the total cannot describe rows the page may not carry. */
async function count(access, {
  projectId, keywords, types, hasDocument, dateAddedFrom, dateAddedBefore
} = {}) {
  const spec = countWhere({
    access: await inEagleIdSpace(access),
    partitionField: SCOPE_FIELD,
    criteria: criteriaFor(access, { projectId, keywords, types, hasDocument, dateAddedFrom, dateAddedBefore })
  });
  const { items } = await cosmos.query(CONTAINER, spec, {});
  return items[0] || 0;
}

/**
 * The home-page strip: pinned updates newest first, topped up with unpinned ones to `limit`.
 *
 * `limit` ROWS IN TOTAL, not of each — what eagle-api's `/api/public/recentActivity?top=true` answers
 * at its fixed four (`api/controllers/recentActivity.js:75-81`). `types` narrows only the unpinned
 * top-up: a pinned row is an editor's choice and leads whatever its type.
 */
async function listTop(access, { limit = TOP_ROWS, types } = {}) {
  // Translated once for both halves of the strip, not per query.
  const scoped = await inEagleIdSpace(access);
  const live = liveCriteria(access);
  const [pinned, unpinned] = await Promise.all([[PINNED, ...live], [UNPINNED, ...typeCriteria(types), ...live]]
    .map(async (criteria) => {
      const spec = selectWhere({
        access: scoped,
        partitionField: SCOPE_FIELD,
        criteria,
        select: selectFor(CONTAINER, access, PARTITION_FIELD),
        orderBy: `c.${publishOrderField()} DESC`
      });
      const { items } = await cosmos.query(CONTAINER, spec, pageOptions({ pageSize: limit }));
      return items.slice(0, limit);
    }));

  return [...pinned, ...unpinned.slice(0, Math.max(0, limit - pinned.length))];
}

/** Pages one due-list query may read. A tick that stops here leaves the rest for the next one. */
const DUE_PAGE_CAP = 10;

/** Up to `limit` rows of `spec`, following continuations: one page may hold fewer than asked. */
async function readUpTo(spec, limit) {
  const rows = [];
  let continuationToken;
  for (let page = 0; page < DUE_PAGE_CAP && rows.length < limit; page++) {
    const result = await cosmos.query(CONTAINER, spec, pageOptions({ pageSize: limit - rows.length, continuationToken }));
    rows.push(...result.items);
    continuationToken = result.continuationToken;
    if (!continuationToken) break;
  }
  if (continuationToken && rows.length < limit) {
    logger.warn('[updates] due list stopped at the page cap', { pages: DUE_PAGE_CAP, rows: rows.length });
  }
  return rows.slice(0, limit);
}

/** One due-list query: each criterion a plain comparison, so Cosmos can serve it from the index. */
function dueSpec(criteria, orderBy) {
  const access = systemAccess();
  return selectWhere({
    access,
    partitionField: SCOPE_FIELD,
    criteria: criteria.map(([clause, name, value]) => ({
      clause, params: name ? [{ name, value }] : []
    })),
    select: selectFor(CONTAINER, access, PARTITION_FIELD),
    orderBy
  });
}

/**
 * The scheduled announce's work list, at most `limit` rows, retries first:
 *   1. withdrawn rows DEMI announced whose cancellation has not gone out;
 *   2. DEMI claims whose lease ran out without a send, a refusal, or its last attempt;
 *   3. unclaimed published rows whose `publishDate` has passed, oldest first.
 * A claimed row's window runs from `notifyClaimedAt`, an unclaimed one's from `publishDate`. A row
 * without `status` is listed only to retry a DEMI send: the push announces those, and one pushed
 * while eagle-notify was dark stays unannounced. System access: it runs from a timer.
 */
async function listDueForNotify(now, limit) {
  const since = notifyWindowStart(now);
  const staleBefore = new Date(Date.parse(now) - NOTIFY_LEASE_MS).toISOString();
  const byDemi = ['c.notifiedBy = @demi', '@demi', NOTIFIED_BY.DEMI];
  const claimedSince = ['c.notifyClaimedAt >= @since', '@since', since];

  const queries = [
    dueSpec([
      byDemi, ['c.isPublished = false'], claimedSince, ['NOT IS_STRING(c.notifyCancelledAt)']
    ], 'c.notifyClaimedAt ASC'),
    dueSpec([
      byDemi, ['c.isPublished = true'], claimedSince,
      ['c.notifyClaimedAt < @staleBefore', '@staleBefore', staleBefore],
      ['NOT IS_STRING(c.notifySentAt)'], ['NOT IS_STRING(c.notifyFailedAt)'],
      ['c.notifyAttempts < @maxAttempts', '@maxAttempts', NOTIFY_MAX_ATTEMPTS]
    ], 'c.notifyClaimedAt ASC'),
    dueSpec([
      ['c.isPublished = true'], ['c.status = @status', '@status', PUBLISHED],
      ['c.publishDate >= @since', '@since', since], ['c.publishDate <= @now', '@now', now],
      [UNCLAIMED_CLAUSE]
    ], 'c.publishDate ASC')
  ];

  const due = [];
  for (const spec of queries) {
    if (due.length >= limit) break;
    due.push(...await readUpTo(spec, limit - due.length));
  }
  return due;
}

/**
 * Whole-item write, guarded by what the caller read.
 *
 * A plain upsert would carry a `notifiedAt` read before a concurrent push claimed it, handing the
 * claim back and announcing the same publication twice. Create when the row is absent, etag-guarded
 * replace when it is not: either way a racing writer gets 409/412 instead of a silent overwrite.
 */
async function upsert(item, existing) {
  if (!existing) return cosmos.create(CONTAINER, item);
  return cosmos.replace(CONTAINER, item.id, item.id, item, existing._etag);
}

/** A conditional patch: the patched row, or null when the condition was false (412). */
async function patchIf(id, operations, condition) {
  try {
    return await cosmos.patch(CONTAINER, String(id), String(id), operations, condition);
  } catch (err) {
    if (err.code === 412 || err.statusCode === 412) return null;
    throw err;
  }
}

/**
 * Take the notification claim as a lease, or find it taken or the row no longer announceable.
 * The caller sends the row this returns, never the one it listed: that one may be stale.
 * @returns {Promise<object|null>} the patched row, or null.
 */
async function claimForNotify(id, now) {
  return patchIf(id, [
    { op: 'set', path: '/notifiedAt', value: now },
    { op: 'set', path: '/notifiedBy', value: NOTIFIED_BY.DEMI },
    { op: 'set', path: '/notifyClaimedAt', value: now },
    { op: 'incr', path: '/notifyAttempts', value: 1 }
  ], `FROM c WHERE ${announceableClause(now)}`);
}

/**
 * Spend the claim on a row a backfill carries, so an old publication is never announced. Live
 * rows only: a scheduled one stays unclaimed for the timer to announce once it is due.
 * @returns {Promise<object|null>} the patched row, or null.
 */
async function claimForBackfill(id, now) {
  return patchIf(id, [
    { op: 'set', path: '/notifiedAt', value: now },
    { op: 'set', path: '/notifiedBy', value: NOTIFIED_BY.BACKFILL }
  ], `FROM c WHERE c.isPublished = true AND ${liveClause(`"${PUBLISHED}"`, instantLiteral(now))} ` +
    `AND ${UNCLAIMED_CLAUSE}`);
}

const NOTIFY_MARKS = ['notifySentAt', 'notifyFailedAt', 'notifyCancelledAt'];

/** Record how a send ended. Nothing here gives the claim back: an update emails at most once. */
async function markNotify(id, mark, at) {
  if (!NOTIFY_MARKS.includes(mark)) throw new TypeError(`[updates] unknown notify mark: ${mark}`);
  return cosmos.patch(CONTAINER, String(id), String(id), [{ op: 'set', path: `/${mark}`, value: at }]);
}

const UNDATED_CLAUSE = 'NOT IS_STRING(c.publishDate)';

/** One page of rows without a `publishDate`, for src/scripts/backfill-update-publish-date.js. */
async function listUndated({ pageSize, continuationToken } = {}) {
  const spec = selectWhere({
    access: systemAccess(),
    partitionField: SCOPE_FIELD,
    criteria: [{ clause: UNDATED_CLAUSE, params: [] }],
    select: 'c.id, c.dateAdded'
  });
  return cosmos.query(CONTAINER, spec, pageOptions({ pageSize, continuationToken }));
}

/** Set `publishDate` on a row that still has none: a push that filled it first wins. */
async function fillPublishDate(id, value) {
  return patchIf(id, [{ op: 'set', path: '/publishDate', value }], `FROM c WHERE ${UNDATED_CLAUSE}`);
}

module.exports = {
  CONTAINER,
  PARTITION_FIELD,
  SCOPE_FIELD,
  SORTABLE,
  TOP_ROWS,
  PUBLISHED,
  NOTIFIED_BY,
  NOTIFY_MAX_ATTEMPTS,
  NOTIFY_STATE_FIELDS,
  isLiveGated,
  isLive,
  isInNotifyWindow,
  publishedAt,
  // Exported for the keyword-search path in controllers/search.js: the index holds EAGLE project
  // ids while a caller's scope is in DEMI ones, so the OData ACL has to be built from the same
  // translated access this container's own reads use.
  inEagleIdSpace,
  getById,
  readForWrite,
  list,
  listByIds,
  count,
  listTop,
  listDueForNotify,
  upsert,
  claimForNotify,
  claimForBackfill,
  markNotify,
  listUndated,
  fillPublishDate
};
