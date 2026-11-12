'use strict';

/**
 * Container `updates` (Eagle `RecentActivity`), partitioned by `/id` (the Eagle `_id`). `notifiedAt`
 * is set by a conditional patch, so two concurrent pushes of one publish send one notification.
 */

const cosmos = require('../db/cosmos-nosql');
const { canRead, credentialField, systemAccess, TIER } = require('../helpers/access-sql');
const { levelOf, ROLE_LEVELS } = require('../vis/level');
const projects = require('./projects');
const notifications = require('./notifications');
const { readParent } = require('../helpers/update-parent');
const { presenceClause } = require('../helpers/native-query');
const { dialAllows } = require('../helpers/dial');
const config = require('../config');
const { logger } = require('../utils/logger');
const {
  eq, inList, selectWhere, selectFor, countWhere, pageOptions, orderByFrom,
  readPage, fetchAll, readDemiRowByEagleId, listDemiSyncPending, RELEASABLE_PENDING
} = require('./_sql');

const CONTAINER = 'updates';
const PARTITION_FIELD = 'id';
/**
 * Holds the Eagle project id as eagle-api pushed it, not the DEMI one: never translate a filter id.
 * The caller's access scope, in DEMI ids, is translated the other way by `inEagleIdSpace`.
 */
const SCOPE_FIELD = 'projectId';

const SORTABLE = ['dateAdded', 'dateUpdated', 'publishDate', 'headline', 'type', 'pinned', 'status'];
const DEFAULT_ORDER = 'c.dateAdded DESC';
// eagle-public's news search asks for `-score`, a Mongo text rank; Cosmos has none, so newest first.
const SORT_ALIASES = { score: 'dateAdded' };

// ORDER BY leaves out rows lacking its field, so until backfill-update-publish-date.js fills
// `publishDate` on older rows, `config.updatesPublishDateFallback` keeps its sorts on `dateAdded`.
function publishOrderField() {
  return config.updatesPublishDateFallback ? 'dateAdded' : 'publishDate';
}

// A `publishDate` sort may run on `dateAdded`, so that field's dial gates the row too.
const orderDial = (access, publishSorted) => (publishSorted && config.updatesPublishDateFallback
  ? [{ clause: dialAllows('dateAdded', levelOf(access)), params: [] }] : []);

/**
 * Older rows hold `pinned` as Eagle sent it, or not at all, and Cosmos drops a row lacking the
 * property from `c.pinned != true`, so "not pinned" is spelled out rather than negated.
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
 * Staff level and narrower see drafts and scheduled rows; idir and public see only live ones.
 * A row with no `status` goes by `read[]` alone.
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
 * On `publishDate` alone, so the range filter can use its index. A gated row without one stays
 * hidden, and mirrorItem always writes one.
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
 * Checked inside the claim, so a row archived or rescheduled after the timer listed it fails the
 * claim instead of being announced from a stale read.
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
 * Access with every DEMI project id rewritten to the Eagle id `projectId` holds here. Read under
 * systemAccess(), as it maps ids the credential was issued with; an id with no Eagle match drops out.
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

/**
 * Eagle ids of parents this caller cannot read: an Update under one is hidden whatever its own
 * `read[]`, as eagle-api's `parentReadMatch` does. Per access object, so a page and its count share it.
 */
const hiddenParentsByAccess = new WeakMap();

function hiddenParentIds(access) {
  if (!access) return Promise.resolve([]);
  if (!hiddenParentsByAccess.has(access)) hiddenParentsByAccess.set(access, loadHiddenParents(access));
  return hiddenParentsByAccess.get(access);
}

/**
 * Parent rows cached per process, not each caller's hidden set, so no access field can be missed in
 * a cache key. A local write calls `forgetParents`; another instance's write shows within the TTL.
 */
const PARENT_ROWS_TTL_MS = 60 * 1000;
let parentRows = null;

function forgetParents() {
  parentRows = null;
}

function cachedParentRows(now = Date.now()) {
  if (parentRows && now - parentRows.at < PARENT_ROWS_TTL_MS) return parentRows.rows;
  const entry = { at: now, rows: fetchParentRows() };
  // A failed read is not cached: the next request tries again.
  entry.rows.catch(() => { if (parentRows === entry) parentRows = null; });
  parentRows = entry;
  return entry.rows;
}

async function fetchParentRows() {
  // Unfiltered: every parent must be seen to know which a caller may not read.
  const [projectResult, notificationResult] = await Promise.all([
    cosmos.query(projects.CONTAINER, {
      query: 'SELECT c.id, c.eagleId, c.read FROM c WHERE IS_DEFINED(c.eagleId) AND NOT IS_NULL(c.eagleId)',
      parameters: []
    }, {}),
    cosmos.query(notifications.CONTAINER, { query: 'SELECT c.id, c.read FROM c', parameters: [] }, {})
  ]);
  logger.debug('[updates] parent rows read', {
    projects: projectResult.items.length,
    notifications: notificationResult.items.length,
    requestCharge: (projectResult.requestCharge || 0) + (notificationResult.requestCharge || 0)
  });
  return { projectRows: projectResult.items, notificationRows: notificationResult.items };
}

async function loadHiddenParents(access) {
  const { projectRows, notificationRows } = await cachedParentRows();

  // `canRead` is the JS twin of the SQL predicate, applied under the caller's own, untranslated, access.
  const notificationIds = new Set(notificationRows.map(n => String(n.id)));
  const hidden = new Set(notificationRows
    .filter(n => !canRead(n, access, notifications.SCOPE_FIELD)).map(n => String(n.id)));
  // Hidden only when no row carrying the id is readable, as the label lookup answers. A notification
  // wins an id a Track project also carries (`parent-admit:pickParent`).
  const readable = new Set(projectRows.filter(p => canRead(p, access, projects.PARTITION_FIELD))
    .map(p => String(p.eagleId)));
  for (const p of projectRows) {
    const id = String(p.eagleId);
    if (!readable.has(id) && !notificationIds.has(id)) hidden.add(id);
  }
  if (hidden.size) logger.debug('[updates] parent gate', { hiddenParents: hidden.size });
  return [...hidden];
}

/** The SQL half of the parent gate. One parameter, whatever the count: no IN-list limit applies. */
async function parentCriteria(access) {
  const hidden = await hiddenParentIds(access);
  if (hidden.length === 0) return [];
  return [{
    clause: '(NOT IS_DEFINED(c.projectId) OR IS_NULL(c.projectId) OR NOT ARRAY_CONTAINS(@hiddenParents, c.projectId))',
    params: [{ name: '@hiddenParents', value: hidden }]
  }];
}

async function getById(access, id) {
  const item = await cosmos.readItem(CONTAINER, String(id), String(id));
  if (!item) return null;
  // The Cosmos partition is /id; the project axis a SCOPED caller is confined to is projectId.
  if (!canRead(item, await inEagleIdSpace(access), 'projectId') || !isLive(item, access)) return null;
  // One Update, so its own parent, not the list gate's scan. A parent DEMI does not hold hides nothing.
  const parent = item.projectId ? await readParent(item.projectId) : null;
  if (!parent) return item;
  const field = parent.kind === 'notification' ? notifications.SCOPE_FIELD : projects.PARTITION_FIELD;
  return canRead(parent.doc, access, field) ? item : null;
}

/** The stored row, unfiltered: a mirror write asks whether it exists, not who may read it. */
async function readForWrite(id) {
  return cosmos.readItem(CONTAINER, String(id), String(id));
}

/** The DEMI-created row sync-out sent under this Eagle id; `readForWrite` finds an Eagle row. */
const readForWriteByEagleId = (eagleId) => readDemiRowByEagleId(CONTAINER, eagleId);

/** The sync-out pending hook's list. */
const listSyncPending = () => listDemiSyncPending(CONTAINER);

/**
 * DEMI-created Updates owed a send that name `id` in any ref field: sync-out holds them until that
 * record is in Eagle. A row failed at its version waits for a new write or `--repair`.
 */
function listSyncPendingNaming(id) {
  const named = ['c.projectId = @id', 'c.pcp = @id', 'c.projectNotification = @id', 'c.featuredImage.document = @id',
    'ARRAY_CONTAINS(c.attachments, @id)', 'EXISTS(SELECT VALUE i FROM i IN c.images WHERE i.document = @id)'];
  return fetchAll(CONTAINER, {
    query: 'SELECT c.id, c.projectId, c.sourceSystem, c.eagleId, c.status FROM c ' +
      `WHERE ${RELEASABLE_PENDING} AND (${named.join(' OR ')})`,
    parameters: [{ name: '@id', value: String(id) }]
  });
}

/**
 * The `activities` index text fields less `notificationName`, so a news search matches the same
 * rows here. `true` makes CONTAINS case-insensitive.
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
 * No or empty `and[type]` adds no clause, as `eagleQuery.buildFilter` does on the index path: a
 * cleared filter checkbox means show everything.
 */
function typeCriteria(types) {
  if (!types || !types.length) return [];
  return [inList('type', types.map(String), '@type')];
}

/**
 * `and[documentUrl]` asks whether the field is filled. Its two answers are exact complements, as on
 * the index path (`presenceTerm`), so one URL means the same with keywords on or off.
 */
function documentCriteria(hasDocument) {
  return typeof hasDocument === 'boolean' ? [presenceClause('documentUrl', hasDocument)] : [];
}

/**
 * Whole UTC days from `activityWindow`, `dateAddedBefore` exclusive. A string compare: ISO UTC text
 * sorts as time, and a row with no `dateAdded` drops out, which fails closed.
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
async function list(access, { pageNum, pageSize, sortBy, ...filters } = {}) {
  const spec = listSpec(access, await inEagleIdSpace(access), filters, await parentCriteria(access),
    orderByFrom(sortBy, SORTABLE, DEFAULT_ORDER, { ...SORT_ALIASES, publishDate: publishOrderField() }));

  return readPage(CONTAINER, spec, { pageNum, pageSize });
}

// Synchronous over already-awaited parts: an extra async hop reorders `list` against `count`.
function listSpec(access, scoped, filters, parents, orderBy) {
  return selectWhere({
    access: scoped,
    partitionField: SCOPE_FIELD,
    criteria: [...criteriaFor(access, filters), ...parents],
    select: selectFor(CONTAINER, access, PARTITION_FIELD),
    orderBy
  });
}

/**
 * Every row `list` pages over, past its MAX_PAGE_SIZE cap — for the reconcile, never a request.
 * Unsorted: see `projects.listEagleOnlyIds` for why a cross-partition ORDER BY stops at one page.
 */
async function listEvery(access) {
  return fetchAll(CONTAINER,
    listSpec(access, await inEagleIdSpace(access), {}, await parentCriteria(access)));
}

/**
 * Stored rows for the ids the keyword index ranked, under the caller's ACL: an id Cosmos does not
 * admit drops out. Cosmos answers in its own order; the caller re-ranks.
 */
async function listByIds(access, ids) {
  const unique = Array.from(new Set((ids || []).map(String)));
  if (unique.length === 0) return [];

  const spec = selectWhere({
    access: await inEagleIdSpace(access),
    partitionField: SCOPE_FIELD,
    criteria: [inList(PARTITION_FIELD, unique, '@uid'), ...liveCriteria(access), ...await parentCriteria(access)],
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
    criteria: [
      ...criteriaFor(access, { projectId, keywords, types, hasDocument, dateAddedFrom, dateAddedBefore }),
      ...await parentCriteria(access)
    ]
  });
  const { items } = await cosmos.query(CONTAINER, spec, {});
  return items[0] || 0;
}

/**
 * Pinned rows topped up with unpinned ones to `limit` in total, as eagle-api's `?top=true` answers.
 * `types` narrows only the top-up: a pinned row leads whatever its type.
 */
async function listTop(access, { limit = TOP_ROWS, types } = {}) {
  // Translated once for both halves of the strip, not per query.
  const scoped = await inEagleIdSpace(access);
  // In the query, before the limit, so a hidden pinned row never leaves the strip short.
  const live = [...liveCriteria(access), ...await parentCriteria(access)];
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

// `GET /updates` (helpers/native-query.js) under the gates `list` applies: Eagle-id scope, publish
// and parent. `readAll` is the unpaged re-read of a keyword list (search/native-index.js).
async function nativeSpec(access, criteria, orderBy) {
  return selectWhere({
    access: await inEagleIdSpace(access),
    partitionField: SCOPE_FIELD,
    criteria: [...liveCriteria(access), ...criteria, ...orderDial(access, /^c\.publishDate /.test(orderBy || '')),
      ...await parentCriteria(access)],
    select: selectFor(CONTAINER, access, PARTITION_FIELD),
    orderBy: orderBy && orderBy.replace(/^c\.publishDate /, `c.${publishOrderField()} `)
  });
}

const nativeRepository = Object.freeze({
  async list(access, { criteria, orderBy, pageNum, pageSize }) {
    return readPage(CONTAINER, await nativeSpec(access, criteria, orderBy || DEFAULT_ORDER), { pageNum, pageSize });
  },
  async count(access, { criteria, parsed }) {
    const spec = countWhere({
      access: await inEagleIdSpace(access),
      partitionField: SCOPE_FIELD,
      criteria: [...liveCriteria(access), ...criteria, ...orderDial(access, parsed?.sort?.field === 'publishDate'),
        ...await parentCriteria(access)]
    });
    const { items } = await cosmos.query(CONTAINER, spec, {});
    return items[0] || 0;
  },
  // Unsorted unless asked: the caller re-imposes the index's ranking.
  async readAll(access, { criteria, orderBy }) {
    return fetchAll(CONTAINER, await nativeSpec(access, criteria, orderBy));
  },
  // Mirrored: the DEMI id is the Eagle `_id`, so one point read answers both.
  getById
});

/** Pages one due-list query may read. A tick that stops here leaves the rest for the next one. */
const DUE_PAGE_CAP = 10;

/**
 * Up to `limit` rows of `spec`, following continuations: one page may hold fewer than asked.
 * Not `readPage`: a due list stops at DUE_PAGE_CAP and leaves the rest for the next tick.
 */
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
 * Retries first: unsent DEMI cancellations, then dead DEMI leases, then due unclaimed rows oldest
 * first. A row without `status` is listed only to retry a DEMI send; the push announces those.
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
      [UNCLAIMED_CLAUSE], ['NOT IS_STRING(c.notifySkippedAt)']
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
 * Not a plain upsert: that could write back a `notifiedAt` read before a concurrent push claimed it
 * and announce twice. A racing writer gets 409 or 412 instead.
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
 * Take the notification claim as a lease; null when it is taken or the row is not announceable.
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

/**
 * Drops an unclaimed row with a non-public parent from the oldest-first due list, where it would
 * hold back newer rows. A push or a project cascade (`update-acl`) clears the mark.
 */
async function markNotifySkipped(id, at, reason) {
  return patchIf(id, [
    { op: 'set', path: '/notifySkippedAt', value: at },
    { op: 'set', path: '/notifySkipReason', value: reason }
  ], `FROM c WHERE ${UNCLAIMED_CLAUSE}`);
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

/**
 * Image and attachment refs of public, published updates showing one of `docIds`. A row with no
 * status goes by `active`, as eagle-api's `shownIds` does.
 */
async function listShowingDocuments(docIds) {
  if (!docIds.length) return [];
  const spec = selectWhere({
    access: systemAccess(),
    partitionField: SCOPE_FIELD,
    criteria: [{
      clause: '(c.status = @shownStatus OR ((NOT IS_DEFINED(c.status) OR IS_NULL(c.status)) AND c.active = true)) AND ' +
        "ARRAY_CONTAINS(c.read, 'public') AND " +
        '(ARRAY_CONTAINS(@shownIds, c.featuredImage.document) ' +
        'OR EXISTS(SELECT VALUE i FROM i IN c.images WHERE ARRAY_CONTAINS(@shownIds, i.document)) ' +
        'OR EXISTS(SELECT VALUE a FROM a IN c.attachments WHERE ARRAY_CONTAINS(@shownIds, a)))',
      params: [{ name: '@shownStatus', value: PUBLISHED }, { name: '@shownIds', value: docIds.map(String) }]
    }],
    select: 'c.id, c.featuredImage, c.images, c.attachments'
  });
  const { items } = await cosmos.query(CONTAINER, spec, {});
  return items;
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
  // The keyword index holds Eagle project ids, so controllers/search.js builds its OData ACL from this.
  inEagleIdSpace,
  hiddenParentIds,
  forgetParents,
  markNotifySkipped,
  getById,
  readForWrite,
  readForWriteByEagleId,
  listSyncPending,
  listSyncPendingNaming,
  list,
  listEvery,
  listByIds,
  count,
  listTop,
  nativeRepository,
  listDueForNotify,
  upsert,
  claimForNotify,
  claimForBackfill,
  markNotify,
  listUndated,
  listShowingDocuments,
  fillPublishDate
};
