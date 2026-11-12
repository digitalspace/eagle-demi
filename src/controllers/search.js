'use strict';

// Searches go to Azure AI Search. A KEYWORDLESS project list is a read, not a search, and comes
// from the Cosmos NoSQL repositories — see wiki Search-Query-Construction#project-reads-split-between-cosmos-and-the-index.
const { resolveAccess, isPrivileged, pageSizeFor } = require('../helpers/access-sql');
// Which container owns an Eagle id, said once for the mirrors, the seed and this read path.
const { pickParent } = require('../helpers/parent-admit');
const { redactForAccess, redactAllForAccess } = require('../vis/redact');
const { levelOf } = require('../vis/level');
const { EAGLE_STAFF_FIELDS } = require('../merge/project');
const { dialsForIndex } = require('../vis/catalog/index-projects-renames');
const { logger } = require('../utils/logger');
const { filterFor, inClause } = require('../helpers/access-odata');
const aiSearch = require('../search/ai-search');
const eagleQuery = require('../search/eagle-query');
const { sortEntries } = require('../search/sort-entries');
const { updatesIndexAcl, andOData } = require('../search/native-index');
const { dialExclusion } = require('../search/project-dials');
const { documentsAcl } = require('../search/document-query');
const chunkQuery = require('../search/chunk-query');
const groupChunks = require('../search/group-chunks');
const { normalizeSubType } = require('../search/sub-type');
const documentsRepo = require('../repositories/documents');
const projectsRepo = require('../repositories/projects');
const { EAGLE_OBJECT_ID } = projectsRepo;
const chunksRepo = require('../repositories/chunks');
const commentPeriodsRepo = require('../repositories/comment-periods');
const commentsRepo = require('../repositories/comments');
const notificationsRepo = require('../repositories/notifications');
const listsRepo = require('../repositories/lists');
const updatesRepo = require('../repositories/updates');
const usersRepo = require('../repositories/users');
const groupsRepo = require('../repositories/groups');
const inspectionsRepo = require('../repositories/inspections');
const summarizer = require('../ai/summarize');
const { analyticsEvent } = require('../utils/audit');
const config = require('../config');

/**
 * The 502 body for a FAILED search. Never the upstream message: the route is anonymous and that
 * text can carry the endpoint, the index name and the caller's ACL filter.
 */
function searchUnavailable(req, err, message) {
  const field = aiSearch.missingPropertyFrom(err);
  return {
    error: message,
    code: field ? 'SEARCH_SCHEMA_DRIFT' : 'SEARCH_UPSTREAM',
    ...(field ? { field } : {}),
    ...(req && req.id ? { traceId: req.id } : {})
  };
}

/**
 * A stored GeoJSON point as the frontend wants it: `[lng, lat]`. Cosmos, the index and the frontend
 * all use that order, so nothing is swapped here.
 */
function geoPoint(centroid) {
  const coords = Array.isArray(centroid) ? centroid : centroid && centroid.coordinates;
  if (!Array.isArray(coords) || coords.length !== 2) return [-125.0, 54.0];
  const [lng, lat] = coords.map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return [-125.0, 54.0];
  return [lng, lat];
}

/**
 * Label rows under the CALLER's access, never systemAccess(): a label must not outlive the row's ACL.
 * An unreadable project still gets a stub label, since eagle-public's row template throws without one.
 */
async function labelWithProjectNames(access, docs) {
  const projectIds = docs.map(d => d.project).filter(Boolean);
  if (projectIds.length === 0) return;
  // Redacted before anything reads a field off it, like every other repository row on this route
  // (docs/rbac-architecture.md §2 item 9).
  const parents = redactAllForAccess('projects', await projectsRepo.listByIds(access, projectIds), access);
  const byId = new Map(parents.map(p => [String(p.id), p]));
  for (const doc of docs) {
    const parent = byId.get(String(doc.project));
    doc.projectName = (parent && parent.name) || 'Associated Project';
    // The DEMI project id, kept separately: `project._id` below is the EAGLE ObjectId and neither
    // is derived from the other. See wiki Search-Query-Construction#project-id-spaces.
    doc.projectId = String(doc.project);
    doc.project = eagleQuery.ref((parent && parent.eagleId) || doc.project, doc.projectName);
  }
}

/**
 * Rewrite `&project=`/`&and[project]=` from Eagle ObjectIds into DEMI project ids. Unresolved ids pass
 * through, see wiki Search-Query-Construction#unresolved-project-ids-pass-through-as-literals.
 * @returns {object} the query with every project id in DEMI's id space.
 */
async function resolveProjectFilter(access, query) {
  const requested = eagleQuery.projectIdsFrom(query);
  if (requested.length === 0) return query;

  const demiIds = [];
  for (const id of requested) {
    if (!EAGLE_OBJECT_ID.test(id)) {
      demiIds.push(id);
      continue;
    }
    // `pickParent` is the rule the mirrors partition by. A project's `eagleId` can be a
    // notification's id, and that project's partition holds none of the notification's rows.
    const [project, notification] = await Promise.all([
      projectsRepo.getByEagleId(access, id),
      notificationsRepo.getById(access, id)
    ]);
    const parent = pickParent(project, notification);
    // Neither row: keep the caller's own id. It may still name a real partition, and an id that
    // matches nothing is the right answer for one that names nothing.
    demiIds.push(parent ? parent.id : id);
  }

  return eagleQuery.withProjectIds(query, demiIds);
}

/**
 * Resolve the chunk filters a chunk carries no copy of against the `documents` index. See
 * wiki Search-Query-Construction#chunk-filters-answer-on-the-chunks-own-copy.
 * @returns {{scope: ?string, recovered: string[], capped: boolean}} `capped`: too many documents match.
 */
async function recoverChunkFilters(query, dropped, access) {
  if (!dropped.length) return { scope: null, recovered: [], capped: false };
  // THE DOCUMENTS INDEX'S OWN ACL, never the chunk query's: a document-scoped credential compares
  // `documentId` there and `id` here, and the chunk clause sent to this index is a 400.
  const acl = documentsAcl(access);

  // Ask the index which keys it can express by building a filter, not a hardcoded list that goes
  // stale. Rebuilt in the WIRE shape: `dropped` holds base names, the query holds `and[name]`.
  const narrowed = {};
  // The caller's project scope comes along, and it is what decides whether the rest fits under the
  // cap. `project` is never in `dropped` here, so nothing else would offer it.
  if (query.project !== undefined) narrowed.project = query.project;
  // Read through `andParams`, the generator `buildFilter` also reads with, so both wire shapes are
  // handled — see wiki Search-Query-Construction#query-parser-shapes.
  const wanted = new Set(dropped);
  for (const [key, value] of eagleQuery.andParams(query)) {
    if (wanted.has(key)) narrowed[`and[${key}]`] = value;
  }
  // The bare-key form, for the handful of filters that are not `and[...]` at all.
  for (const key of dropped) {
    if (query[key] !== undefined) narrowed[key] = query[key];
  }
  if (Object.keys(narrowed).length === 0) return { scope: null, recovered: [], capped: false };

  const { filter: docFilter, dropped: stillDropped } =
    eagleQuery.buildFilter(narrowed, 'Document', acl, access);
  const recovered = dropped.filter(key => !stillDropped.includes(key));
  if (!recovered.length || !docFilter) return { scope: null, recovered: [], capped: false };

  const { ids, total, withinCap } = await aiSearch.documentIdsMatching(docFilter);
  if (!withinCap) {
    logger.warn('[search] chunk filter matches too many documents to scope', {
      keys: recovered, documents: total, cap: aiSearch.DOCUMENT_SCOPE_CAP
    });
    return { scope: null, recovered: [], capped: true };
  }

  // No matching document means no matching chunk, and that is a MEASUREMENT. Expressed as a clause
  // that cannot match rather than an early return, so count and ACL stay on one code path.
  if (ids.length === 0) return { scope: "documentId eq ''", recovered, capped: false };

  return { scope: inClause('documentId', ids), recovered, capped: false };
}

/**
 * The facet WIRE KEYS this request sent that the live chunks index cannot answer. They go to
 * `buildFilter` as inexpressible, so the documents-index recovery can still answer them.
 */
async function liveChunkFacets(query, acl, projectIds) {
  const asked = new Set(eagleQuery.filterKeysIn(query));
  const facets = Object.keys(eagleQuery.DOCUMENT_FACETS).filter(key => asked.has(key));
  const live = await chunkQuery.liveFacetColumns(
    facets.map(key => eagleQuery.DOCUMENT_FACETS[key]), acl, projectIds);
  const unavailable = new Set(live.unavailable);
  return { ...live, unavailable: facets.filter(key => unavailable.has(eagleQuery.DOCUMENT_FACETS[key])) };
}

exports.resetStaleChunkScopeCache = chunkQuery.resetStaleChunkScopeCache;

/**
 * The OData scope for `?docIds=<pipe-separated Eagle ids>`, or null when the caller sent none.
 * A PRESENT-BUT-EMPTY value matches nothing, not everything: it names an empty set.
 */
function documentIdScope(raw) {
  if (raw === undefined || raw === null) return null;
  const ids = String(Array.isArray(raw) ? raw.join('|') : raw)
    .split('|').map(v => v.trim()).filter(Boolean);
  if (ids.length === 0) return "id eq ''";
  return inClause('id', ids);
}

/**
 * One filter value in EITHER wire shape, `&key=v` or `&and[key]=v`. A repeat takes the first:
 * these are point lookups.
 */
function filterValue(query, key) {
  for (const [k, v] of eagleQuery.andParams(query || {})) {
    if (k === key) return String(firstValue(v));
  }
  const bare = (query || {})[key];
  if (bare === undefined) return null;
  return String(firstValue(bare));
}

/**
 * EVERY value of one filter key, in either wire shape, split by `eagleQuery.valuesOf` as the INDEX
 * path does. `null` = key not sent; `[]` = sent but empty (`and[type]=`).
 */
function filterValues(query, key) {
  const raw = [];
  for (const [k, v] of eagleQuery.andParams(query || {})) {
    if (k === key) raw.push(v);
  }
  if ((query || {})[key] !== undefined) raw.push(query[key]);
  return raw.length ? eagleQuery.valuesOf(raw) : null;
}

/**
 * One value from a query parameter `querystring.parse` may have handed back as an ARRAY — a
 * repeated key stays an array there, and a string method called on it throws.
 */
function firstValue(raw) {
  return Array.isArray(raw) ? raw[0] : raw;
}

/** One day, in ms — the step from a date's midnight to the next one. */
const DAY_MS = 86400000;

/** Midnight UTC of the day a wire date names, or null when no `Date` can read it. */
function utcDayStart(value) {
  const d = new Date(String(value));
  if (isNaN(d.getTime())) return null;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * `and[dateAddedStart]`/`and[dateAddedEnd]` as the INDEX path's half-open window of whole UTC days.
 * An unreadable date is left out of `applied`, so it is reported dropped rather than ignored.
 * @returns {{dateAddedFrom?: string, dateAddedBefore?: string, applied: string[]}}
 */
function activityWindow(query) {
  const bounds = { applied: [] };
  for (const key of ['dateAddedStart', 'dateAddedEnd']) {
    const raw = filterValue(query, key);
    if (raw === null) continue;
    if (raw.trim() === '') { bounds.applied.push(key); continue; }
    const day = utcDayStart(raw);
    if (day === null) continue;
    bounds.applied.push(key);
    if (key === 'dateAddedStart') bounds.dateAddedFrom = new Date(day).toISOString();
    else bounds.dateAddedBefore = new Date(day + DAY_MS).toISOString();
  }
  return bounds;
}

/**
 * `and[documentUrl]` is a presence filter: only `true` and `false`, as on the index path. Any other
 * value is reported dropped, never matched as a URL.
 * @returns {{hasDocument?: boolean, applied: string[]}}
 */
function documentFilter(query) {
  const raw = filterValue(query, 'documentUrl');
  if (raw === null) return { applied: [] };
  // Sent with nothing after the `=` is a cleared checkbox: consumed, and no narrowing.
  if (raw.trim() === '') return { applied: ['documentUrl'] };
  if (raw !== 'true' && raw !== 'false') return { applied: [] };
  return { hasDocument: raw === 'true', applied: ['documentUrl'] };
}

/**
 * The eagle-search wire shape for a REDACTED Cosmos row. Spread on purpose: the catalog decides what
 * leaves, and a field list here would be a second policy. `_id` is the EAGLE id eagle-public keys on.
 */
function cosmosRows(entity, rows, access, schemaName, decorate) {
  return redactAllForAccess(entity, rows, access).map((row) => ({
    ...row,
    _id: String(row.eagleId || row.id),
    _schemaName: schemaName,
    ...(decorate ? decorate(row) : {})
  }));
}

const STAFF_LEVEL = 2;

/** eagle-api's staff project fields, copied off a REDACTED row only: level 3-4 never gets one. */
function staffProjectFields(redacted) {
  const out = {};
  for (const key of EAGLE_STAFF_FIELDS) {
    if (redacted && redacted[key] !== undefined) out[key] = redacted[key];
  }
  return out;
}

/**
 * The staff fields for an INDEX page, which does not carry them: the same ids read back from
 * Cosmos under the caller's access and redacted. No read at all below level 2.
 */
async function staffFieldsByProjectId(access, ids) {
  if (levelOf(access) > STAFF_LEVEL || ids.length === 0) return new Map();
  const rows = redactAllForAccess('projects', await projectsRepo.listRowsByIds(access, ids), access);
  return new Map(rows.map(row => [String(row.id), staffProjectFields(row)]));
}

/** `filter` less the projects whose own dial hides from this caller a column the read sorts, filters or searches on. */
async function withoutDialHidden(access, filter, fields, keywords, searchedColumns) {
  const hidden = await dialExclusion(access, fields, keywords ? searchedColumns : undefined);
  return hidden ? andOData(filter, hidden) : filter;
}

/**
 * One `projects` INDEX hit, redacted for this caller. The dials arrive as a JSON string; a malformed
 * one fails closed to no dials, every field at its `defaultVis`.
 */
function redactIndexProject(hit, access) {
  let dials;
  try {
    dials = JSON.parse(hit.vis || '{}');
  } catch {
    dials = {};
  }
  return redactForAccess('index-projects', { ...hit, vis: dialsForIndex(dials) }, access);
}

/** The stored `activeWork` object, rebuilt from the four flat columns the index keeps it in. */
function indexActiveWork(doc) {
  const columns = [doc.activeWorkId, doc.activeWorkAct, doc.activeWorkType, doc.activeWorkPhase];
  // Not keyed on the id alone: the index nulls a non-numeric id that Cosmos still holds.
  if (columns.every(value => value == null)) return null;
  return {
    trackWorkId: doc.activeWorkId ?? null,
    eaAct: doc.activeWorkAct ?? null,
    workType: doc.activeWorkType ?? null,
    currentPhase: doc.activeWorkPhase ?? null
  };
}

/**
 * The wire `sector`, falling back to Track's sub-type when the STORED row has none. Asked of the
 * stored row, not the redacted one, or a sector a dial withholds would come back as the sub-type.
 */
function wireSector(stored, shown, legislationYear) {
  const text = v => (typeof v === 'string' ? v.trim() : '');
  if (text(stored.sector)) return text(shown.sector) || 'Other';
  return normalizeSubType(shown.projectSubType, legislationYear) || 'Other';
}

// `listByIdsUnscoped` is cross-partition, so its caller keeps each read to this many ids.
const UPDATE_DOCUMENT_BATCH = 200;

/** The documents Update rows reference. No project ids to narrow by: an update may attach any. */
async function updateDocuments(access, ids) {
  const rows = [];
  for (let i = 0; i < ids.length; i += UPDATE_DOCUMENT_BATCH) {
    rows.push(...await documentsRepo.listByIdsUnscoped(
      access, ids.slice(i, i + UPDATE_DOCUMENT_BATCH), 'c.id, c.projectId, c.displayName, c.documentFileName, c.vis'
    ));
  }
  return rows;
}

/** An Update image as the News model reads it, its `document` already resolved for this caller. */
function imageOut(entry, document) {
  return { document, alt: entry.alt || '', caption: entry.caption || null, credit: entry.credit || null };
}

/**
 * Resolve update rows' projects and documents under the CALLER's access, one query per kind for the
 * page. `updates.projectId` holds the EAGLE id. Unreadable: project gives null, document drops out.
 */
async function updateProjects(access, rows) {
  const idsOf = (field) => Array.from(new Set(rows.map(r => r[field]).filter(Boolean).map(String)));
  const eagleIds = idsOf('projectId');
  const periodIds = idsOf('pcp');
  const notificationIds = idsOf('projectNotification');
  // Document ids are Eagle `_id`s on both sides: the document mirror keys its rows by them.
  const documentIds = Array.from(new Set(rows.flatMap(r => [
    ...(Array.isArray(r.attachments) ? r.attachments : []),
    ...(r.featuredImage && r.featuredImage.document ? [r.featuredImage.document] : []),
    ...(Array.isArray(r.images) ? r.images.map(image => image && image.document) : [])
  ]).filter(Boolean).map(String)));

  // Redacted before anything reads a field off them, like every other repository row on this route.
  const [projectRows, periodRefs, notificationRefs, documentRefs] = await Promise.all([
    eagleIds.length ? projectsRepo.listByEagleIds(access, eagleIds) : [],
    periodIds.length ? commentPeriodsRepo.listByIds(access, periodIds) : [],
    notificationIds.length ? notificationsRepo.listByIds(access, notificationIds) : [],
    updateDocuments(access, documentIds)
  ]).then(([p, cp, n, d]) => [
    redactAllForAccess('projects', p, access),
    redactAllForAccess('commentPeriods', cp, access),
    redactAllForAccess('notifications', n, access),
    redactAllForAccess('documents', d, access)
  ]);

  const byEagleId = new Map(projectRows.map(p => [String(p.eagleId), p]));
  const byPeriodId = new Map(periodRefs.map(p => [String(p.id), p]));
  const byNotificationId = new Map(notificationRefs.map(n => [String(n.id), n]));
  const byDocumentId = new Map(documentRefs.map(d => [String(d.id), d]));
  // `_id` beside `id`: eagle-public reads a document reference by `_id`, like every Eagle row.
  const documentRef = (id) => {
    const doc = byDocumentId.get(String(id));
    return doc
      ? { _id: String(doc.id), id: String(doc.id), displayName: doc.displayName || null,
        documentFileName: doc.documentFileName || null }
      : null;
  };

  return (row) => {
    const project = row.projectId ? byEagleId.get(String(row.projectId)) : null;
    const period = row.pcp ? byPeriodId.get(String(row.pcp)) : null;
    const notification = row.projectNotification
      ? byNotificationId.get(String(row.projectNotification))
      : null;

    // `pcp` and `projectNotification` are OBJECTS or absent, never the stored bare id: the News
    // template reads fields off them. Unresolved leaves `undefined`, which drops the key.
    const image = row.featuredImage && row.featuredImage.document
      ? documentRef(row.featuredImage.document)
      : null;
    return {
      // `location` on the wire, `address` at rest, as on the Project dataset.
      project: project
        ? { _id: String(project.eagleId), name: project.name, location: project.address || null }
        : null,
      ...(Array.isArray(row.attachments)
        ? { attachments: row.attachments.map(documentRef).filter(Boolean) }
        : {}),
      ...(row.featuredImage !== undefined ? { featuredImage: image ? imageOut(row.featuredImage, image) : null } : {}),
      // Order kept: it is the display order. A row from before the gallery answers no key.
      ...(Array.isArray(row.images)
        ? {
          images: row.images.flatMap((entry) => {
            const document = entry && entry.document ? documentRef(entry.document) : null;
            return document ? [imageOut(entry, document)] : [];
          })
        }
        : {}),
      // Dates as stored, ISO string or null, so a reader can tell an open period from a closed one.
      pcp: period
        ? {
          _id: String(period.id), isMet: period.isMet === true, metURL: period.metURL || '',
          dateStarted: period.dateStarted ?? null, dateCompleted: period.dateCompleted ?? null
        }
        : undefined,
      projectNotification: notification
        ? { _id: String(notification.id), name: notification.name }
        : undefined
    };
  };
}

/** Update rows as the RecentActivity dataset answers them. The parent gate is the repository's. */
async function updateResults(access, rows) {
  return cosmosRows('updates', rows, access, 'RecentActivity', await updateProjects(access, rows));
}

/** How far back "closed recently" reaches, for the count that rides along with the open rail. */
const CLOSED_WINDOW_DAYS = 30;

/**
 * Every period open at this moment, plus how many closed in the last CLOSED_WINDOW_DAYS. `count` is
 * the whole answer, not a page; `closedCount` is a separate number, not a total for these rows.
 */
async function openPeriods({ access, pageSize }) {
  // ONE capture for both reads: two `new Date()` calls could fall either side of a period's
  // boundary and break the complement the reads form.
  const now = new Date();
  const since = new Date(now.getTime() - CLOSED_WINDOW_DAYS * 86400000);
  const [rows, closedCount] = await Promise.all([
    commentPeriodsRepo.listOpen(access, { limit: pageSize, now }),
    commentPeriodsRepo.countClosedSince(access, since, now)
  ]);
  const searchResults = await periodRows(access, rows);
  return { searchResults, count: searchResults.length, closedCount, applied: ['status'] };
}

/**
 * A keyword parameter's first value (a repeated key arrives as an array), whitespace collapsed: the
 * string `/search/counts` caches on.
 */
const keywordText = (raw) => String(firstValue(raw) || '').replace(/\s+/g, ' ').trim();

/** eagle-api took quoted keywords; `keywordsOf` drops the quotes. */
const periodKeywords = (raw) => commentPeriodsRepo.keywordsOf(firstValue(raw));

/** Substring match on the label, or on the parent project's name resolved under the caller's access. */
async function periodListFilters(access, keywords, status) {
  return {
    status,
    keywords,
    keywordProjectIds: await commentPeriodsRepo.keywordProjectIds(access, keywords),
    now: new Date()
  };
}

/** Every period this caller may see, across all projects, paged and counted on one predicate. */
async function periodList({ access, keywords, status, pageNum, pageSize, sortBy }) {
  const filters = await periodListFilters(access, keywords, status);
  const [rows, count] = await Promise.all([
    commentPeriodsRepo.listAll(access, { ...filters, pageNum, pageSize, sortBy }),
    commentPeriodsRepo.countAll(access, filters)
  ]);
  logger.debug('[search] CommentPeriod list', {
    rows: rows.length, count, status: filters.status || null, keywordProjects: filters.keywordProjectIds.length
  });
  return {
    searchResults: await periodRows(access, rows),
    count,
    applied: status ? ['status'] : []
  };
}

/** The `sortBy` entries a period read did not order by: it takes the first allowed key only. */
function periodSortDropped(sortBy) {
  const names = sortEntries(sortBy).map(entry => entry.replace(/^[+-]/, ''));
  const used = names.find(name => commentPeriodsRepo.SORTABLE.includes(name));
  return names.filter(name => name !== used);
}

/** The most rows `top=true` and dataset=HomeFeed answer. A longer list is a page, not a strip. */
const TOP_MAX_ROWS = 20;

/**
 * `pageSize` on a strip read: absent is `updatesRepo.TOP_ROWS`, so every existing `top=true` caller
 * is unchanged. Anything but an integer from 1 to TOP_MAX_ROWS is REFUSED rather than clamped.
 */
function stripLimit(query) {
  const raw = firstValue(query.pageSize);
  if (raw === undefined) return { limit: updatesRepo.TOP_ROWS };
  const n = Number(raw);
  if (!/^\d+$/.test(String(raw)) || n < 1 || n > TOP_MAX_ROWS) {
    return { error: `pageSize must be an integer from 1 to ${TOP_MAX_ROWS} here, not '${raw}'` };
  }
  return { limit: n };
}

/** The update type the home feed carries beside decisions; comment periods have their own rail. */
const FEED_UPDATE_TYPE = 'News';

const byDateDesc = (a, b) => Date.parse(b.date) - Date.parse(a.date);

/** The update-only feed fields, empty on a decision row so every row keeps the one shape. */
const NO_UPDATE_FIELDS = Object.freeze({ shortHeadline: null, summary: null, category: null, publishDate: null });
const isoDate = (value) => (value ? new Date(value).toISOString() : null);

/**
 * The newest project decisions this caller may see, dated no later than today, as feed rows.
 * From the `projects` index; the native feed reads Cosmos instead (`projects.listDecisions`).
 */
async function projectDecisionRows(access, limit, now) {
  const acl = filterFor(access, 'id');
  if (acl.empty) return [];
  // Through the same builders as a `dataset=Project` URL, so the ACL and the field gates are theirs.
  const { filter, fields } = eagleQuery.buildFilter(
    { 'and[decisionDateEnd]': now.toISOString() }, 'Project', acl, access);
  const { orderby, fields: sorted } = eagleQuery.buildOrderBy('-decisionDate', 'Project', false, access);
  let scoped;
  try {
    scoped = await withoutDialHidden(access, filter, [...fields, ...sorted]);
  } catch (err) {
    // Only this half drops, so news and notification decisions still serve; any other failure is a 502.
    if (err.code !== projectsRepo.DIAL_HIDDEN_OVER_CAP) throw err;
    logger.error('[search] home feed served without project decisions', { error: err.message, stack: err.stack });
    return [];
  }
  const { items } = await aiSearch.searchProjects({
    filter: scoped, orderby, skip: 0, keywords: '', matchAll: true, top: limit
  });
  return items
    .map(hit => redactIndexProject(hit, access))
    .filter(doc => doc.decisionDate)
    .map(doc => {
      const projectId = doc.legacyEagleId || String(doc.id);
      return {
        kind: 'decision',
        id: projectId,
        projectId,
        projectName: doc.name || doc.displayName || null,
        date: isoDate(doc.decisionDate),
        headline: doc.eacDecision || null,
        ...NO_UPDATE_FIELDS,
        content: null,
        documentUrl: null
      };
    });
}

/** Notification decisions as feed rows. A notification names its project loosely, by label. */
async function notificationDecisionRows(access, limit, now) {
  const rows = await notificationsRepo.listDecisions(access, { limit, now });
  const dated = redactAllForAccess('notifications', rows, access).filter(n => n.decisionDate);
  // A mirrored row with a garbage date would make isoDate throw and 502 the whole home page.
  const valid = dated.filter(n => !Number.isNaN(new Date(n.decisionDate).getTime()));
  if (valid.length < dated.length) {
    logger.warn('[search] home feed dropped notification decisions with an unparseable decisionDate', {
      ids: dated.filter(n => !valid.includes(n)).map(n => String(n.id))
    });
  }
  return valid
    .map(n => ({
      kind: 'decision',
      id: String(n.id),
      projectId: n.associatedProjectId || null,
      projectName: n.associatedProjectName || n.name || null,
      date: isoDate(n.decisionDate),
      headline: n.decision || null,
      ...NO_UPDATE_FIELDS,
      content: null,
      documentUrl: null
    }));
}

/**
 * The home feed: pinned updates first, exactly as the `top=true` strip, then the newest News updates
 * and decisions merged by date to fill the rest. Every half reads under the caller's own access.
 */
async function homeFeed({ access, query }) {
  if (query.keywords || query.q) return { error: 'dataset=HomeFeed does not take keywords' };
  const { limit, error } = stripLimit(query);
  if (error) return { error };

  const now = new Date();
  const [top, projectDecisions, notificationDecisions] = await Promise.all([
    updatesRepo.listTop(access, { limit, types: [FEED_UPDATE_TYPE] }),
    projectDecisionRows(access, limit, now),
    notificationDecisionRows(access, limit, now)
  ]);

  const project = await updateProjects(access, top);
  const updates = cosmosRows('updates', top, access, 'RecentActivity', project).map(row => ({
    kind: 'update',
    id: row._id,
    projectId: row.project ? row.project._id : null,
    projectName: row.project ? row.project.name : null,
    // When it went public, which is what a reader means by an update's date.
    date: isoDate(updatesRepo.publishedAt(row)),
    headline: row.headline || null,
    shortHeadline: row.shortHeadline || null,
    summary: row.summary || null,
    category: row.category || null,
    publishDate: row.publishDate || null,
    content: row.content || null,
    documentUrl: row.documentUrl || null
  }));

  // `listTop` answers pinned rows first, newest `publishDate` first; those hold their place, and
  // only the rest compete on date with the decisions.
  const pinnedCount = top.filter(row => row.pinned === true).length;
  const rest = [...updates.slice(pinnedCount), ...projectDecisions, ...notificationDecisions]
    .sort(byDateDesc)
    .slice(0, limit - pinnedCount);
  const rows = [...updates.slice(0, pinnedCount), ...rest];
  return { searchResults: rows, count: rows.length, applied: [] };
}

/** `sortBy` keys a read fixed on `c.id` did not apply (a mirror field may be absent; see `orderByFrom`). */
function sortKeysDropped(sortBy) {
  return sortEntries(sortBy).map(entry => entry.replace(/^[+-]/, ''));
}

/** These mirrors have no text index: keywords are refused rather than answered with every row. */
function keywordsRefused(dataset, query) {
  return query.keywords || query.q ? { error: `dataset=${dataset} does not take keywords` } : null;
}

/**
 * The one DEMI project id a `project` filter names, from the translated query. Two are REFUSED: the
 * repositories read one partition, and taking the first would answer for a project nobody chose.
 */
function oneProject(filterQuery) {
  const ids = eagleQuery.projectIdsFrom(filterQuery);
  if (ids.length > 1) return { error: `and[project] takes one value, not ${ids.join(', ')}` };
  return { projectId: ids[0] || null };
}

/**
 * Eagle's `project` (its ObjectId) beside the stored DEMI `projectId`, looked up under the caller's
 * access. A project the caller cannot read gives `project: null`.
 */
async function eagleProjectOf(access, rows) {
  const demiIds = Array.from(new Set(rows.map(r => r.projectId).filter(Boolean).map(String)));
  const parents = demiIds.length
    ? redactAllForAccess('projects', await projectsRepo.listByIds(access, demiIds), access)
    : [];
  const byId = new Map(parents.map(p => [String(p.id), p.eagleId ? String(p.eagleId) : null]));
  return (row) => ({ project: byId.get(String(row.projectId)) || null });
}

/** The three `inspections` kinds as datasets: the stored kind and the parent filters each one reads. */
const INSPECTION_DATASETS = Object.freeze({
  Inspection: { kind: inspectionsRepo.KINDS.INSPECTION, filters: [] },
  InspectionElement: { kind: inspectionsRepo.KINDS.ELEMENT, filters: ['inspection'] },
  InspectionItem: { kind: inspectionsRepo.KINDS.ITEM, filters: ['inspection', 'element'] }
});

/** One `inspections` kind as a `/search` dataset. `and[inspection]` and `and[element]` are Eagle ids. */
async function inspectionRows(dataset, { access, query, filterQuery, pageNum, pageSize, sortBy }) {
  const refused = keywordsRefused(dataset, query);
  if (refused) return refused;
  const { kind, filters } = INSPECTION_DATASETS[dataset];
  const entity = inspectionsRepo.ENTITY[kind];
  const decorateFor = (rows) => (kind === inspectionsRepo.KINDS.INSPECTION ? eagleProjectOf(access, rows) : null);

  const id = filterValue(query, '_id');
  if (id) {
    const row = await inspectionsRepo.getById(access, kind, id);
    const rows = row ? [row] : [];
    return { searchResults: cosmosRows(entity, rows, access, dataset, await decorateFor(rows)), count: rows.length, applied: ['_id'] };
  }

  const scoped = oneProject(filterQuery);
  if (scoped.error) return scoped;
  const applied = scoped.projectId ? ['project'] : [];
  const criteria = { projectId: scoped.projectId };
  for (const key of filters) {
    const value = filterValue(query, key);
    if (value === null) continue;
    criteria[key === 'inspection' ? 'inspectionId' : 'elementId'] = value;
    applied.push(key);
  }

  const [rows, count] = await Promise.all([
    inspectionsRepo.listPage(access, kind, { ...criteria, pageNum, pageSize }),
    inspectionsRepo.countVisible(access, kind, criteria)
  ]);
  return {
    searchResults: cosmosRows(entity, rows, access, dataset, await decorateFor(rows)),
    count,
    applied,
    sortDropped: sortKeysDropped(sortBy)
  };
}

/**
 * The Cosmos-backed `/search` datasets, each answering `{searchResults, count}`. `applied` names the
 * keys consumed; every other key is reported dropped, so a filter that did nothing is visible.
 */
const COSMOS_DATASETS = {
  /** Every lookup row. eagle-public asks for all 250-odd in one page and resolves ids client-side. */
  List: (ctx) => listRows(ctx, listsRepo.KINDS.LIST),

  /** The proponent / certificate-holder picker: `companyType=` in either wire shape, `sortBy=+name`. */
  Organization: (ctx) => listRows(ctx, listsRepo.KINDS.ORGANIZATION),

  async CommentPeriod({ access, query, filterQuery, pageNum, pageSize, sortBy }) {
    const id = filterValue(query, '_id');
    if (id) {
      const row = await commentPeriodsRepo.getById(access, id);
      const searchResults = await periodRows(access, row ? [row] : []);
      return { searchResults, count: searchResults.length, applied: ['_id'] };
    }

    // `filterQuery`, NOT `query`: `commentPeriods.projectId` holds the DEMI id (or a notification's
    // id), so it needs the ids `resolveProjectFilter` translated.
    const [projectId] = eagleQuery.projectIdsFrom(filterQuery);

    const statuses = filterValues(query, 'status');
    // REFUSED, never answered. An unrecognised status falling through would hand back the whole
    // corpus under a 200, which reads exactly like "every period matches your filter".
    if (statuses !== null && statuses.length > 1) {
      return { error: `and[status] takes one value, not ${statuses.join(', ')}` };
    }
    const status = statuses === null ? null : (statuses[0] || '');
    if (status !== null && !commentPeriodsRepo.STATUSES.includes(status)) {
      return {
        error: `and[status] must be one of ${commentPeriodsRepo.STATUSES.join(', ')}, not '${status}'`
      };
    }
    const sortDropped = periodSortDropped(sortBy);

    // A project filter keeps the per-project read below and reports `status` as dropped.
    if (!projectId) {
      const capped = pageSizeFor(access, pageSize);
      if (capped.error) return { error: capped.error };
      const keywords = periodKeywords(query.keywords || query.q);
      // The home rail sends none of these; the search tab always sends `sortBy` and `pageNum`.
      const rail = query.sortBy === undefined && query.pageNum === undefined && !keywords;
      if (status === 'open' && rail) return openPeriods({ access, pageSize: capped.pageSize });
      return {
        ...await periodList({ access, keywords, status, pageNum, pageSize: capped.pageSize, sortBy }),
        sortDropped
      };
    }

    const [rows, count] = await Promise.all([
      commentPeriodsRepo.listByProject(projectId, access, { pageNum, pageSize, sortBy }),
      commentPeriodsRepo.countByProject(projectId, access)
    ]);
    return { searchResults: await periodRows(access, rows), count, applied: ['project'], sortDropped };
  },

  async Comment({ access, query, pageNum, pageSize, sortBy }) {
    const id = filterValue(query, '_id');
    if (id) {
      const row = await commentsRepo.getById(access, id);
      return { searchResults: commentRows(access, row ? [row] : []), count: row ? 1 : 0, applied: ['_id'] };
    }

    const periodId = filterValue(query, 'period');
    if (!periodId) {
      // REFUSED, not answered empty: `comments` is partitioned by period and every caller has one.
      // An empty 200 here would read as "this period has no comments".
      return { error: 'dataset=Comment requires and[period]=<id> or _id' };
    }

    // Eagle's moderation filter. An unknown state is REFUSED: dropping it would answer every comment.
    const eaoStatuses = filterValues(query, 'eaoStatus');
    const unknownStatus = (eaoStatuses || []).filter(v => !commentsRepo.EAO_STATUSES.includes(v));
    if (unknownStatus.length) {
      return { error: `and[eaoStatus] must be one of ${commentsRepo.EAO_STATUSES.join(', ')}, not ${unknownStatus.join(', ')}` };
    }

    const [rows, count] = await Promise.all([
      commentsRepo.listByPeriod(periodId, access, { pageNum, pageSize, sortBy, eaoStatuses }),
      // The total for the WHOLE period under the same filter, which eagle-public pages against.
      commentsRepo.countByPeriod(periodId, access, { eaoStatuses })
    ]);
    return {
      searchResults: commentRows(access, rows),
      count,
      applied: ['period', ...(eaoStatuses !== null ? ['eaoStatus'] : [])]
    };
  },

  async RecentActivity({ access, query, pageNum, pageSize, sortBy }) {
    // A POINT READ on the `/id` partition: eagle-public's `/updates/:id` route, opened cold.
    const id = filterValue(query, '_id');
    if (id) {
      const row = await updatesRepo.getById(access, id);
      const searchResults = await updateResults(access, row ? [row] : []);
      return { searchResults, count: searchResults.length, applied: ['_id'] };
    }

    if (String(query.top) === 'true') {
      const { limit, error } = stripLimit(query);
      if (error) return { error };
      const searchResults = await updateResults(access, await updatesRepo.listTop(access, { limit }));
      // The count IS the answer here, not a page of a larger set: `listTop` returns the whole strip.
      return { searchResults, count: searchResults.length, applied: ['top'] };
    }

    // `query`, NOT `filterQuery`: `updates.projectId` holds the EAGLE project id, so the translated
    // DEMI id would match nothing.
    const [projectId] = eagleQuery.projectIdsFrom(query);
    // Keywords reach here only when the index is off: the repository answers with an unranked
    // CONTAINS substring match.
    const keywords = query.keywords || query.q || '';
    const types = filterValues(query, 'type');
    // The same filters the `activities` index applies to a keyword search, so both pages narrow alike.
    const { hasDocument, applied: documentApplied } = documentFilter(query);
    const { dateAddedFrom, dateAddedBefore, applied: windowApplied } = activityWindow(query);

    const criteria = { projectId, keywords, types, hasDocument, dateAddedFrom, dateAddedBefore };
    const [rows, count] = await Promise.all([
      updatesRepo.list(access, { ...criteria, pageNum, pageSize, sortBy }),
      // The SAME criteria as the page: a total built from a looser predicate describes rows the
      // page cannot hold, and eagle-public pages against it.
      updatesRepo.count(access, criteria)
    ]);
    return {
      searchResults: await updateResults(access, rows),
      count,
      // `!== null`, not truthy: `and[type]=` sent empty gives `[]`, a key SEEN with nothing to
      // narrow by, not one the container could not apply.
      applied: [
        ...(projectId ? ['project'] : []),
        ...(types !== null ? ['type'] : []),
        ...documentApplied,
        ...windowApplied
      ]
    };
  },

  /** Pinned updates, then News updates and decisions by date. See homeFeed. */
  HomeFeed: homeFeed,

  async ProjectNotification({ access, query, pageNum, pageSize, sortBy }) {
    const id = filterValue(query, '_id');
    if (id) {
      const row = await notificationsRepo.getById(access, id);
      return {
        searchResults: await notificationRows(access, row ? [row] : []),
        count: row ? 1 : 0,
        applied: ['_id']
      };
    }

    const applied = [];
    const filters = {};
    for (const key of Object.keys(notificationsRepo.FILTERS)) {
      const value = filterValue(query, key);
      if (value !== null) {
        filters[key] = value;
        applied.push(key);
      }
    }

    const [rows, count] = await Promise.all([
      notificationsRepo.list(access, { ...filters, pageNum, pageSize, sortBy }),
      notificationsRepo.count(access, filters)
    ]);
    return {
      searchResults: await notificationRows(access, rows),
      count,
      applied
    };
  },

  /** Eagle `User`. No project axis: a project filter answers nothing (`canScopeToProject`). */
  async User({ access, query, pageNum, pageSize, sortBy }) {
    const refused = keywordsRefused('User', query);
    if (refused) return refused;
    const id = filterValue(query, '_id');
    if (id) {
      const row = await usersRepo.getById(access, id);
      return { searchResults: cosmosRows('users', row ? [row] : [], access, 'User'), count: row ? 1 : 0, applied: ['_id'] };
    }
    const [rows, count] = await Promise.all([
      usersRepo.listPage(access, { pageNum, pageSize }),
      usersRepo.countVisible(access)
    ]);
    return { searchResults: cosmosRows('users', rows, access, 'User'), count, applied: [], sortDropped: sortKeysDropped(sortBy) };
  },

  /** Eagle `Group`, a project's contact group. `project` on the row is the Eagle id, as Eagle has it. */
  async Group({ access, query, filterQuery, pageNum, pageSize, sortBy }) {
    const refused = keywordsRefused('Group', query);
    if (refused) return refused;
    const id = filterValue(query, '_id');
    if (id) {
      const row = await groupsRepo.getById(access, id);
      const rows = row ? [row] : [];
      return { searchResults: cosmosRows('groups', rows, access, 'Group', await eagleProjectOf(access, rows)), count: rows.length, applied: ['_id'] };
    }
    const scoped = oneProject(filterQuery);
    if (scoped.error) return scoped;
    const { projectId } = scoped;
    const [rows, count] = await Promise.all([
      groupsRepo.listPage(access, { projectId, pageNum, pageSize }),
      groupsRepo.countVisible(access, { projectId })
    ]);
    return {
      searchResults: cosmosRows('groups', rows, access, 'Group', await eagleProjectOf(access, rows)),
      count,
      applied: projectId ? ['project'] : [],
      sortDropped: sortKeysDropped(sortBy)
    };
  },

  Inspection: (ctx) => inspectionRows('Inspection', ctx),
  InspectionElement: (ctx) => inspectionRows('InspectionElement', ctx),
  InspectionItem: (ctx) => inspectionRows('InspectionItem', ctx)
};
/** Test seam: the `_id` suite walks every dataset, so a new one cannot skip the point read. */
exports.COSMOS_DATASET_NAMES = Object.freeze(Object.keys(COSMOS_DATASETS));

/**
 * eagle-api's `dataset=Item&_id=&_schemaName=`: one record by id from any model it names. DEMI
 * answers the models whose dataset above takes `_id`, through that dataset's own point read.
 */
const ITEM_SCHEMAS = Object.freeze([
  'User', 'Group', 'Inspection', 'InspectionElement', 'InspectionItem',
  'Comment', 'CommentPeriod', 'ProjectNotification', 'RecentActivity'
]);

/**
 * The two Cosmos datasets whose KEYWORD search the index ranks. Rows are read back from Cosmos
 * through the keywordless mapper, so the wire shape cannot drift and a stale index hit drops out.
 */
const KEYWORD_INDEX_DATASETS = {
  RecentActivity: {
    index: () => aiSearch.config().activitiesIndex,
    search: (opts) => aiSearch.searchActivities(opts),
    // `?top=true` (the home strip, ordered by pinned-ness) and `and[_id]` (a point read) stay Cosmos
    // reads whatever else the caller sent.
    cosmosOnly: (query) => String(query.top) === 'true' || filterValue(query, '_id') !== null,
    // `updates.projectId` holds the EAGLE id, so filter on the UNTRANSLATED ids, flattened onto
    // `project`, the one form `buildFilter` applies.
    indexQuery: (query) => eagleQuery.withProjectIds(query, eagleQuery.projectIdsFrom(query)),
    acl: updatesIndexAcl,
    rows: async (access, ids) => {
      return updateResults(access, inIdOrder(await updatesRepo.listByIds(access, ids), ids));
    }
  },
  ProjectNotification: {
    index: () => aiSearch.config().notificationsIndex,
    search: (opts) => aiSearch.searchNotifications(opts),
    // `and[_id]` is a point read of one record, and the keywords say nothing about which one.
    cosmosOnly: (query) => filterValue(query, '_id') !== null,
    indexQuery: (query) => query,
    // NULL, like `notifications.SCOPE_FIELD`: a notification is not project data, so there is no
    // project axis to narrow on and role ACL is the whole filter.
    acl: async (access) => filterFor(access, null),
    rows: async (access, ids) => notificationRows(access,
      inIdOrder(await notificationsRepo.listByIds(access, ids, { full: true }), ids))
  }
};

/** Cosmos answers a named set in its own order; the ranking the index computed is the one to keep. */
function inIdOrder(rows, ids) {
  const byId = new Map(rows.map(row => [String(row.id), row]));
  return ids.map(id => byId.get(String(id))).filter(Boolean);
}

/**
 * The filter keys an INDEX page did not apply. Built from what was applied, since a bare key
 * (`period`, `docIds`) never reaches `buildFilter` to be refused.
 */
function unappliedFilterKeys(query, indexQuery, dropped) {
  const offered = [
    ...Array.from(eagleQuery.andParams(indexQuery), ([key]) => key),
    ...(indexQuery.project ? ['project'] : []),
    ...(indexQuery.categorized !== undefined ? ['categorized'] : [])
  ];
  const applied = new Set(offered.filter(key => !dropped.includes(key)));
  return eagleQuery.filterKeysIn(query).filter(key => !applied.has(key));
}

/**
 * Once per process per dataset: the frontend searches on every debounced keystroke, so a
 * per-request line would be noise.
 */
const keywordFallbackWarned = new Set();

/** Why the ranking the caller got is not the one they asked for. One line each, one latch each. */
const KEYWORD_FALLBACK_REASONS = {
  off: 'SEARCH_ENDPOINT or the index app setting for this dataset is empty',
  missing: 'the index its app setting names does not exist on the search service (HTTP 404)'
};

function warnKeywordFallback(dataset, reason = 'off') {
  const key = `${dataset}:${reason}`;
  if (keywordFallbackWarned.has(key)) return;
  keywordFallbackWarned.add(key);
  logger.warn(
    `[search] ${dataset}: keyword search is falling back to the Cosmos read — ` +
    `${KEYWORD_FALLBACK_REASONS[reason]}. This is a configuration state, NOT a search that found ` +
    'nothing.'
  );
}

/** Test seam, like resetStaleChunkScopeCache: the warn-once latch outlives one test otherwise. */
exports.resetKeywordFallbackWarnings = () => keywordFallbackWarned.clear();
/** Test seam: drive the latch directly rather than through a whole request. */
exports.warnKeywordFallback = warnKeywordFallback;

/** `List` and `Organization`: one container, one handler, told apart by `kind`. */
async function listRows({ access, query, pageNum, pageSize, sortBy }, kind) {
  const id = filterValue(query, '_id');
  if (id) {
    const row = await listsRepo.getById(access, id, kind);
    const rows = row ? [row] : [];
    return { searchResults: cosmosRows('lists', rows, access, kind, listRow), count: rows.length, applied: ['_id'] };
  }

  const applied = [];
  const filters = {};
  for (const key of Object.keys(listsRepo.FILTERS)) {
    const value = filterValue(query, key);
    if (value !== null) {
      filters[key] = value;
      applied.push(key);
    }
  }

  const opts = { ...filters, pageNum, pageSize, sortBy };
  const [rows, count] = await Promise.all([
    listsRepo.listByKind(kind, access, opts),
    listsRepo.countByKind(kind, access, filters)
  ]);
  return { searchResults: cosmosRows('lists', rows, access, kind, listRow), count, applied };
}

/**
 * eagle-public compares `legislation === 2002`, so a year stored as a string matches nothing.
 * Coerced on read so rows already stored need no re-run of the backfill.
 */
function listRow(row) {
  if (row.legislation === undefined || row.legislation === null || row.legislation === '') return {};
  const year = Number(row.legislation);
  return Number.isFinite(year) ? { legislation: year } : {};
}

/**
 * Period rows with `project` as the EAGLE parent id, which eagle-public puts into a project URL, read
 * under the caller's access. A notification-parented period links to the notification's own id.
 */
async function periodRows(access, rows) {
  const demiIds = Array.from(new Set(rows.map(r => r.projectId).filter(Boolean).map(String)));
  const parents = demiIds.length
    ? redactAllForAccess('projects', await projectsRepo.listByIds(access, demiIds), access)
    : [];
  const eagleIdByDemiId = new Map(parents.map(p => [String(p.id), p.eagleId ? String(p.eagleId) : null]));
  const nameByDemiId = new Map(parents.filter(p => p.name).map(p => [String(p.id), p.name]));

  const unmatched = demiIds.filter(id => !eagleIdByDemiId.has(id));
  const notificationParents = unmatched.length
    ? redactAllForAccess('notifications',
      await notificationsRepo.listByIds(access, unmatched), access)
    : [];
  for (const parent of notificationParents) {
    eagleIdByDemiId.set(String(parent.id), String(parent.id));
  }

  // The period's own ACL admits it only through the publish cascade; if that cascade failed, a
  // period of a hidden parent still reads public. The parent read above is the second check.
  const withheld = isPrivileged(access.roles || [])
    ? []
    : rows.filter(row => !eagleIdByDemiId.has(String(row.projectId)));
  if (withheld.length > 0) {
    logger.warn('[search] CommentPeriod withheld: parent not visible to this caller', {
      periodIds: withheld.map(row => String(row.id)),
      projectIds: Array.from(new Set(withheld.map(row => String(row.projectId))))
    });
  }

  // `projectName` rides on the parent read above, so the home page rail needs no read per card.
  // Absent, never invented, when the parent is hidden, unnamed, or a notification.
  return cosmosRows('commentPeriods', rows.filter(row => !withheld.includes(row)), access, 'CommentPeriod', (row) => {
    const name = nameByDemiId.get(String(row.projectId));
    return {
      project: eagleIdByDemiId.get(String(row.projectId)) || null,
      ...(name ? { projectName: name } : {})
    };
  });
}

/**
 * A notification row carries `proponent` as a NAME: Eagle stores a name or an Organization id there,
 * and the page renders it as sent. An id that matches nothing stays as sent.
 */
async function notificationRows(access, rows) {
  const orgIds = Array.from(new Set(rows
    .map(r => r.proponent)
    .filter(value => value && EAGLE_OBJECT_ID.test(String(value)))
    .map(String)));
  const orgs = orgIds.length
    ? redactAllForAccess('lists',
      await listsRepo.listByIds(access, orgIds, listsRepo.KINDS.ORGANIZATION), access)
    : [];
  const nameById = new Map(orgs.map(o => [String(o.id), o.name]));

  return cosmosRows('notifications', rows, access, 'ProjectNotification',
    (row) => ({ proponent: nameById.get(String(row.proponent)) || row.proponent }));
}

/** A comment row carries `period` — eagle-public's Comment model reads it. */
function commentRows(access, rows) {
  return cosmosRows('comments', rows, access, 'Comment',
    (row) => ({ period: row.periodId ? String(row.periodId) : null }));
}

exports.search = async (req, res) => {
  try {
    const dataset = req.query.dataset;
    const keywords = req.query.keywords || req.query.q || '';
    // FORCED ON; the wire value is ignored but still accepted, see
    // wiki Search-Query-Construction#why-the-fuzzy-parameter-is-ignored.
    const fuzzy = true;
    // On unless the caller sends `false`: debounced keystroke searches end in a half-typed word.
    // Project and Document only.
    const prefix = req.query.prefix !== 'false';
    // `>= 1`, not `Math.max(1, ...)`: NaN, 0 and negatives all get the default, see
    // wiki Search-Query-Construction#page-size-clamping.
    const parsedPageSize = parseInt(req.query.pageSize, 10);
    const requestedPageSize = parsedPageSize >= 1 ? parsedPageSize : 10;
    const pageSize = Math.min(requestedPageSize, 5000);

    // Unknown parameter: REFUSED. Inexpressible filter key: dropped and reported. See
    // wiki Search-Query-Construction#unsupported-parameters-400-inexpressible-filter-keys-drop.
    const unknown = eagleQuery.unknownParams(req.query);
    if (unknown.length > 0) {
      return res.status(400).json({ error: `Unsupported query parameter: ${unknown.join(', ')}` });
    }
    if (req.query._schemaName !== undefined && dataset !== 'Item') {
      return res.status(400).json({ error: '_schemaName applies to dataset=Item only' });
    }

    // Typed text, so no name cell or a value past the cap is refused, never trimmed.
    const nameContainsRefused = eagleQuery.nameContainsError(req.query, dataset);
    if (nameContainsRefused) {
      return res.status(400).json({ error: nameContainsRefused });
    }

    // Decides BOTH the page-size ceiling and which backend answers; see eagleQuery.hasCriteria.
    const criteria = eagleQuery.hasCriteria(req.query);

    // An oversized INDEXED page is REFUSED, not truncated; all three conditions are load-bearing.
    // See wiki Search-Query-Construction#why-large-pages-are-refused-not-truncated.
    if ((keywords || criteria || dataset === 'Document') &&
        requestedPageSize > aiSearch.MAX_PAGE_ROWS) {
      return res.status(400).json({
        // A bare document list is served by the index too, so this fires with no filter or keyword.
        error: `pageSize above ${aiSearch.MAX_PAGE_ROWS} is not supported for ${
          dataset === 'Document' ? 'a document search' : 'a filtered or keyword search'}`
      });
    }

    // 0-BASED on the wire, deliberately: eagle-public sends `pageNum - 1`, and a bare
    // `ProjectService.getAll()` sends `-1` outright, so this floors rather than trusting it.
    const pageNum = Math.max(0, parseInt(req.query.pageNum || '0', 10) || 0);

    // One access context for the whole request, so the indexed and the unindexed path cannot
    // disagree about what this caller may see.
    const access = resolveAccess(req);

    // Rows in the caller's own `pageSize`; skipping by the service's 250-row cap repeats pages.
    const skip = pageNum * pageSize;

    // Every key this request could not express, told to the caller and the log alike. See
    // wiki Search-Query-Construction#the-dropped-keys-report.
    const droppedKeys = { filter: [], sort: [] };
    const noteDropped = (kind, keys) => {
      if (!keys || !keys.length) return;
      eagleQuery.reportDropped(dataset, kind, keys);
      droppedKeys[kind].push(...keys);
    };

    // A field the live index could not answer (ai-search `send` drops it and retries), told like `dropped`.
    // Accumulated, not replaced: one page can be degraded twice, and the second note must not erase the first.
    let degraded = null;
    const noteDegraded = (meta) => {
      if (!meta || !meta.degraded) return;
      const merged = { ...(degraded || {}), ...meta.degraded };
      // List keys are unioned; scalars belong to the later mark.
      for (const key of ['missing', 'reasons']) {
        const both = [...((degraded && degraded[key]) || []), ...(meta.degraded[key] || [])];
        if (both.length) merged[key] = Array.from(new Set(both));
      }
      degraded = merged;
    };

    // The eagle envelope and the usage event, once for every exit. `searchResultsTotal` only when
    // MEASURED: wiki Search-Query-Construction#totals-are-measured-never-the-page-length.
    const sendJson = res.json.bind(res);
    res.json = (payload) => {
      const first = Array.isArray(payload) ? payload[0] : null;
      // KNOWN LIMIT: a branch answering any shape but `[{ searchResults }]` goes uncounted, silently.
      if (first && Array.isArray(first.searchResults)) {
        const total = Number.isFinite(first.count) ? first.count : undefined;
        // eagle-admin pages on this header, as eagle-api's list routes set it. Measured totals only.
        if (total !== undefined) res.set?.('x-total-count', String(total));
        if (total === undefined) {
          logger.warn(
            `[search] ${dataset}: answering with no measured total — ` +
            'the caller is told the count is unknown rather than shown the page length as one'
          );
        }
        analyticsEvent(req, {
          eventName: 'search',
          searchTerm: keywords,
          // KNOWN LIMIT: `audit.js` writes 0 for an absent ResultCount, so an unmeasured search
          // lands as zero-result until DemiEvents_CL has a nullable column.
          resultCount: total,
          detail: { dataset, fuzzy, pageSize }
        });
        first.meta = [{
          ...(total === undefined ? {} : { searchResultsTotal: total }),
          // Chunk rows are PASSAGES, not documents: several can come from one file. eagle-search
          // flags it the same way.
          ...(dataset === 'DocumentChunk'
            ? { countsPassages: true, documentsOnPage: first.searchResults.length }
            : {}),
          // See wiki Search-Query-Construction#the-dropped-keys-report.
          ...(droppedKeys.filter.length || droppedKeys.sort.length ? { dropped: droppedKeys } : {}),
          // OMITTED unless a field was dropped to keep the search answerable at all.
          ...(degraded ? { degraded } : {})
        }];
      }
      return sendJson(payload);
    };

    // Project filters arrive as Eagle ObjectIds and the indexes hold DEMI project ids. Resolved
    // once for every dataset, before any filter is built, because the translation is a read.
    const filterQuery = await resolveProjectFilter(access, req.query);

    // A project filter the dataset cannot express ANSWERS NOTHING, never everything: dropping it
    // would answer the whole ACL-visible corpus to a caller who asked for one project.
    if (eagleQuery.projectIdsFrom(filterQuery).length && !eagleQuery.canScopeToProject(dataset)) {
      noteDropped('filter', ['project']);
      // `res.json`, not `sendJson` — the wrapper is what attaches `meta`, and the `dropped` key
      // telling the caller WHY this is empty is the whole value of the response.
      return res.json([{ searchResults: [], count: 0 }]);
    }

    if (dataset === 'Project') {
      // Keywords or criteria go to AI Search; a BARE list still comes from Cosmos below. See
      // wiki Search-Query-Construction#project-reads-split-between-cosmos-and-the-index.
      if (keywords || criteria) {
        try {
          // 'id', not 'projectId' — a project IS its own scope, and scoping on a field the index
          // does not have would match nothing while looking like an empty corpus.
          const acl = filterFor(access, 'id');

          if (!acl.empty) {
            // The caller's `and[...]` filters COMPOSED WITH the ACL clause, never instead of it —
            // buildFilter takes the whole `filterFor` result and refuses to run without it.
            const { filter, dropped, fields } = eagleQuery.buildFilter(filterQuery, dataset, acl, access);
            noteDropped('filter', dropped);

            // `Boolean(keywords)`, not `true`: with no keywords there is no relevance to order by,
            // and DEFAULT_ORDER is what keeps `$skip` paging from repeating and omitting rows.
            const { orderby, dropped: sortDropped, fields: sorted } =
              eagleQuery.buildOrderBy(req.query.sortBy, dataset, Boolean(keywords), access);
            noteDropped('sort', sortDropped);

            // `count` is the index-wide total, not the page — eagle-public pages against it and the
            // column header shows it.
            const { items, count, meta } = await aiSearch.searchProjects({
              filter: await withoutDialHidden(
                access, filter, [...fields, ...sorted], keywords, aiSearch.PROJECT_SEARCH_FIELDS),
              orderby,
              skip,
              keywords,
              // No keywords means "every row the filter admits". Without it `runSearch`
              // short-circuits on an empty token list and the filtered search answers zero rows.
              matchAll: !keywords,
              fuzzy,
              prefix,
              top: pageSize
            });
            noteDegraded(meta);

            if (items.length > 0) {
              const staffFields = await staffFieldsByProjectId(access, items.map(hit => String(hit.id)));
              const searchResults = items.map(hit => {
                // Redact the INDEX row, then map, exactly as the Cosmos branch below does.
                const doc = redactIndexProject(hit, access);
                return {
                // THE EAGLE ObjectId, or the DEMI id for a Track-only project. See
                // wiki Search-Query-Construction#project-id-spaces.
                _id: doc.legacyEagleId || String(doc.id),
                _schemaName: 'Project',
                id: String(doc.id),
                // NULL when there is no Track counterpart, never the DEMI id. Only a Track id is all
                // digits (`eagle-` and minted UUID ids are not); `sourceSystem` is not in PROJECT_SELECT.
                trackProjectId: /^\d+$/.test(String(doc.id)) ? String(doc.id) : null,
                legacyEagleId: doc.legacyEagleId || '',
                name: doc.name || doc.displayName || 'Unnamed Project',
                sector: wireSector(hit, doc, doc.legislationYear),
                status: doc.status || 'Active',
                centroid: geoPoint(doc.centroid),
                // The stored value, as `/projects/:id` answers it: eagle-api sends '' and no placeholder.
                region: doc.region ?? null,
                description: doc.description || 'No project description provided.',
                proponent: { name: doc.proponent || 'Proponent Organization' },
                // `{_id, name}` rebuilt from the flat label/id pair the index stores, the shape the
                // template binds and the filter panel sends.
                type: doc.type || '',
                currentPhaseName: eagleQuery.ref(doc.currentPhaseNameId, doc.currentPhaseName),
                eacDecision: eagleQuery.ref(doc.eacDecisionId, doc.eacDecision),
                decisionDate: doc.decisionDate || null,
                // Eagle's own edit date, the "Last updated" column. NOT `updatedAt`, which is
                // DEMI's sync stamp and moves on every re-merge.
                dateUpdated: doc.dateUpdated || null,
                // `assessments` is too nested for the index, so it rides the Cosmos branch only.
                phaseIds: doc.phaseIds ?? null,
                activeWork: indexActiveWork(doc),
                // Pre-escaped display markup from the analyzer, keyed by INDEX field. `name` falls
                // back to `displayName` the same way the plain value above does.
                highlighted: {
                  name: (doc.highlighted || {}).name || (doc.highlighted || {}).displayName || '',
                  description: (doc.highlighted || {}).description || ''
                },
                // `read[]` is NOT emitted on any row shape: it publishes internal role names. The
                // redactor drops it and derives `isPublished`.
                isPublished: doc.isPublished,
                // No `sources`: the `projects` index has no such field.
                ...staffFields.get(String(doc.id))
                };
              });

              return res.json([{ searchResults, count }]);
            }

            // No rows on THIS page; `count` tells an empty corpus from a page past the end. Never
            // fall through to the Cosmos read, which ignores the keywords.
            return res.json([{ searchResults: [], count }]);
          }

          // Scoped to nothing. Fail closed, and do not let the unfiltered list answer instead;
          // 0 is measured, because no filter can express this caller's visibility.
          return res.json([{ searchResults: [], count: 0 }]);
        } catch (err) {
          // A FAILED search is neither empty nor the keywordless list. See
          // wiki Search-Query-Construction#a-failed-search-is-never-an-empty-one.
          logger.error(`[search] project search failed: ${err.message}`);
          return res.status(502).json(searchUnavailable(req, err, 'Project search is unavailable'));
        }
      }

      // Bare list: a read, in the repository's own order.
      try {
        // `readPage` follows continuation tokens; `pageSize` is clamped and a page past MAX_PAGE_DEPTH is a 400.
        // Only `project` can still drop here: other criteria went to the index, and `projects` has no project axis.
        noteDropped('filter', eagleQuery.filterKeysIn(req.query));

        const projects = await projectsRepo.listPage(access, { pageNum, pageSize });

        // Counted on EVERY request, `pageNum` or not: an unmeasured total must never fall back to
        // the page length.
        const count = await projectsRepo.countVisible(access);

        // A NoSQL row has no `_id`; the RESPONSE keeps it because the frontend keys on it.
        const mapped = projects.map(p => {
          // Redact the ROW, then map: the catalog must never run over wire names
          // (docs/rbac-architecture.md §2 item 9).
          const row = redactForAccess('projects', p, access);
          return {
            // The Eagle id, for the same reason as the AI Search branch above.
            _id: row.eagleId || String(row.id),
            _schemaName: 'Project',
            id: String(row.id),
            // NULL when absent, NOT the DEMI id. `== null`, not `||`: Track id 0 is falsy. See
            // wiki Search-Query-Construction#project-id-spaces.
            trackProjectId: row.trackProjectId == null ? null : String(row.trackProjectId),
            // COSMOS FIELD NAMES, not the indexer's aliases. See
            // wiki Search-Index-Reference#cosmos-and-index-field-names-differ.
            legacyEagleId: row.eagleId || '',
            name: row.name || 'Unnamed Project',
            // `legislation` too: the index has only `legislationYear`, so a row with the label
            // alone reads as 2018 on the keyword path.
            sector: wireSector(p, row, row.legislationYear ?? row.legislation),
            // The writers rename at the edge (`controllers/nosql/project.js`), so `status` is a
            // wire name only and no row carries it.
            status: row.projectState || 'Active',
            // Same helper as the AI Search branch — one definition of the fallback centroid.
            centroid: geoPoint(row.centroid),
            region: row.region ?? null,
            // `location` on the wire, `address` at rest. COSMOS BRANCH ONLY: `address` is not a
            // column of the `projects` index.
            location: row.address || '',
            description: row.description || 'No project description provided.',
            proponent: { name: row.proponentName || 'Proponent Organization' },
            // COSMOS BRANCH ONLY: `eaCertificate` is not a column of the `projects` index.
            eaCertificate: row.eaCertificate || null,
            type: row.projectType || '',
            currentPhaseName: eagleQuery.ref(row.currentPhaseName?._id, row.currentPhaseName?.name),
            eacDecision: eagleQuery.ref(row.eacDecision?._id, row.eacDecision?.name),
            decisionDate: row.decisionDate || null,
            // Same column as the index branch above, so both project shapes answer it.
            dateUpdated: row.dateUpdated || null,
            assessments: row.assessments ?? null,
            phaseIds: row.phaseIds ?? null,
            activeWork: row.activeWork ?? null,
            // Derived by the redactor from 'public' in the read ACL.
            isPublished: row.isPublished,
            // The catalog publishes only `sources.wildfire`; the raw Track and Eagle payloads here
            // are traceability, not API surface.
            sources: row.sources || {},
            ...staffProjectFields(row)
          };
        });

        return res.json([{ searchResults: mapped, count }]);
      } catch (cosmosErr) {
        // A page past MAX_PAGE_DEPTH, refused by `readPage` before it reads anything.
        if (cosmosErr.status === 400) return res.status(400).json({ error: cosmosErr.message });
        // A search that FAILED is not a search that found nothing: `[]` would say the registry is empty.
        logger.error(`[search] project list failed: ${cosmosErr.message}`);
        return res.status(502).json(searchUnavailable(req, cosmosErr, 'Project search is unavailable'));
      }
    } else if (dataset === 'Document') {
      // EVERY document read goes to the index, with no fallback. See
      // wiki Search-Query-Construction#every-document-read-goes-to-the-index.
      try {
        const acl = documentsAcl(access);
        // Projects are scoped on their own id; the same caller, a different index.
        const projectScope = filterFor(access, 'id');

        if (!acl.empty) {
          const { filter, dropped } = eagleQuery.buildFilter(filterQuery, dataset, acl, access);
          noteDropped('filter', dropped);

          // `?docIds=a|b|c`, eagle-public's multi-id fetch (pipe-joined by `buildValues`), ANDed on as one
          // `inClause` over the documents index key `id`.
          const docScope = documentIdScope(req.query.docIds);
          const scopedDocFilter = docScope
            ? (filter ? `(${filter}) and ${docScope}` : docScope)
            : filter;
          // See the Project branch: `Boolean(keywords)` is what lets DEFAULT_ORDER give a
          // keywordless page a stable order instead of a constant relevance score.
          const { orderby, dropped: sortDropped } =
            eagleQuery.buildOrderBy(req.query.sortBy, dataset, Boolean(keywords), access);
          noteDropped('sort', sortDropped);

          const { items, count, meta } = await aiSearch.searchDocuments({
            filter: scopedDocFilter,
            orderby,
            // The service's `$skip` ceiling of 100,000 rows is not enforced here: the corpus is
            // below it. Revisit as the document count nears it.
            skip,
            // Passed so the project-name leg runs under the caller's project visibility. Undefined
            // would disable that leg; null legitimately means "unrestricted".
            projectFilter: projectScope.empty ? undefined
              : await withoutDialHidden(access, projectScope.filter, [], keywords, aiSearch.LEG_TWO_SEARCH_FIELDS),
            keywords,
            // See the Project branch: no keywords means every row the filter admits.
            matchAll: !keywords,
            fuzzy,
            prefix,
            top: pageSize
          });
          noteDegraded(meta);

          if (items.length > 0) {
            const mappedDocs = items.map(hit => {
              // Redact the INDEX row, then map — same rule and same reason as the project branch.
              const doc = redactForAccess('index-documents', hit, access);
              return {
              // Already an Eagle ObjectId: documents are seeded keyed on it, which is what makes
              // eagle-api's `/api/public/document/{_id}/download/...` resolve.
              _id: String(doc.id),
              _schemaName: 'Document',
              displayName: doc.displayName || 'Untitled Document',
              // The index has no `s3Key` to fall back to; sampled documents never hit this.
              documentFileName: doc.documentFileName || 'document.pdf',
              documentType: doc.type || 'PDF Document',
              isFeatured: doc.isFeatured === true,
              documentSource: doc.documentSource || '',
              // Bytes, under Eagle's name: eagle-public sizes a bulk download off `internalSize`.
              internalSize: doc.fileSize || null,
              // The ids eagle-public's `idToList()` resolves, NOT the labels beside them: a label
              // is ambiguous across the 2002 and 2018 Acts (`Amendment` is two different List rows).
              type: doc.typeId || null,
              milestone: doc.milestoneId || null,
              projectPhase: doc.projectPhaseId || null,
              documentAuthorType: doc.documentAuthorTypeId || null,
              datePosted: doc.datePosted || null,
              project: String(doc.projectId || ''),
              // The index carries no projectName — an indexer reads a single container.
              // `labelWithProjectNames` supplies both this and the `{_id, name}` shape below.
              projectName: 'Associated Project',
              // Derived by the redactor from `read[]`, which it drops — see the project branch.
              isPublished: doc.isPublished,
              description: doc.description || 'Official document extracted from central registry.',
              // Pre-escaped display markup. Empty when the field is, in which case the frontend
              // falls back to the default text above — ours, so there is nothing to highlight.
              highlighted: doc.highlighted
              };
            });

            await labelWithProjectNames(access, mappedDocs);

            return res.json([{ searchResults: mappedDocs, count }]);
          }

          // See the project branch: no rows is an answer, and `count` is what distinguishes an
          // empty corpus from a page past the end of a large one.
          return res.json([{ searchResults: [], count }]);
        }

        // Scoped to nothing: 0 is measured, not assumed.
        return res.json([{ searchResults: [], count: 0 }]);
      } catch (err) {
        // A search that failed is not a search that found nothing.
        logger.error(`[search] document search failed: ${err.message}`);
        return res.status(502).json(searchUnavailable(req, err, 'Document search is unavailable'));
      }
    } else if (dataset === 'DocumentChunk') {
      // Deep Search over extracted document TEXT. NO fallback to another source on an empty
      // result — that is how "extraction has not run" becomes "silently searched something else".
      if (!keywords) {
        // Nothing was asked, so nothing matched: 0 is the measured answer to a query that is none.
        return res.json([{ searchResults: [], count: 0 }]);
      }

      try {
        // The service applies the ACL with the match, so ranking covers only readable rows. A chunk
        // carries its document as `documentId`; its own id is not filterable.
        const acl = filterFor(access, 'projectId', 'documentId');

        // Fail-closed, and it MUST short-circuit here: OData has no `false` literal, so issuing the
        // request with no filter would return everything.
        if (acl.empty) {
          return res.json([{ searchResults: [], count: 0 }]);
        }

        // Facets filter on the chunk's own copy. One the live index cannot answer is made
        // INEXPRESSIBLE, not deleted, so it lands in `dropped` and the recovery answers it.
        const liveFacets = await liveChunkFacets(filterQuery, acl, eagleQuery.projectIdsFrom(filterQuery));
        const { unavailable } = liveFacets;

        const { filter, dropped } = eagleQuery.buildFilter(
          filterQuery, dataset, acl, access, { unexpressible: unavailable });

        // Reported only for what STAYED dropped: a recovered key is one that worked.
        const { scope, recovered, capped } = await recoverChunkFilters(filterQuery, dropped, access);
        noteDropped('filter', dropped.filter(key => !recovered.includes(key)));
        // `filter` is UNDEFINED for an unscoped privileged caller; a bare template would emit
        // `(undefined) and …`.
        const scopedFilter = scope
          ? (filter ? `(${filter}) and ${scope}` : scope)
          : filter;

        // Short only when the documents-index recovery is over the scope cap too; reasons only, never a count
        // (anonymous route). Each clears differently: wiki Search-Query-Construction#deep-search-can-be-degraded-three-ways.
        if (capped) {
          const reasons = chunkQuery.facetReasons(liveFacets);
          if (reasons.length) noteDegraded({ degraded: { reasons } });
        }

        // Every `chunks` field is `sortable: false`, so `buildOrderBy` runs only for its drop list.
        noteDropped('sort', eagleQuery.buildOrderBy(req.query.sortBy, dataset, Boolean(keywords), access).dropped);

        // The chunk window is the paging unit; `pageSize` is a fetch knob here. See
        // wiki Search-Query-Construction#chunk-paging-is-a-window.
        const chunkWindow = groupChunks.windowFor(pageSize, aiSearch.SERVICE_MAX_TOP);
        const { items, count, meta } = await aiSearch.searchChunks({
          filter: scopedFilter,
          // No `orderby`: naming a non-sortable field is a 400. With no tiebreak, a deep chunk
          // page is unstable.
          skip: pageNum * chunkWindow,
          keywords,
          fuzzy,
          top: chunkWindow
        });
        noteDegraded(meta);

        if (items.length === 0) {
          // `count` rather than a bare empty answer: a page past the end of a large result set
          // returns no rows too, and 0 there would tell the caller the index holds nothing.
          return res.json([{ searchResults: [], count }]);
        }

        // Chunks carry ids, not labels; the parent document is also the gate.
        const { visible, docById, projById, count: netCount } =
          await chunkQuery.gateChunksByParent(access, items, count);

        const mappedChunks = visible.map(chunk => {
          const parent = docById.get(String(chunk.documentId));
          const project = projById.get(String(chunk.projectId));
          const projectName = (project && project.name) || 'Associated Project';
          return {
            _id: String(chunk.chunkId),
            _schemaName: 'DocumentChunk',
            documentId: String(chunk.documentId || ''),
            // The DEMI project id; `project._id` below is the EAGLE ObjectId. One field per
            // id-space, never one derived from the other.
            projectId: String(chunk.projectId || ''),
            // Same miss case as labelWithProjectNames: a chunk whose parent PROJECT is unreadable
            // still returns, because the gate is the parent DOCUMENT above.
            project: eagleQuery.ref(
              (project && project.eagleId) || String(chunk.projectId || ''),
              projectName
            ),
            projectName,
            documentName:
              (parent && (parent.displayName || parent.documentFileName)) || 'Untitled Document',
            documentType: (parent && parent.type) || 'PDF Document',
            // `milestone` is the LABEL and `milestoneId` the id, unlike the Document dataset; see
            // `group-chunks.js`.
            milestone: (parent && parent.milestone) || null,
            milestoneId: (parent && parent.milestoneId) || null,
            datePosted: (parent && parent.datePosted) || null,
            pageNumber: chunk.pageNumber ?? 0,
            // Whether that number is a real PDF page (eagle-public links `#page=N` only then). A
            // BOOLEAN on every row: Cosmos chunks may lack the field.
            pageNumbered: chunk.pageNumbered === true,
            // Empty by design: `content` is not retrievable from the index, so the API never ships
            // whole chunks. The UI renders `snippet` and falls back to `content` only without one.
            content: '',
            // Already escaped, with only the <mark> tags this layer added — chunk text comes from
            // arbitrary uploaded PDFs and the UI renders it with [innerHTML].
            snippet: chunk.snippet || ''
          };
        });
        // GROUPED AFTER THE GATE, so a withheld chunk adds no snippet or match to a document row.
        // See wiki Search-Query-Construction#the-parent-document-is-the-chunk-gate.
        const grouped = groupChunks.groupByDocument(mappedChunks);

        return res.json([{
          searchResults: grouped,
          // Still the PASSAGE total — `meta.countsPassages` says so, and the rows are documents.
          // Floored at `visible.length`, not `grouped.length`: one row can carry a dozen matches.
          count: netCount
        }]);
      } catch (err) {
        // A fault is NOT "nothing matched", and the status code is the only place to say so.
        logger.error(`[search] chunk search failed: ${err.message}`);
        return res.status(502).json(searchUnavailable(req, err, 'Deep Search is unavailable'));
      }
    } else if (dataset === 'Item') {
      const schemaName = firstValue(req.query._schemaName);
      if (!ITEM_SCHEMAS.includes(schemaName)) {
        return res.status(400).json({ error: `_schemaName must be one of ${ITEM_SCHEMAS.join(', ')}` });
      }
      const id = filterValue(req.query, '_id');
      const extra = eagleQuery.filterKeysIn(req.query).filter(key => key !== '_id');
      if (!id || extra.length) {
        return res.status(400).json({ error: 'dataset=Item takes _id and _schemaName only' });
      }
      try {
        const { searchResults } = await COSMOS_DATASETS[schemaName]({
          access, query: { _id: id }, filterQuery: { _id: id }, pageNum: 0, pageSize: 1
        });
        res.set?.('x-total-count', String(searchResults.length));
        // A BARE array, not the search envelope: eagle-api answers Item that way and eagle-admin reads `[0]`.
        return sendJson(searchResults);
      } catch (err) {
        logger.error(`[search] Item ${schemaName} read failed: ${err.message}`);
        return res.status(502).json(searchUnavailable(req, err, 'Item lookup is unavailable'));
      }
    } else if (COSMOS_DATASETS[dataset]) {
      // A KEYWORD search over one of the two indexed datasets is ranked by the index; everything
      // else here is a Cosmos list read. See KEYWORD_INDEX_DATASETS for why only the ranking moves.
      const indexed = keywords ? KEYWORD_INDEX_DATASETS[dataset] : null;
      if (indexed && !indexed.cosmosOnly(req.query)) {
        // The kill switch: SEARCH_ENDPOINT or this dataset's index setting empty. Falls through to
        // the Cosmos read, which answers keywords on CONTAINS instead of BM25.
        if (!aiSearch.config().configured || indexed.index() === '') {
          warnKeywordFallback(dataset);
        } else {
          // What the INDEX attempt reported dropped, so a fallback can put it back: the page the
          // caller receives is the Cosmos one, and it reports its own keys below.
          const notedBefore = { filter: droppedKeys.filter.length, sort: droppedKeys.sort.length };
          try {
            const acl = await indexed.acl(access);
            // Scoped to nothing: 0 is measured, and OData cannot express a filter that matches
            // nothing — see filterFor.
            if (acl.empty) return res.json([{ searchResults: [], count: 0 }]);

            const indexQuery = indexed.indexQuery(req.query);
            const { filter, dropped } = eagleQuery.buildFilter(indexQuery, dataset, acl, access);
            noteDropped('filter', unappliedFilterKeys(req.query, indexQuery, dropped));

            // `true`, not `Boolean(keywords)`: this branch only runs with keywords, so the order is
            // relevance unless the caller named a field.
            const { orderby, dropped: sortDropped } =
              eagleQuery.buildOrderBy(req.query.sortBy, dataset, true, access);
            noteDropped('sort', sortDropped);

            const { items, count, meta } = await indexed.search({
              filter, orderby, skip, keywords, fuzzy, prefix, top: pageSize
            });
            noteDegraded(meta);

            // `count` is the index-wide total; the page can be shorter when Cosmos denies a row,
            // which is the fail-closed direction.
            const searchResults = await indexed.rows(access, items.map(hit => String(hit.id)));
            return res.json([{ searchResults, count }]);
          } catch (err) {
            // A setting naming an index that does not exist 404s on every query, and no config says
            // so: fall through to the Cosmos read, like an emptied setting.
            if (aiSearch.isMissingIndex(err, indexed.index())) {
              droppedKeys.filter.length = notedBefore.filter;
              droppedKeys.sort.length = notedBefore.sort;
              warnKeywordFallback(dataset, 'missing');
            } else {
              // Same rule as the Project and Document branches: a search that FAILED is not a
              // search that found nothing, and it must not become the keywordless list either.
              logger.error(`[search] ${dataset} keyword search failed: ${err.message}`);
              return res.status(502).json(
                searchUnavailable(req, err, `${dataset} search is unavailable`));
            }
          }
        }
      }

      // Same guards as the Project bare list: one measured count, every row through the catalog,
      // and 502 on failure.
      try {
        const result = await COSMOS_DATASETS[dataset]({
          access, query: req.query, filterQuery, pageNum, pageSize, sortBy: req.query.sortBy
        });

        // A branch that refuses the request rather than answering it — see the Comment branch.
        if (result.error) return res.status(400).json({ error: result.error });

        // Every filter key this branch did NOT consume.
        const applied = new Set(result.applied || []);
        noteDropped('filter', eagleQuery.filterKeysIn(req.query).filter(key => !applied.has(key)));
        noteDropped('sort', result.sortDropped);

        return res.json([{
          searchResults: result.searchResults,
          count: result.count,
          // A SECOND measurement, not a second total: `meta[0].searchResultsTotal` carries one
          // number. Only the open-period rail sets it.
          ...(result.closedCount === undefined ? {} : { closedCount: result.closedCount })
        }]);
      } catch (err) {
        // A page past MAX_PAGE_DEPTH, refused by `readPage` before it reads anything.
        if (err.status === 400) return res.status(400).json({ error: err.message });
        logger.error(`[search] ${dataset} read failed: ${err.message}`);
        return res.status(502).json(searchUnavailable(req, err, `${dataset} search is unavailable`));
      }
    } else {
      return res.status(400).json({ error: `Invalid or unsupported dataset: ${dataset}` });
    }
  } catch (err) {
    // Nothing below reached an answer, so there is no result set — empty or otherwise — to report.
    // A 200 here would publish "no results" as a finding of the search that never ran.
    logger.error('[demi-api search] Top-level search error:', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Search failed' });
  }
};

/** The record types the unified search page shows a badge for, in the order the tabs sit in. */
const COUNTS_DATASETS = ['Project', 'Document', 'RecentActivity', 'ProjectNotification', 'CommentPeriod'];

/**
 * EVERY parameter `/search/counts` reads. It counts every type at once, so any filter is REFUSED:
 * a badge under a filter the caller thinks applied is a silently wrong number.
 */
const COUNTS_PARAMS = new Set(['keywords', 'q', 'prefix', 'datasets']);

/**
 * How long one caller's badge row is reused: bounds a count per type per keystroke pause on a 1-SU
 * service, short enough that a newly published record shows within a page view.
 */
const COUNTS_TTL_MS = 45 * 1000;

/** Entries kept. One per distinct keyword/access pair, evicted oldest-first. */
const COUNTS_CACHE_MAX = 200;

/** key -> `{at, promise}`. The PROMISE is cached, not the value, which is what dedupes in flight. */
const countsCache = new Map();

exports.resetCountsCache = () => countsCache.clear();

/**
 * Every input `filterFor` and `updatesRepo.inEagleIdSpace` read. Over-specific on purpose: an extra
 * field costs a cache miss, a missing one serves one caller's counts to another.
 */
function accessFingerprint(access) {
  return JSON.stringify({
    tier: access.tier,
    level: access.level,
    roles: [...(access.roles || [])].sort(),
    teams: [...(access.teams || [])].sort(),
    projectScope: access.projectScope ? [...access.projectScope].sort() : null,
    compartment: access.compartment || null,
    credentials: access.credentials || []
  });
}

/**
 * One count per record type: `null` where it could not MEASURE one, never 0. `degraded: true` marks
 * a count from the Cosmos CONTAINS fallback, not the index.
 */
const COUNT_LEGS = {
  async Project({ access, keywords, prefix }) {
    // 'id', not 'projectId': a project IS its own scope. Same clause the Project branch builds.
    const acl = filterFor(access, 'id');
    // OData cannot express a filter that matches nothing, and 0 here is measured — see filterFor.
    if (acl.empty) return { count: 0 };
    return {
      count: await aiSearch.countProjects({
        filter: await withoutDialHidden(access, acl.filter, [], keywords, aiSearch.PROJECT_SEARCH_FIELDS),
        keywords, matchAll: !keywords, fuzzy: true, prefix
      })
    };
  },

  async Document({ access, keywords, prefix }) {
    const acl = documentsAcl(access);
    if (acl.empty) return { count: 0 };
    // Projects are scoped on their own id; the same caller, a different index.
    const projectScope = filterFor(access, 'id');
    // THE TWO-LEG SUM, not a bare `top: 0` on the documents index: leg two owns the documents whose
    // PROJECT's name matched, and a count without it under-reports the tab's own total.
    const { count } = await aiSearch.searchDocuments({
      countOnly: true,
      // Through buildFilter so the tab counts the rows the Document list returns.
      filter: eagleQuery.buildFilter({}, 'Document', acl, access).filter,
      projectFilter: projectScope.empty ? undefined
        : await withoutDialHidden(access, projectScope.filter, [], keywords, aiSearch.LEG_TWO_SEARCH_FIELDS),
      keywords,
      matchAll: !keywords,
      fuzzy: true,
      prefix
    });
    return { count };
  },

  async RecentActivity({ access, keywords, prefix }) {
    const index = aiSearch.config().activitiesIndex;
    if (keywords && aiSearch.config().configured && index !== '') {
      try {
        const acl = await updatesIndexAcl(access);
        if (acl.empty) return { count: 0 };
        return {
          count: await aiSearch.countActivities({ filter: acl.filter, keywords, fuzzy: true, prefix })
        };
      } catch (err) {
        // A setting naming an index nobody created 404s on every query, and the container can still
        // answer. Every other failure rejects and the badge goes unknown.
        if (!aiSearch.isMissingIndex(err, index)) throw err;
        warnKeywordFallback('RecentActivity', 'missing');
      }
    } else if (keywords) {
      warnKeywordFallback('RecentActivity');
    }

    // CONTAINS rather than BM25, exactly as the keywordless list read answers it.
    return { count: await updatesRepo.count(access, { keywords }), degraded: Boolean(keywords) };
  },

  async ProjectNotification({ access, keywords, prefix }) {
    // No keywords is the same question the Cosmos list read answers, and it answers it exactly.
    if (!keywords) return { count: await notificationsRepo.count(access, {}) };

    const index = aiSearch.config().notificationsIndex;
    if (!aiSearch.config().configured || index === '') {
      warnKeywordFallback('ProjectNotification');
      // NOT the Cosmos count: `notificationsRepo.count` takes no keywords, so it would answer the
      // whole corpus to a keyword query — a confidently wrong badge. Unknown is the honest answer.
      return { count: null };
    }

    try {
      // NULL partition field, like `notifications.SCOPE_FIELD`: a notification is not project data,
      // so role ACL is the whole filter.
      const acl = filterFor(access, null);
      if (acl.empty) return { count: 0 };
      return {
        count: await aiSearch.countNotifications({ filter: acl.filter, keywords, fuzzy: true, prefix })
      };
    } catch (err) {
      if (!aiSearch.isMissingIndex(err, index)) throw err;
      warnKeywordFallback('ProjectNotification', 'missing');
      return { count: null };
    }
  },

  // The same predicate the unscoped list reads with no status, so the badge is that tab's total.
  async CommentPeriod({ access, keywords }) {
    return {
      count: await commentPeriodsRepo.countAll(access, await periodListFilters(access, periodKeywords(keywords)))
    };
  }
};

/**
 * Every badge, in parallel, one failure at a time. `allSettled` because a tab whose index is down
 * must not take the others with it — the page shows one blank badge, never a 500.
 */
async function computeCounts(access, keywords, prefix) {
  const settled = await Promise.allSettled(
    COUNTS_DATASETS.map(name => COUNT_LEGS[name]({ access, keywords, prefix })));

  const counts = {};
  const unavailable = [];
  const degraded = [];

  COUNTS_DATASETS.forEach((name, i) => {
    const leg = settled[i];
    if (leg.status === 'rejected') {
      logger.error(`[search/counts] ${name} count failed`,
        { error: leg.reason && leg.reason.message, stack: leg.reason && leg.reason.stack });
      counts[name] = null;
      unavailable.push(name);
      return;
    }
    // `undefined` and `null` are the same fact here: nobody measured this one.
    counts[name] = leg.value.count === undefined ? null : leg.value.count;
    if (counts[name] === null) unavailable.push(name);
    if (leg.value.degraded) degraded.push(name);
  });

  return { counts, unavailable, degraded };
}

/**
 * `GET /api/search/counts`: EVERY type is computed and cached, `datasets` only slices the answer.
 * No `Cache-Control`: the counts are ACL-scoped, and a shared cache would leak them across callers.
 */
exports.counts = async (req, res) => {
  try {
    const unknown = eagleQuery.unsupportedParams(req.query, COUNTS_PARAMS);
    if (unknown.length > 0) {
      return res.status(400).json({ error: `Unsupported query parameter: ${unknown.join(', ')}` });
    }

    const requested = req.query.datasets === undefined
      ? COUNTS_DATASETS
      : Array.from(new Set(String(req.query.datasets).split(',').map(s => s.trim()).filter(Boolean)));
    const invalid = requested.filter(name => !COUNTS_DATASETS.includes(name));
    if (invalid.length > 0) {
      return res.status(400).json({ error: `Invalid or unsupported dataset: ${invalid.join(', ')}` });
    }

    // Whitespace only. Lowercasing would widen the cache but change the string the analyzer is
    // handed, and the key has to name the query that was actually run.
    const keywords = keywordText(req.query.keywords || req.query.q);
    // Same default as `/search`: on unless the caller sends the exact string `false`.
    const prefix = req.query.prefix !== 'false';
    const access = resolveAccess(req);

    const key = `${keywords}|${prefix}|${accessFingerprint(access)}`;
    const now = Date.now();
    const hit = countsCache.get(key);
    const cached = Boolean(hit) && now - hit.at < COUNTS_TTL_MS;
    let entry = hit;

    if (!cached) {
      entry = { at: now, promise: computeCounts(access, keywords, prefix) };
      // Re-inserted so eviction order is by freshness rather than by first sighting.
      countsCache.delete(key);
      countsCache.set(key, entry);
      // A rejection must not be remembered for the whole TTL — every leg is caught above, so this
      // only fires on a fault in the orchestration itself.
      entry.promise.catch(() => {
        if (countsCache.get(key) === entry) countsCache.delete(key);
      });
      while (countsCache.size > COUNTS_CACHE_MAX) {
        countsCache.delete(countsCache.keys().next().value);
      }
    }

    const { counts, unavailable, degraded } = await entry.promise;

    // Sliced to what the caller asked about: a badge they do not render is not a tab they can be
    // told is unavailable.
    const asked = new Set(requested);
    const picked = {};
    for (const name of requested) picked[name] = counts[name];

    return res.json([{
      counts: picked,
      meta: [{
        unavailable: unavailable.filter(name => asked.has(name)),
        degraded: degraded.filter(name => asked.has(name)),
        cached
      }]
    }]);
  } catch (err) {
    logger.error('[demi-api search/counts] Top-level counts error:',
      { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Counts failed' });
  }
};

/**
 * `GET /api/search/summary`, PRIVILEGED ONLY (behind `authMiddleware`). See wiki ADR-006 and
 * Search-Query-Construction#the-summary-endpoints-gates.
 */
exports.summarize = async (req, res) => {
  const keywords = req.query.keywords || req.query.q || '';
  if (!keywords) {
    return res.json({ summary: null, citations: [], reason: 'no_query' });
  }

  try {
    const access = resolveAccess(req);
    // Chunks again, so the same document field as the chunk search above.
    const { filter, empty } = filterFor(access, 'projectId', 'documentId');

    // Same fail-closed branch as the chunk search, for the same reason: a caller who may see
    // nothing cannot be expressed as a filter, and issuing one without would summarise everything.
    if (empty) {
      return res.json({ summary: null, citations: [], reason: 'no_results' });
    }

    const { items } = await aiSearch.searchChunks({
      filter,
      keywords,
      fuzzy: req.query.fuzzy === 'true',
      top: config.summaryMaxChunks
    });

    if (items.length === 0) {
      // The model is never called. This is the grounding guarantee the nonsense-term probe checks:
      // a build that returns prose here is answering from model knowledge, not from the corpus.
      return res.json({ summary: null, citations: [], reason: 'no_results' });
    }

    // Gates two and three: `getById` re-applies the ACL, and the parent-document read catches a stale
    // chunk `read[]`. See wiki Search-Query-Construction#the-summary-endpoints-gates.
    const [fetched, parentDocs] = await Promise.all([
      Promise.all(items.map(c => chunksRepo.getById(access, String(c.chunkId), String(c.documentId)))),
      documentsRepo.listByIds(access, items.map(c => c.documentId), items.map(c => c.projectId))
    ]);
    // Redacted before `citations` reads a name off it; `id` is 4/4, so this stays the parent gate.
    const docById = new Map(redactAllForAccess('documents', parentDocs, access)
      .map(d => [String(d.id), d]));

    // Response metadata reads off the redacted row. `content` (maxVis 0) is read off the raw
    // `fetched` row: the model call is its only consumer, gated by the parent document above.
    const rows = redactAllForAccess('chunks', fetched, access);

    const chunks = rows
      .map((row, i) => ({ row, text: fetched[i] && fetched[i].content }))
      .filter(({ row, text }) => row && row.documentId && text && docById.has(String(row.documentId)))
      .map(({ row, text }) => ({
        chunkId: String(row.id || ''),
        documentId: String(row.documentId || ''),
        projectId: String(row.projectId || ''),
        pageNumber: row.pageNumber ?? 0,
        content: text
      }));

    // A withheld count is the symptom of a stale chunk ACL, but empty `content` counts too, so it is
    // not proof on its own.
    if (chunks.length !== items.length) {
      logger.warn('[search/summary] withheld chunks whose parent document is not visible or whose text is empty', {
        withheld: items.length - chunks.length, returned: chunks.length
      });
    }

    const { summary, citations, reason, usage, estimatedCostCad } =
      await summarizer.summarize(keywords, chunks);

    // Hydrate ONLY the cited chunks, under the CALLER's access, never systemAccess(). Documents are
    // already in `docById`, so the 'Untitled Document' fallback below cannot fire here.
    const cited = citations.map(i => chunks[i]);
    const citedProjects = cited.length > 0
      ? await projectsRepo.listByIds(access, cited.map(c => c.projectId))
      : [];
    const projById = new Map(redactAllForAccess('projects', citedProjects, access)
      .map(p => [String(p.id), p]));

    return res.json({
      summary,
      // Resolved back to the chunks they point at, so the UI can render a source list rather than
      // a bare number. Indices are into the array actually sent to the model.
      citations: cited.map((c, idx) => {
        const parent = docById.get(c.documentId);
        const project = projById.get(c.projectId);
        return {
          n: citations[idx] + 1,
          chunkId: c.chunkId,
          documentId: c.documentId,
          projectId: c.projectId,
          pageNumber: c.pageNumber,
          documentName:
            (parent && (parent.displayName || parent.documentFileName)) || 'Untitled Document',
          projectName: (project && project.name) || 'Associated Project'
        };
      }),
      // What the answer cost. An ESTIMATE from reported tokens and configured list rates — see
      // estimateCostCad. Null when the model was never called.
      usage: usage || null,
      estimatedCostCad: estimatedCostCad ?? null,
      ...(reason ? { reason } : {})
    });
  } catch (err) {
    // Additive: the panel disappears, the results columns do not. 200 rather than 5xx for the same
    // reason the chunk search does it — the frontend retries 5xx and lands here again regardless.
    logger.error(`[search/summary] failed: ${err.message}`);
    return res.json({ summary: null, citations: [], reason: 'error' });
  }
};
