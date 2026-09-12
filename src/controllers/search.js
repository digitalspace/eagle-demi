'use strict';

// Searches go to Azure AI Search. A KEYWORDLESS project list is a read, not a search, and comes
// from the Cosmos NoSQL repositories — see wiki Search-Query-Construction#project-reads-split-between-cosmos-and-the-index.
const { resolveAccess } = require('../helpers/access-sql');
// Which container owns an Eagle id, said once for the mirrors, the seed and this read path.
const { pickParent } = require('../helpers/parent-admit');
const { redactForAccess, redactAllForAccess } = require('../vis/redact');
const { dialsForIndex } = require('../vis/catalog/index-projects-renames');
const { logger } = require('../utils/logger');
const { filterFor, inClause } = require('../helpers/access-odata');
const aiSearch = require('../search/ai-search');
const eagleQuery = require('../search/eagle-query');
const groupChunks = require('../search/group-chunks');
const documentsRepo = require('../repositories/documents');
const projectsRepo = require('../repositories/projects');
const { EAGLE_OBJECT_ID } = projectsRepo;
const chunksRepo = require('../repositories/chunks');
const commentPeriodsRepo = require('../repositories/comment-periods');
const commentsRepo = require('../repositories/comments');
const notificationsRepo = require('../repositories/notifications');
const listsRepo = require('../repositories/lists');
const updatesRepo = require('../repositories/updates');
const summarizer = require('../ai/summarize');
const { analyticsEvent } = require('../utils/audit');
const config = require('../config');

/**
 * The body of a 502 from a search that FAILED — never a search that found nothing.
 *
 * The status and the public sentence are unchanged; what is added is enough to act on. On
 * 2026-09-08 the browser console said only "Document search is unavailable" for 65 minutes while
 * the cause — the live index missing `fileSize` — sat in AppTraces, and finding it took a Log
 * Analytics query, the code and the git history.
 *
 * `code` separates the two failures an operator handles differently: SEARCH_SCHEMA_DRIFT means the
 * live index cannot answer what this app asks (widen the index — `/health/search-schema` names the
 * field), SEARCH_UPSTREAM means the service did not answer (a role, a timeout, a Cosmos fault).
 * `traceId` is the request id every log line for this request already carries, so the body names
 * the trace to open rather than describing it.
 *
 * THE UPSTREAM TEXT ITSELF NEVER GOES IN: this route is reachable anonymously, and a search error
 * message carries the service endpoint, the index name and sometimes the OData filter — which is
 * the caller's ACL clause. `field` is a name from the app's own select, not caller data.
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
 * Label document rows with their project, under the CALLER's access — never systemAccess(): a label
 * must not outlive the ACL of the row it describes.
 *
 * A project this caller cannot read yields `{_id: <DEMI id>, name: 'Associated Project'}`. The row
 * still returns — this is a label, not a gate — because a missing `project` object throws inside
 * eagle-public's row template and takes out every render of the row.
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
 * Rewrite `&project=`/`&and[project]=` from Eagle ObjectIds into DEMI project ids.
 *
 * A `ProjectNotification` id stays itself: it IS the partition its periods and documents live
 * under, and it outranks a project row carrying the same id (`helpers/parent-admit`).
 *
 * Done here and not in `buildFilter` because the translation is a read. An unresolved ObjectId is
 * passed through as a literal rather than refused — see
 * wiki Search-Query-Construction#unresolved-project-ids-pass-through-as-literals.
 *
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
    // Both containers, under the CALLER's access, and `pickParent` decides — the same rule the
    // mirrors partition by, so the filter names the partition the rows are actually in. A project
    // row may carry a notification's id in `eagleId` (a Track `epic_guid` that is really a
    // `ProjectNotification` _id), and translating to that project would search a partition holding
    // none of the notification's rows.
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
 * The visibility clause for the `documents` index: a document-scoped credential's ids live in `id`
 * here and in `documentId` on chunks, so the two indexes never share one clause.
 */
const documentsAcl = access => filterFor(access, 'projectId', 'id');

/**
 * Recover the DOCUMENT-ONLY chunk filters, by resolving them against the `documents` index.
 *
 * THE RESIDUE, not the main path: the four filter-panel facets are copied onto every chunk and
 * filter directly, so what arrives here is the keys a chunk carries no copy of — dates,
 * `isFeatured`, `legislation`, `documentSource` — plus any facet the live chunks index turns out
 * not to carry. See wiki Search-Query-Construction#chunk-filters-answer-on-the-chunks-own-copy.
 *
 * @returns {{scope: ?string, recovered: string[], capped: boolean}} `scope` is an OData clause to
 *   AND into the chunk filter, or null. `recovered` are the keys to REMOVE from the dropped report
 *   — everything else stays reported, the over-cap case included. `capped` says the recovery was
 *   the thing that failed: the keys are expressible here and the match set is simply too large to
 *   name, which is the only state the caller has nothing better to fall back on.
 */
async function recoverChunkFilters(query, dropped, access) {
  if (!dropped.length) return { scope: null, recovered: [], capped: false };
  // THE DOCUMENTS INDEX'S OWN ACL, never the chunk query's: a document-scoped credential compares
  // `documentId` there and `id` here, and the chunk clause sent to this index is a 400.
  const acl = documentsAcl(access);

  // Which dropped keys the DOCUMENTS index can express, asked by building a filter from them and
  // seeing which survive — a hardcoded list goes stale when an index widens. Rebuilt in the WIRE
  // shape: `dropped` holds base names (`legislation`), the query holds `and[legislation]`.
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
 * The facet keys this request sent that the LIVE chunks index cannot answer.
 *
 * EXPRESSIBILITY IS A FACT ABOUT THE SERVICE, NOT ABOUT THE PACKAGE: `eagle-query` reads the
 * packaged `chunks.json`, which an operator PUT applies separately, so the two disagree for the
 * length of a deploy window. See wiki Search-Query-Construction#chunk-filters-answer-on-the-chunks-own-copy.
 *
 * EXPRESSIBLE IS TWO FACTS, NOT ONE: the live index has to carry the column, AND every row this
 * request can see has to already hold the current stamp. A chunk the backfill has not reached
 * holds `null` in all four, so a clause over a carried-but-unstamped column is not a narrower
 * answer — it is 0 rows under a 200, which reads as "no documents of that type" rather than as a
 * backfill that has not finished. The half-stamped window is exactly the length of a backfill run,
 * and it is longer than the deploy window the schema probe covers.
 *
 * @param {{filter: ?string}} acl   the caller's clause, as the chunk query itself receives it
 * @param {string[]} projectIds     DEMI project ids from the request, empty for a corpus-wide read
 * @returns {Promise<{unavailable: string[], unstampedScope: boolean, unknownScope: boolean,
 *   missingColumn: boolean}>}
 *   `unavailable` are the wire keys to hand `buildFilter` as inexpressible — dropped, so the
 *   caller's own recovery can still answer them through the documents index. Everything not named
 *   there reaches the chunk query. `unstampedScope` is true ONLY for a MEASURED backlog in this
 *   caller's own scope. `unknownScope` is the other half: a facet withheld because a question went
 *   unanswered rather than because an answer said to withhold it. `missingColumn` is the third
 *   cause, and the settled one: the live index does not carry the column at all, which is a deploy
 *   whose `chunks.json` PUT has not been applied. None of the three says a count.
 */
async function liveChunkFacets(query, acl, projectIds) {
  const asked = new Set(eagleQuery.filterKeysIn(query));
  const facets = Object.keys(eagleQuery.DOCUMENT_FACETS).filter(key => asked.has(key));
  if (!facets.length) {
    return { unavailable: [], unstampedScope: false, unknownScope: false, missingColumn: false };
  }

  // Both the field list and the revision it was stamped under come from the repository, so the
  // search layer keeps knowing nothing about how a chunk is written. THE FOUR LIST REFS ONLY:
  // `projectId` is stamped beside them but no facet filters on it, and a fifth probe is a fifth
  // request per cold cache that can only ever withhold facets over a column nobody asked about.
  const status = await aiSearch.chunkParentFieldStatus(
    chunksRepo.CHUNK_PARENT_LIST_REFS, chunksRepo.CHUNK_PARENT_FIELDS_VERSION);
  // Defensive about the shape as well as the content: the probe resolves to a partial answer rather
  // than throwing, and a caller that reads `.available` off a rejection-shaped object 502s the tab.
  const shape = (status && typeof status === 'object') ? status : {};
  const answerable = new Set(Array.isArray(shape.available) ? shape.available : []);
  const absent = new Set(Array.isArray(shape.missing) ? shape.missing : []);
  const carried = facets.filter(key => answerable.has(eagleQuery.DOCUMENT_FACETS[key]));
  // UNDECIDED IS NOT ABSENT: a column the probe reported missing is a settled fact about the index
  // and the caller is told the same way either way, but only an unanswered question is a state
  // that clears by itself, so only that one earns the reason.
  const undecided = facets.some(key => {
    const column = eagleQuery.DOCUMENT_FACETS[key];
    return !answerable.has(column) && !absent.has(column);
  });
  // A column the probe reported ABSENT is settled, so it is not `undecided` — but the caller whose
  // recovery then ran out of room is owed a reason for the short page all the same, and it is a
  // different reason: this one clears when the index definition is applied, not by waiting.
  const missingColumn = facets.some(key => absent.has(eagleQuery.DOCUMENT_FACETS[key]));
  // Nothing to send either way, so the scope is not worth a count request.
  if (!carried.length) {
    return { unavailable: facets, unstampedScope: false, unknownScope: undecided, missingColumn };
  }

  // The index-wide count is the FREE SUPERSET: nothing behind anywhere means nothing behind here,
  // and it saves a per-scope count on the corpus state that lasts longest. Anything else — a
  // backlog somewhere, or an index that cannot say — is decided under this request's own predicate.
  const stale = shape.unstamped === 0 ? 0 : await staleChunksInScope(acl, projectIds);
  if (stale !== 0) {
    // Withheld WHOLE, carried columns included: one unstamped facet answering 0 poisons the whole
    // conjunction, so a partial application would be the same wrong answer at a smaller blast
    // radius. The documents index has no stamp to be behind on, and that is where these now go.
    // A count of `null` withholds exactly as a positive one does, but it is not a measurement, so
    // it is reported as the unknown it is rather than as a backfill nobody counted.
    return {
      unavailable: facets,
      unstampedScope: stale > 0,
      unknownScope: stale === null || undecided,
      missingColumn
    };
  }

  // ONLY WHAT THE PROBE PROVED FILTERABLE IS SENT: the two guesses do not cost the same. Sending a
  // clause the index cannot answer 502s the whole tab; dropping it costs one filter, and usually
  // not even that, since `dropped` is what `recoverChunkFilters` answers through `documents`. The
  // rows here are stamped, so the settled columns are answered on the chunk itself and only the
  // undecided ones take the recovery — one field's hiccup costs one filter, not all four.
  return {
    unavailable: facets.filter(key => !carried.includes(key)),
    unstampedScope: false,
    unknownScope: undecided,
    missingColumn
  };
}

/**
 * How many SCOPES of stale-chunk count are remembered at once. Bounded because the key carries a
 * project id, so an unbounded map grows with every project ever searched in this process.
 * Oldest-first eviction: a refreshed entry is re-inserted, which keeps a busy scope near the end.
 */
const STALE_SCOPE_CACHE_MAX = 32;
const staleScopeCounts = new Map();

/**
 * How many chunks THIS REQUEST could see still carry an older parent-field stamp than the code
 * writes — `null` when the question could not be answered, never 0.
 *
 * SCOPED, because the mark it gates says the caller's own filter is missing rows: same predicate,
 * same population, one answer. Never the caller's keywords — a stale chunk that does not match the
 * terms is still a row the facet filter had to skip. Cached per scope for `LIVE_SCHEMA_TTL_MS`,
 * since Deep Search fires on a debounced keystroke; an unanswered count is held for
 * `UNKNOWN_STATUS_TTL_MS` only. See wiki Search-Query-Construction#deep-search-can-be-degraded-three-ways.
 *
 * @param {{filter: ?string}} acl  the caller's clause, as the chunk query itself received it
 * @param {string[]} projectIds    DEMI project ids from the request, empty for a corpus-wide read
 */
async function staleChunksInScope(acl, projectIds) {
  const now = Date.now();
  // The ACL CLAUSE ITSELF is the access half of the key, not a role list: it is exactly what makes
  // two callers see the same rows, so two callers it renders identically may share one count.
  const key = `${acl.filter || '*'}\n${projectIds.join(',')}`;
  const hit = staleScopeCounts.get(key);
  if (hit && now - hit.at < hit.ttl) {
    // Re-inserted so a HIT moves the key to the end too: eviction reads insertion order, and
    // without this the busiest scope ages out on schedule while an idle one it keeps refreshing
    // past survives.
    staleScopeCounts.delete(key);
    staleScopeCounts.set(key, hit);
    return hit.promise;
  }

  const entry = { at: now, ttl: aiSearch.LIVE_SCHEMA_TTL_MS, promise: null };
  // The clause belongs to `ai-search`; this layer contributes the scope and the cache. The PROMISE
  // is cached rather than its value, so a burst hitting a cold cache issues one probe between them.
  entry.promise = aiSearch.staleChunkCount({
    version: chunksRepo.CHUNK_PARENT_FIELDS_VERSION,
    aclFilter: acl.filter || null,
    projectIds
  })
    .then((count) => {
      // `null` is "cannot say", not a fact about the backfill — held for the schema TTL it pins an
      // unanswerable scope for ten minutes, exactly as a thrown probe would.
      if (count === null) entry.ttl = aiSearch.UNKNOWN_STATUS_TTL_MS;
      return count;
    })
    .catch((err) => {
      // The page is unaffected: this is the count behind an advisory mark, and a question that was
      // not answered leaves the page unmarked exactly as `unstamped: null` does.
      logger.warn(`[search] could not count unstamped chunks for this scope: ${err.message}`);
      entry.ttl = aiSearch.UNKNOWN_STATUS_TTL_MS;
      return null;
    });

  // Deleted first so a refresh moves the key to the end of the insertion order eviction reads.
  staleScopeCounts.delete(key);
  staleScopeCounts.set(key, entry);
  if (staleScopeCounts.size > STALE_SCOPE_CACHE_MAX) {
    staleScopeCounts.delete(staleScopeCounts.keys().next().value);
  }
  return entry.promise;
}

/**
 * Exported for tests. These counts live for the schema TTL, which outlives a whole test process —
 * without a way to clear them, whether a probe is issued at all depends on which test ran first and
 * the caching assertions would be measuring test order rather than the cache.
 */
exports.resetStaleChunkScopeCache = () => staleScopeCounts.clear();

/**
 * The OData scope for `?docIds=<pipe-separated Eagle ids>`, or null when the caller sent none.
 *
 * A PRESENT-BUT-EMPTY value matches nothing rather than everything: `docIds=` asks for a named set
 * of documents and the named set is empty, which is the same measurement `recoverChunkFilters`
 * makes when no document matches. `inClause` renders its list comma-delimited — the pipe is the
 * WIRE separator, and a document id carries neither character.
 */
function documentIdScope(raw) {
  if (raw === undefined || raw === null) return null;
  const ids = String(Array.isArray(raw) ? raw.join('|') : raw)
    .split('|').map(v => v.trim()).filter(Boolean);
  if (ids.length === 0) return "id eq ''";
  return inClause('id', ids);
}

/**
 * One filter value in EITHER wire shape — `&key=v` and `&and[key]=v` are both live, exactly as
 * `projectIdsFrom` handles both for `project`. A repeat takes the first: these are point lookups,
 * and a second value would silently pick one of two records.
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
 * One value from a query parameter `querystring.parse` may have handed back as an ARRAY — a
 * repeated key stays an array there, and a string method called on it throws.
 */
function firstValue(raw) {
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * The eagle-search wire shape for a Cosmos row: the REDACTED row as stored, plus the keys
 * eagle-public indexes on.
 *
 * Spread rather than field-by-field on purpose. These containers hold only what a mirror chose to
 * store and the catalog already decides what leaves; a hand-written field list here would be a
 * second policy that goes stale the day a mirror grows a field, and the symptom is a blank cell
 * rather than an error.
 *
 * `_id` is the EAGLE id — eagle-public keys every one of these models on it, and the mirrors store
 * that id as the row key, so the two agree today and the fallback covers a backfilled row.
 */
function cosmosRows(entity, rows, access, schemaName, decorate) {
  return redactAllForAccess(entity, rows, access).map((row) => ({
    ...row,
    _id: String(row.eagleId || row.id),
    _schemaName: schemaName,
    ...(decorate ? decorate(row) : {})
  }));
}

/**
 * Label update rows with the project each announces, under the CALLER's access — same rule as
 * `labelWithProjectNames`, one id space over: `updates.projectId` holds the EAGLE id, so the lookup
 * is `listByEagleIds` and not `listByIds`.
 *
 * ONE query for the whole page, like `labelWithProjectNames` and `periodRows`: a per-row lookup
 * made a 200-row page 200 cross-partition reads, and `pageSlice` allows a page of 1000.
 * A project this caller cannot see yields `null`, which is what eagle-api's own pipeline emits for
 * an orphaned reference (`api/controllers/recentActivity.js:86-90`) and what eagle-public's News
 * model expects.
 */
async function updateProjects(access, rows) {
  const idsOf = (field) => Array.from(new Set(rows.map(r => r[field]).filter(Boolean).map(String)));
  const eagleIds = idsOf('projectId');
  const periodIds = idsOf('pcp');
  const notificationIds = idsOf('projectNotification');

  // Redacted before anything reads a field off them, like every other repository row on this route.
  const [projectRows, periodRefs, notificationRefs] = await Promise.all([
    eagleIds.length ? projectsRepo.listByEagleIds(access, eagleIds) : [],
    periodIds.length ? commentPeriodsRepo.listByIds(access, periodIds) : [],
    notificationIds.length ? notificationsRepo.listByIds(access, notificationIds) : []
  ]).then(([p, cp, n]) => [
    redactAllForAccess('projects', p, access),
    redactAllForAccess('commentPeriods', cp, access),
    redactAllForAccess('notifications', n, access)
  ]);

  const byEagleId = new Map(projectRows.map(p => [String(p.eagleId), p]));
  const byPeriodId = new Map(periodRefs.map(p => [String(p.id), p]));
  const byNotificationId = new Map(notificationRefs.map(n => [String(n.id), n]));

  return (row) => {
    const project = row.projectId ? byEagleId.get(String(row.projectId)) : null;
    const period = row.pcp ? byPeriodId.get(String(row.pcp)) : null;
    const notification = row.projectNotification
      ? byNotificationId.get(String(row.projectNotification))
      : null;

    // `{name, _id}` and NOT eagleQuery.ref: the News model reads `project.name` and the card links
    // by `project._id`, which is the Eagle id it already holds on the row.
    //
    // `pcp` and `projectNotification` are OBJECTS or absent, never the bare id the mirror stores:
    // the News template reads `pcp.isMet` and `projectNotification.name` off them, and a string
    // answers both with undefined. Unresolved drops the key — `undefined` is not serialised — so a
    // reference this caller may not see reads as no reference at all.
    return {
      project: project ? { _id: String(project.eagleId), name: project.name } : null,
      pcp: period
        ? { _id: String(period.id), isMet: period.isMet === true, metURL: period.metURL || '' }
        : undefined,
      projectNotification: notification
        ? { _id: String(notification.id), name: notification.name }
        : undefined
    };
  };
}

/**
 * The Cosmos-backed `/search` datasets — the reads eagle-public used to make against eagle-api's
 * own `/api/search`, `/api/organization`, `/api/commentperiod`, `/api/public/comment` and
 * `/api/public/recentActivity`.
 *
 * Every one answers `{searchResults, count}` on the SAME envelope the Project bare-list branch
 * uses, so `res.json`'s wrapper attaches `meta[0].searchResultsTotal` and eagle-public can page.
 * `applied` names the filter keys the branch consumed; everything else the caller sent is reported
 * as dropped, because a filter panel that quietly does nothing returns the whole corpus.
 *
 * @returns {Promise<{searchResults: object[], count: number, applied?: string[]}>}
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
      return {
        searchResults: await periodRows(access, row ? [row] : []),
        count: row ? 1 : 0,
        applied: ['_id']
      };
    }

    // `filterQuery`, NOT `query`: `commentPeriods.projectId` holds the DEMI project id, so the
    // Eagle ObjectId eagle-public sends has to be the one `resolveProjectFilter` already translated.
    const [projectId] = eagleQuery.projectIdsFrom(filterQuery);
    if (!projectId) {
      return { searchResults: [], count: 0, applied: [] };
    }

    const [rows, count] = await Promise.all([
      commentPeriodsRepo.listByProject(projectId, access, { pageNum, pageSize, sortBy }),
      commentPeriodsRepo.countByProject(projectId, access)
    ]);
    return { searchResults: await periodRows(access, rows), count, applied: ['project'] };
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

    const [rows, count] = await Promise.all([
      commentsRepo.listByPeriod(periodId, access, { pageNum, pageSize, sortBy }),
      // The total for the WHOLE period, which is what eagle-public pages the comment table against.
      commentsRepo.countByPeriod(periodId, access)
    ]);
    return { searchResults: commentRows(access, rows), count, applied: ['period'] };
  },

  async RecentActivity({ access, query, pageNum, pageSize, sortBy }) {
    if (String(query.top) === 'true') {
      const rows = await updatesRepo.listTop(access);
      // The count IS the answer here, not a page of a larger set: `listTop` returns the whole strip.
      return {
        searchResults: cosmosRows('updates', rows, access, 'RecentActivity',
          await updateProjects(access, rows)),
        count: rows.length,
        applied: ['top']
      };
    }

    // `query`, NOT `filterQuery`: `updates.projectId` holds the EAGLE project id (the id eagle-api
    // pushed), so the translated DEMI id would match nothing. The mirror image of CommentPeriod.
    const [projectId] = eagleQuery.projectIdsFrom(query);
    // The news page searches this dataset by text. Reached with keywords only when the index is
    // switched off (see KEYWORD_INDEX_DATASETS): the container is small, so the repository answers
    // with CONTAINS — a substring match, without ranking, stemming or a half-typed last word.
    const keywords = query.keywords || query.q || '';
    const [rows, count] = await Promise.all([
      updatesRepo.list(access, { projectId, keywords, pageNum, pageSize, sortBy }),
      updatesRepo.count(access, { projectId, keywords })
    ]);
    return {
      searchResults: cosmosRows('updates', rows, access, 'RecentActivity',
        await updateProjects(access, rows)),
      count,
      applied: projectId ? ['project'] : []
    };
  },

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
  }
};

/**
 * The two Cosmos datasets a KEYWORD search is answered from the index instead.
 *
 * Only the ranking moves. The index carries ids and the text it ranks on, never the row: every row
 * a caller receives is read back from Cosmos through the same mapper the keywordless page uses, so
 * the wire shape cannot drift between the two paths and a row the index still holds but Cosmos no
 * longer admits simply drops out. Without keywords, or with the switch off, nothing here runs.
 */
const KEYWORD_INDEX_DATASETS = {
  RecentActivity: {
    index: () => aiSearch.config().activitiesIndex,
    search: (opts) => aiSearch.searchActivities(opts),
    // `?top=true` is the home-page strip, which eagle-api answers whole and by pinned-ness rather
    // than by relevance. It stays a Cosmos read whatever else the caller sent.
    cosmosOnly: (query) => String(query.top) === 'true',
    // `updates.projectId` holds the EAGLE project id, so the UNTRANSLATED ids are the ones to
    // filter with — the mirror image of the Cosmos branch. Flattened onto `project` because that
    // is the one form `buildFilter` applies.
    indexQuery: (query) => eagleQuery.withProjectIds(query, eagleQuery.projectIdsFrom(query)),
    // Same id space, one layer up: a scoped caller's DEMI ids have to become Eagle ones before the
    // OData clause compares them against this index.
    aclAccess: (access) => updatesRepo.inEagleIdSpace(access),
    aclField: 'projectId',
    rows: async (access, ids) => {
      const rows = inIdOrder(await updatesRepo.listByIds(access, ids), ids);
      return cosmosRows('updates', rows, access, 'RecentActivity',
        await updateProjects(access, rows));
    }
  },
  ProjectNotification: {
    index: () => aiSearch.config().notificationsIndex,
    search: (opts) => aiSearch.searchNotifications(opts),
    // `and[_id]` is a point read of one record, and the keywords say nothing about which one.
    cosmosOnly: (query) => filterValue(query, '_id') !== null,
    indexQuery: (query) => query,
    aclAccess: (access) => access,
    // NULL, like `notifications.SCOPE_FIELD`: a notification is not project data, so there is no
    // project axis to narrow on and role ACL is the whole filter.
    aclField: null,
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
 * The filter keys an INDEX page did not apply, in the form the Cosmos branch reports them.
 *
 * `buildFilter` names only what it could not EXPRESS; a bare key (`period`, `docIds`) never reaches
 * it at all. Both are the same fact to the caller — a filter panel that quietly does nothing — so
 * this is built from what was applied rather than from what was refused.
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
 * Once per process per dataset, like `warnUnconfigured` in ai-search and for the same reason: the
 * frontend searches on every debounced keystroke, so a per-request line would be pure noise. The
 * Cosmos path still answers — this says the ranking the caller got is not the one they asked for.
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

/** `List` and `Organization`: one container, one handler, told apart by `kind`. */
async function listRows({ access, query, pageNum, pageSize, sortBy }, kind) {
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
 * eagle-public compares `legislation === 2002`, so a row that stored the year as a string renders
 * under no legislation at all. Coerced HERE and not only in the writer, because the backfill is the
 * only writer of these rows and the ones already in the container would need re-running otherwise.
 */
function listRow(row) {
  if (row.legislation === undefined || row.legislation === null || row.legislation === '') return {};
  const year = Number(row.legislation);
  return Number.isFinite(year) ? { legislation: year } : {};
}

/**
 * A period row carries `project` as the EAGLE parent id STRING, because eagle-public's
 * CommentPeriod model reads `period.project` and passes it straight back into a project URL. The
 * stored `projectId` is the DEMI id and stays on the row beside it, never in place of it.
 *
 * The two ids are not derived from each other, so the Eagle one is READ — under the caller's own
 * access, deduplicated, and null when the parent is not visible to them.
 *
 * A period parented by a `ProjectNotification` is partitioned under the notification's own Eagle
 * id, so the second lookup answers with that id itself. Without it those rows carry
 * `project: null` and eagle-public has nothing to link them to.
 */
async function periodRows(access, rows) {
  const demiIds = Array.from(new Set(rows.map(r => r.projectId).filter(Boolean).map(String)));
  const parents = demiIds.length
    ? redactAllForAccess('projects', await projectsRepo.listByIds(access, demiIds), access)
    : [];
  const eagleIdByDemiId = new Map(parents.map(p => [String(p.id), p.eagleId ? String(p.eagleId) : null]));

  const unmatched = demiIds.filter(id => !eagleIdByDemiId.has(id));
  const notificationParents = unmatched.length
    ? redactAllForAccess('notifications',
      await notificationsRepo.listByIds(access, unmatched), access)
    : [];
  for (const parent of notificationParents) {
    eagleIdByDemiId.set(String(parent.id), String(parent.id));
  }

  return cosmosRows('commentPeriods', rows, access, 'CommentPeriod',
    (row) => ({ project: eagleIdByDemiId.get(String(row.projectId)) || null }));
}

/**
 * A notification row carries `proponent` as a NAME. Eagle stores either a name or an Organization
 * id there, and the notifications page renders the value as it arrives — an id renders as an id.
 * Resolved in one query under the caller's own access, and left as sent when nothing matches.
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
    // FORCED ON, and the wire value is deliberately ignored — see
    // wiki Search-Query-Construction#why-the-fuzzy-parameter-is-ignored. Still an ACCEPTED parameter,
    // because dropping it from unknownParams would 400 every saved URL.
    const fuzzy = true;
    // On unless the caller sends the exact string `false`: the frontend searches on debounced
    // keystrokes, so the last word is half-typed on nearly every request. Reaches Project and
    // Document only — chunk search has no half-typed word and stays off.
    const prefix = req.query.prefix !== 'false';
    // `>= 1` and NOT `Math.max(1, ... || 10)`: NaN, 0 and negatives all land on the one default
    // this endpoint documents, where the `Math.max` form would clamp -1 to a one-row page instead.
    // See wiki Search-Query-Construction#page-size-clamping.
    const parsedPageSize = parseInt(req.query.pageSize, 10);
    const requestedPageSize = parsedPageSize >= 1 ? parsedPageSize : 10;
    const pageSize = Math.min(requestedPageSize, 5000);

    // A parameter this endpoint does not read is REFUSED; a filter key the INDEX cannot express is
    // dropped and reported instead. See
    // wiki Search-Query-Construction#unsupported-parameters-400-inexpressible-filter-keys-drop.
    const unknown = eagleQuery.unknownParams(req.query);
    if (unknown.length > 0) {
      return res.status(400).json({ error: `Unsupported query parameter: ${unknown.join(', ')}` });
    }

    // Did the caller ask for a filter or a sort? Decides BOTH the page-size ceiling below and which
    // backend answers — see eagleQuery.hasCriteria for why `project` is not in it.
    const criteria = eagleQuery.hasCriteria(req.query);

    // An INDEXED page larger than the search layer will assemble is REFUSED, not truncated. All
    // three conditions are load-bearing, the `keywords` test especially — see
    // wiki Search-Query-Construction#why-large-pages-are-refused-not-truncated.
    if ((keywords || criteria || dataset === 'Document') &&
        requestedPageSize > aiSearch.MAX_PAGE_ROWS) {
      return res.status(400).json({
        // Names WHO the ceiling applies to: a bare document list is served by the index too now,
        // so this fires for a request carrying neither a filter nor a keyword.
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

    // ONE unit for the whole request: rows, counted in the caller's own `pageSize`. Skipping by the
    // service's 250-row cap instead served every page past the first twice over.
    const skip = pageNum * pageSize;

    // EVERY KEY THIS REQUEST COULD NOT EXPRESS, told to the caller and not only to the log — see
    // wiki Search-Query-Construction#the-dropped-keys-report. Accumulated through `noteDropped` so the
    // log line and the response fact cannot drift apart.
    const droppedKeys = { filter: [], sort: [] };
    const noteDropped = (kind, keys) => {
      if (!keys || !keys.length) return;
      eagleQuery.reportDropped(dataset, kind, keys);
      droppedKeys[kind].push(...keys);
    };

    // A FIELD THE LIVE INDEX COULD NOT ANSWER, told to the caller the same way `dropped` is. The
    // search layer drops such a field and retries once rather than failing the whole page (see
    // `send` in ai-search), which keeps the tab up — but a page quietly missing a column reads
    // exactly like a page whose column is empty, and on 2026-09-08 that column was the only clue.
    // ACCUMULATED, not replaced: one page can be degraded twice over — a column the live index
    // could not answer AND a filter applied over half-stamped rows — and the second call to say so
    // would otherwise erase the first.
    let degraded = null;
    const noteDegraded = (meta) => {
      if (!meta || !meta.degraded) return;
      const merged = { ...(degraded || {}), ...meta.degraded };
      // The two list-valued keys are unioned rather than overwritten; everything else is a scalar
      // the later mark owns.
      for (const key of ['missing', 'reasons']) {
        const both = [...((degraded && degraded[key]) || []), ...(meta.degraded[key] || [])];
        if (both.length) merged[key] = Array.from(new Set(both));
      }
      degraded = merged;
    };

    // The eagle envelope AND the usage event, applied once by wrapping the response rather than at
    // each of a dozen exits. `meta` is additive, and `searchResultsTotal` is emitted only where a
    // total was MEASURED — see wiki Search-Query-Construction#totals-are-measured-never-the-page-length.
    const sendJson = res.json.bind(res);
    res.json = (payload) => {
      const first = Array.isArray(payload) ? payload[0] : null;
      // KNOWN LIMIT: a future branch answering something other than `[{ searchResults }]` stops
      // being counted, silently, exactly as a missed call site would. Count on the way IN if the
      // response shape ever varies.
      if (first && Array.isArray(first.searchResults)) {
        const total = Number.isFinite(first.count) ? first.count : undefined;
        if (total === undefined) {
          logger.warn(
            `[search] ${dataset}: answering with no measured total — ` +
            'the caller is told the count is unknown rather than shown the page length as one'
          );
        }
        analyticsEvent(req, {
          eventName: 'search',
          searchTerm: keywords,
          // Left off when the total is unknown rather than filled in from the page. KNOWN LIMIT:
          // `audit.js` writes 0 for an absent ResultCount, so an unmeasured search still lands in
          // the table as a zero-result one; fixing that means a nullable column in DemiEvents_CL.
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
          // OMITTED when nothing was dropped, and carrying BOTH `.filter` and `.sort` when present
          // — see wiki Search-Query-Construction#the-dropped-keys-report.
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

    // A PROJECT FILTER THE DATASET CANNOT EXPRESS ANSWERS NOTHING, never everything: `projects` has
    // no project axis, so `buildFilter` drops the key and the request would answer the whole
    // ACL-visible corpus to a caller who asked for one project. `count: 0` is a measurement here.
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
            const { filter, dropped } = eagleQuery.buildFilter(filterQuery, dataset, acl, access);
            noteDropped('filter', dropped);

            // `Boolean(keywords)`, not `true`: with no keywords there is no relevance to order by,
            // and DEFAULT_ORDER is what keeps `$skip` paging from repeating and omitting rows.
            const { orderby, dropped: sortDropped } =
              eagleQuery.buildOrderBy(req.query.sortBy, dataset, Boolean(keywords), access);
            noteDropped('sort', sortDropped);

            // `count` is the index-wide total, not the page — eagle-public pages against it and the
            // column header shows it.
            const { items, count, meta } = await aiSearch.searchProjects({
              filter,
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
              const searchResults = items.map(hit => {
                // Redact the INDEX row, then map, exactly as the Cosmos branch below does. The
                // catalog is keyed on INDEX field names because the data source renames columns
                // (docs/rbac-architecture.md §2 item 9).
                // The index has no map type, so the dials arrive as a JSON string. A malformed one
                // fails closed to no dials — every field at its `defaultVis`, never the raw row.
                // `dialsForIndex` restates the stored keys as index ones; the data source renames
                // columns, so an untranslated dial would be inert on exactly the renamed fields.
                let dials;
                try {
                  dials = JSON.parse(hit.vis || '{}');
                } catch {
                  dials = {};
                }
                const doc = redactForAccess('index-projects', { ...hit, vis: dialsForIndex(dials) }, access);
                return {
                // THE EAGLE ObjectId — eagle-public re-fetches the project from eagle-api by it.
                // Falls back to the DEMI id for a Track-only project. See
                // wiki Search-Query-Construction#project-id-spaces.
                _id: doc.legacyEagleId || String(doc.id),
                _schemaName: 'Project',
                id: String(doc.id),
                // NULL when there is no Track counterpart, never the DEMI id. Told apart by the
                // `eagle-` id prefix the merge writes, NOT by `sourceSystem`, which is not in
                // PROJECT_SELECT. See wiki Search-Query-Construction#project-id-spaces.
                trackProjectId: String(doc.id).startsWith('eagle-') ? null : String(doc.id),
                legacyEagleId: doc.legacyEagleId || '',
                name: doc.name || doc.displayName || 'Unnamed Project',
                sector: doc.sector || 'Other',
                status: doc.status || 'Active',
                centroid: geoPoint(doc.centroid),
                region: doc.region || 'British Columbia',
                description: doc.description || 'No project description provided.',
                proponent: { name: doc.proponent || 'Proponent Organization' },
                // Rebuilt into the `{_id, name}` shape the template binds and the filter panel
                // sends, from the flat label/id pair the index stores — the same reconstruction
                // eagle-search does, so a saved filter URL means the same thing against either.
                type: doc.type || '',
                currentPhaseName: eagleQuery.ref(doc.currentPhaseNameId, doc.currentPhaseName),
                eacDecision: eagleQuery.ref(doc.eacDecisionId, doc.eacDecision),
                decisionDate: doc.decisionDate || null,
                // Eagle's own edit date, the "Last updated" column. NOT `updatedAt`, which is
                // DEMI's sync stamp and moves on every re-merge.
                dateUpdated: doc.dateUpdated || null,
                // Pre-escaped display markup from the analyzer, keyed by INDEX field. `name` falls
                // back to `displayName` the same way the plain value above does.
                highlighted: {
                  name: (doc.highlighted || {}).name || (doc.highlighted || {}).displayName || '',
                  description: (doc.highlighted || {}).description || ''
                },
                // `read[]` is NOT emitted, here or on any other row shape: it is the caller's own
                // ACL restated, it publishes internal role names, and nothing reads it. The
                // redactor drops it and derives `isPublished`, the mirror the frontends render.
                isPublished: doc.isPublished
                // No `sources`: the `projects` index has no such field.
                };
              });

              return res.json([{ searchResults, count }]);
            }

            // No rows on THIS page; `count` distinguishes an empty corpus from a page past the end
            // of a large one. Answered here rather than falling through to the keywordless Cosmos
            // read below, which ignores the keywords and returns an arbitrary page.
            return res.json([{ searchResults: [], count }]);
          }

          // Scoped to nothing. Fail closed, and do not let the unfiltered list answer instead;
          // 0 is measured, because no filter can express this caller's visibility.
          return res.json([{ searchResults: [], count: 0 }]);
        } catch (err) {
          // A FAILED search is not an empty one, and it must not become the keywordless list
          // either — see wiki Search-Query-Construction#a-failed-search-is-never-an-empty-one. The
          // status stays 502 whatever eagle-public does with it.
          logger.error(`[search] project search failed: ${err.message}`);
          return res.status(502).json(searchUnavailable(req, err, 'Project search is unavailable'));
        }
      }

      // Bare list: a read, in the repository's own order.
      try {
        // PAGED BY OVERFETCH-AND-SLICE, a real ceiling: Cosmos pages with continuation tokens, not
        // offsets, so a page is reachable only while `skip + pageSize` stays inside the repository's
        // 1000-row clamp. Every project fits one page. Upgrade path: return the token in `meta`.
        //
        // Only `project` can still be dropped here — anything else is criteria and went to the
        // index — and it is genuinely inexpressible: `projects` has no project axis.
        noteDropped('filter', eagleQuery.filterKeysIn(req.query));

        const cosmosSkip = pageNum * pageSize;
        const { items: page } = await projectsRepo.listVisible(access, {
          pageSize: cosmosSkip + pageSize
        });
        const projects = cosmosSkip > 0 ? page.slice(cosmosSkip) : page;

        // Counted on EVERY request. Running it only when `pageNum` was present let the response
        // wrapper fill the gap with the page length, so `pageSize=500` with no `pageNum` — DEMI's
        // own frontend — reported 500 for a registry of any size.
        const count = await projectsRepo.countVisible(access);

        // A NoSQL row has `id` and no `_id`. `_id` is kept in the RESPONSE because the frontend
        // still keys on it — dropping it would empty the project list without any error.
        const mapped = projects.map(p => {
          // Redact the repository ROW, then map. The mapper below emits eagle-search wire names
          // (`_id`, `proponent.name`, `location`), so the catalog must never run over its output
          // (docs/rbac-architecture.md §2 item 9).
          const row = redactForAccess('projects', p, access);
          return {
            // The Eagle id, for the same reason as the AI Search branch above.
            _id: row.eagleId || String(row.id),
            _schemaName: 'Project',
            id: String(row.id),
            // NULL when absent, NOT the DEMI id, and a String to match the index branch. `== null`
            // and not `||`, because Track id 0 is falsy. See
            // wiki Search-Query-Construction#project-id-spaces.
            trackProjectId: row.trackProjectId == null ? null : String(row.trackProjectId),
            // COSMOS FIELD NAMES, not the indexer's aliases. Reading `p.status` here was always
            // undefined, so `|| 'Active'` fired on every row and asserted that every project in the
            // registry is Active. See wiki Search-Index-Reference#cosmos-and-index-field-names-differ.
            legacyEagleId: row.eagleId || '',
            name: row.name || 'Unnamed Project',
            sector: row.sector || 'Other',
            // ONE stored name: the writers now rename at the edge (`controllers/nosql/project.js`),
            // so `status` is a wire name only and no row can carry it.
            status: row.projectState || 'Active',
            // Same helper as the AI Search branch — one definition of the fallback centroid.
            centroid: geoPoint(row.centroid),
            region: row.region || 'British Columbia',
            // `location` on the wire, `address` at rest: the merge renames Eagle's `location` on the
            // way in, and nothing read it back. THE COSMOS BRANCH ONLY — `address` is not a column of
            // the `projects` index, so the two mappers disagree about this one field until it is.
            location: row.address || '',
            description: row.description || 'No project description provided.',
            proponent: { name: row.proponentName || 'Proponent Organization' },
            // THE COSMOS BRANCH ONLY, same as `location` above: `eaCertificate` is not a column of
            // the `projects` index, so a keyword search carries no certificate number.
            eaCertificate: row.eaCertificate || null,
            // Cosmos field names again: `p.type` would be undefined on every row of the DEFAULT
            // view, the one a visitor lands on before typing a keyword.
            type: row.projectType || '',
            currentPhaseName: eagleQuery.ref(row.currentPhaseName?._id, row.currentPhaseName?.name),
            eacDecision: eagleQuery.ref(row.eacDecision?._id, row.eacDecision?.name),
            decisionDate: row.decisionDate || null,
            // Same column as the index branch above, so both project shapes answer it.
            dateUpdated: row.dateUpdated || null,
            // 'public' in the read ACL is what makes a record public; isPublished mirrors it, and
            // the redactor derives it. The frontend derives its staged/admitted badge from this.
            isPublished: row.isPublished,
            // Only DEMI's own wildfire aggregate. The raw Track and Eagle payloads sharing this
            // field are traceability, not API surface — the catalog publishes `sources.wildfire`
            // and nothing else.
            sources: row.sources || {}
          };
        });

        return res.json([{ searchResults: mapped, count }]);
      } catch (cosmosErr) {
        // See the keyword branch above: a search that FAILED is not a search that found nothing.
        // 200 with `[]` told every visitor of /projects that the EA registry contains no projects.
        logger.error(`[search] project list failed: ${cosmosErr.message}`);
        return res.status(502).json(searchUnavailable(req, cosmosErr, 'Project search is unavailable'));
      }
    } else if (dataset === 'Document') {
      // EVERY document read is answered by the index — NOT the Project rule, and the difference is
      // paging: the Cosmos read could not page past its 1000-row clamp, and there is no fallback
      // under this. See wiki Search-Query-Construction#every-document-read-goes-to-the-index.
      try {
        const acl = documentsAcl(access);
        // Projects are scoped on their own id; the same caller, a different index.
        const projectScope = filterFor(access, 'id');

        if (!acl.empty) {
          const { filter, dropped } = eagleQuery.buildFilter(filterQuery, dataset, acl, access);
          noteDropped('filter', dropped);

          // `?docIds=a|b|c` — eagle-public's multi-id document fetch (api.ts getDocumentsByMultiId),
          // pipe-joined because `buildValues` joins on `|`. ANDed onto the filter as one clause
          // through the same `inClause` the ACL uses; `search.js:137` builds a similar scope over
          // the CHUNKS index `documentId`, and this one is the DOCUMENTS index key `id`.
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
            // Rows in the caller's own `pageSize`, computed once above and shared with every other
            // index read. The service's own `$skip` ceiling of 100,000 binds on ROWS and the corpus
            // cannot reach it, so nothing enforces it here; revisit as the count approaches it.
            skip,
            // Passed so the project-name leg runs under the caller's project visibility. Undefined
            // would disable that leg; null legitimately means "unrestricted".
            projectFilter: projectScope.empty ? undefined : projectScope.filter,
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
              // No `s3Key` basename to fall back to — the index carries no such field. Measured
              // before dropping it: 0 of 2,000 sampled documents render this placeholder.
              documentFileName: doc.documentFileName || 'document.pdf',
              documentType: doc.type || 'PDF Document',
              // Emitted because search-diff no longer accepts them as eagle-only columns.
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
        // Same rule as the project branch: a search that failed is not a search that found nothing,
        // and there is nothing to fall through to now.
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
        // The visibility filter is evaluated BY THE SERVICE alongside the match, so ranking is
        // computed only over rows this caller may read. Roles come from the verified token only.
        // A chunk carries its document as `documentId`; its own id is not filterable.
        const acl = filterFor(access, 'projectId', 'documentId');

        // Fail-closed, and it MUST short-circuit here: OData has no `false` literal, so issuing the
        // request with no filter would return everything.
        if (acl.empty) {
          return res.json([{ searchResults: [], count: 0 }]);
        }

        // THE FOUR FACETS GO STRAIGHT ONTO THE CHUNK QUERY — every chunk carries a copy of its
        // parent's ids — but only once this request's own rows are stamped. A facet the live index
        // does not carry, or carries over rows the backfill has not reached, is made INEXPRESSIBLE
        // rather than deleted, so it lands in `dropped` and the recovery below still answers it.
        const { unavailable, unstampedScope, unknownScope, missingColumn } =
          await liveChunkFacets(filterQuery, acl, eagleQuery.projectIdsFrom(filterQuery));

        const { filter, dropped } = eagleQuery.buildFilter(
          filterQuery, dataset, acl, access, { unexpressible: unavailable });

        // Reported only for what STAYED dropped: a recovered key is one that worked.
        const { scope, recovered, capped } = await recoverChunkFilters(filterQuery, dropped, access);
        noteDropped('filter', dropped.filter(key => !recovered.includes(key)));
        // `filter` is UNDEFINED for an unscoped privileged caller — an unfiltered read, not an
        // empty one — and a bare template over it emits `(undefined) and …`, a 400 this route
        // answers as 502.
        const scopedFilter = scope
          ? (filter ? `(${filter}) and ${scope}` : scope)
          : filter;

        // THE SECOND DEGRADED STATE, and it is now the state with NOWHERE LEFT TO GO. A facet
        // withheld because this scope is mid-backfill is answered through the documents index
        // instead, which is correct and complete up to the scope cap — nothing to mark. Only when
        // that recovery is over the cap as well does the caller get a short answer, and only then
        // is there something to say. The REASON only, never the count: this route answers
        // anonymously.
        //
        // THREE REASONS, because three different things clear them: the backfill finishing, the
        // service answering again, and an operator applying the index definition. Any of them can
        // be true at once. Without the third, a short page in a deploy window carried no reason at
        // all, which on the wire is an ordinary over-cap drop — the one shape that tells the caller
        // nothing is coming.
        // See wiki Search-Query-Construction#deep-search-can-be-degraded-three-ways.
        if (capped) {
          const reasons = [];
          if (unstampedScope) reasons.push('chunk-parent-fields-unstamped');
          if (unknownScope) reasons.push('chunk-parent-fields-unknown');
          if (missingColumn) reasons.push('chunk-parent-fields-missing');
          if (reasons.length) noteDegraded({ degraded: { reasons } });
        }

        // A `sortBy` reaching this line is always dropped: every field in `chunks` is
        // `sortable: false`, so `buildOrderBy` is called for its drop list and nothing else. Not on
        // every request — the keywordless return above fires first and reports no `dropped` at all.
        noteDropped('sort', eagleQuery.buildOrderBy(req.query.sortBy, dataset, Boolean(keywords), access).dropped);

        // A PAGE OF DOCUMENTS COSTS A WINDOW OF CHUNKS, so the window is the paging unit too and
        // `pageSize` is a fetch knob for this dataset, not a row count. See
        // wiki Search-Query-Construction#chunk-paging-is-a-window.
        const chunkWindow = groupChunks.windowFor(pageSize, aiSearch.SERVICE_MAX_TOP);
        const { items, count, meta } = await aiSearch.searchChunks({
          filter: scopedFilter,
          // No `orderby`: every field in `chunks` is `sortable: false`, the key included, and
          // naming a non-sortable field is a 400. Chunk pages are relevance-ordered with no
          // tiebreak, which makes a deep chunk page unstable.
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

        // Chunks carry ids, not labels. Hydrated in two bounded reads under the CALLER's access,
        // never systemAccess(), so a name cannot outlive the ACL of the row it describes.
        const documentIds = items.map(c => c.documentId);
        const projectIds = items.map(c => c.projectId);
        const [parentDocs, parentProjects] = await Promise.all([
          documentsRepo.listByIds(access, documentIds, projectIds),
          projectsRepo.listByIds(access, projectIds)
        ]);
        // Redacted before the mapper reads a label off either row. `id` is 4/4 in both catalogs, so
        // the document map is still the gate below.
        const docById = new Map(redactAllForAccess('documents', parentDocs, access)
          .map(d => [String(d.id), d]));
        const projById = new Map(redactAllForAccess('projects', parentProjects, access)
          .map(p => [String(p.id), p]));

        // THE GATE, not a label lookup: a caller who cannot see the document cannot see its text.
        // `listByIds` is ACL-enforcing and unbounded, so a miss means DENIED, not truncated. See
        // wiki Search-Query-Construction#the-parent-document-is-the-chunk-gate.
        const visible = items.filter(chunk => docById.has(String(chunk.documentId)));
        if (visible.length !== items.length) {
          logger.warn('[search] withheld chunks whose parent document is not visible', {
            withheld: items.length - visible.length, returned: visible.length
          });
        }

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
            // The date and milestone chips, from the SAME parent this mapper already holds. It
            // builds its row field by field, so a column nobody names here never reaches
            // `groupByDocument`. `milestone` is the LABEL and `milestoneId` the id — prod's shape,
            // and not the Document dataset's; see `group-chunks.js`.
            milestone: (parent && parent.milestone) || null,
            milestoneId: (parent && parent.milestoneId) || null,
            datePosted: (parent && parent.datePosted) || null,
            pageNumber: chunk.pageNumber ?? 0,
            // Empty by design: `content` is not retrievable from the index, so the API never ships
            // whole chunks. The UI renders `snippet` and falls back to `content` only without one.
            content: '',
            // Already escaped, with only the <mark> tags this layer added — chunk text comes from
            // arbitrary uploaded PDFs and the UI renders it with [innerHTML].
            snippet: chunk.snippet || ''
          };
        });
        // The index-wide total for this query, reported net of what this page withheld — see
        // wiki Search-Query-Construction#the-parent-document-is-the-chunk-gate. Added only to the success
        // path: absent means "not measured", where a 0 would be a claim about the index.
        // GROUPED AFTER THE GATE, never before: a withheld chunk must not contribute a snippet or a
        // match to a document row.
        const grouped = groupChunks.groupByDocument(mappedChunks);

        const withheld = items.length - visible.length;
        return res.json([{
          searchResults: grouped,
          // Still the PASSAGE total — `meta.countsPassages` says so, and the rows are documents.
          // Floored at `visible.length`, not `grouped.length`: one row can carry a dozen matches.
          count: withheld > 0 ? Math.max(count - withheld, visible.length) : count
        }]);
      } catch (err) {
        // An empty result caused by a fault is NOT the same fact as "nothing matched", and the
        // status code is the only place that difference can be said. DEMI's chunk leg already
        // renders a non-2xx as an unknown count.
        logger.error(`[search] chunk search failed: ${err.message}`);
        return res.status(502).json(searchUnavailable(req, err, 'Deep Search is unavailable'));
      }
    } else if (COSMOS_DATASETS[dataset]) {
      // A KEYWORD search over one of the two indexed datasets is ranked by the index; everything
      // else here is a Cosmos list read. See KEYWORD_INDEX_DATASETS for why only the ranking moves.
      const indexed = keywords ? KEYWORD_INDEX_DATASETS[dataset] : null;
      if (indexed && !indexed.cosmosOnly(req.query)) {
        // The kill switch: an unset SEARCH_ENDPOINT, or an app setting that is absent or emptied
        // for this one dataset. Falls through to the Cosmos read below rather than failing — that
        // read answers keywords too, on CONTAINS instead of BM25.
        if (!aiSearch.config().configured || indexed.index() === '') {
          warnKeywordFallback(dataset);
        } else {
          // What the INDEX attempt reported dropped, so a fallback can put it back: the page the
          // caller receives is the Cosmos one, and it reports its own keys below.
          const notedBefore = { filter: droppedKeys.filter.length, sort: droppedKeys.sort.length };
          try {
            const acl = filterFor(await indexed.aclAccess(access), indexed.aclField);
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

            // `count` is the index-wide total, as on every other indexed branch. The page can be
            // shorter than the index promised — a row whose Cosmos ACL no longer admits it drops
            // out at the read — and that is the fail-closed direction.
            const searchResults = await indexed.rows(access, items.map(hit => String(hit.id)));
            return res.json([{ searchResults, count }]);
          } catch (err) {
            // THE SWITCH THE SETTING COULD NOT THROW. A setting naming an index that was never
            // created 404s on every query, and no configuration this app can read says so — which
            // is how test served 502s to every keyword search over these two datasets. Falls
            // through to the Cosmos read below, like an emptied setting does.
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

      // The reads eagle-public used to make against eagle-api. The guard chain is the Project
      // bare-list branch's — one measured count per request, every row through the catalog, and a
      // 502 on failure because a read that FAILED is not a read that found nothing.
      try {
        const result = await COSMOS_DATASETS[dataset]({
          access, query: req.query, filterQuery, pageNum, pageSize, sortBy: req.query.sortBy
        });

        // A branch that refuses the request rather than answering it — see the Comment branch.
        if (result.error) return res.status(400).json({ error: result.error });

        // Everything the caller asked to filter on that this branch did NOT consume. `project` is
        // already handled by the canScopeToProject guard above for the datasets that cannot express
        // it, so anything left here is a key the container has no axis for.
        const applied = new Set(result.applied || []);
        noteDropped('filter', eagleQuery.filterKeysIn(req.query).filter(key => !applied.has(key)));

        return res.json([{ searchResults: result.searchResults, count: result.count }]);
      } catch (err) {
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
const COUNTS_DATASETS = ['Project', 'Document', 'RecentActivity', 'ProjectNotification'];

/**
 * EVERY parameter `/search/counts` reads, and the whole gate — not a widening of the `/search` set.
 *
 * Filters are per record type and this endpoint counts all four at once, so there is no filter it
 * could honour. `and[type]=Letter`, `dataset`, `pageSize`, `sortBy` and the rest are REFUSED here
 * rather than accepted and dropped: a badge answered under a filter the caller believes was
 * applied is a wrong number with nothing to say so.
 */
const COUNTS_PARAMS = new Set(['keywords', 'q', 'prefix', 'datasets']);

/**
 * How long one caller's badge row is reused. The page asks on a debounced keystroke, and four
 * index counts per pause against a 1-SU service is the cost this exists to bound. Short enough
 * that a newly published record shows up within a page view.
 */
const COUNTS_TTL_MS = 45 * 1000;

/** Entries kept. One per distinct keyword/access pair, evicted oldest-first. */
const COUNTS_CACHE_MAX = 200;

/** key -> `{at, promise}`. The PROMISE is cached, not the value, which is what dedupes in flight. */
const countsCache = new Map();

exports.resetCountsCache = () => countsCache.clear();

/**
 * What makes two callers' counts the same counts.
 *
 * Every input `filterFor` and `updatesRepo.inEagleIdSpace` read, so two callers sharing a
 * fingerprint provably share every ACL clause below. Deliberately over-specific — a field that
 * turns out not to affect the filter costs a cache miss, while a missing one would serve one
 * caller's counts to another. Anonymous callers all produce the same string and share one entry.
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
 * One count per record type. A leg answers `{count}` — `null` where it could not MEASURE one, which
 * is not the same fact as 0 and is published as "unknown" rather than as an empty tab.
 *
 * `degraded: true` marks a count the INDEX did not answer: the Cosmos fallback matches on CONTAINS,
 * so its number is a different question's answer and the caller is told so.
 */
const COUNT_LEGS = {
  async Project({ access, keywords, prefix }) {
    // 'id', not 'projectId': a project IS its own scope. Same clause the Project branch builds.
    const acl = filterFor(access, 'id');
    // OData cannot express a filter that matches nothing, and 0 here is measured — see filterFor.
    if (acl.empty) return { count: 0 };
    return {
      count: await aiSearch.countProjects({
        filter: acl.filter, keywords, matchAll: !keywords, fuzzy: true, prefix
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
      filter: acl.filter,
      projectFilter: projectScope.empty ? undefined : projectScope.filter,
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
        // The index holds EAGLE project ids, so a scoped caller's DEMI ids are translated first —
        // the same step the keyword branch of `/search` takes.
        const acl = filterFor(await updatesRepo.inEagleIdSpace(access), 'projectId');
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
  }
};

/**
 * Every badge, in parallel, one failure at a time. `allSettled` because a tab whose index is down
 * must not take the other three with it — the page shows three numbers and one blank, never a 500.
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
 * `GET /api/search/counts?keywords=&prefix=&datasets=…` — the record-type badges on one request.
 *
 * ALL FOUR are computed whatever `datasets` names, and the cache key says nothing about them: the
 * page asks for all four on every pause, so a narrower request is served from the same entry rather
 * than splitting the cache into subsets that each pay full price. `datasets` slices the answer.
 *
 * No `Cache-Control`, which is what `/search` sends: these counts are ACL-scoped, and a shared cache
 * in front of them would serve one caller's totals to another.
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
    // A REPEATED `keywords` takes the first value, as every other repeated key on this API does:
    // `.trim()` on the array `querystring.parse` hands back would be a 500 on a 200-shaped request.
    const keywords = String(firstValue(req.query.keywords || req.query.q) || '')
      .trim().replace(/\s+/g, ' ');
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
 * `GET /api/search/summary?keywords=…` — step 5 of the pipeline. See wiki ADR-006 and
 * Search-Query-Construction#the-summary-endpoints-gates.
 *
 * PRIVILEGED ONLY: mounted on `authMiddleware`, so anonymous callers get a 401 and never reach here.
 * Retrieval is the SAME BM25 call the results columns already made; this adds a step after it.
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

    // The second and third of THREE load-bearing gates: `getById` re-applies the ACL at the
    // database, and the parent-document read is the same gate the chunk search path applies — a
    // chunk's own `read[]` is an ingest-time snapshot and can outlive its parent's visibility. See
    // wiki Search-Query-Construction#the-summary-endpoints-gates.
    //
    // `listByIds` is the read the citations were already hydrated from, moved ahead of the model
    // call and widened, so this costs no latency.
    const [fetched, parentDocs] = await Promise.all([
      Promise.all(items.map(c => chunksRepo.getById(access, String(c.chunkId), String(c.documentId)))),
      documentsRepo.listByIds(access, items.map(c => c.documentId), items.map(c => c.projectId))
    ]);
    // Redacted before `citations` reads a name off it; `id` is 4/4, so this stays the parent gate.
    const docById = new Map(redactAllForAccess('documents', parentDocs, access)
      .map(d => [String(d.id), d]));

    // The chunk rows are redacted too, and every METADATA field the response carries reads off the
    // redacted row below, not off `items` (the raw AI Search hit, never gated by the chunk catalog).
    // `content` is maxVis 0 and does not survive that — deliberately: it is never a response field,
    // so it is read off the raw `fetched` row, the model call below being its only consumer, gated
    // by the parent document above.
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

    // Logged like the chunk-SEARCH path: a withheld count here is the visible symptom of a stale
    // chunk ACL. An empty `row.content` lands in the same count, so a non-zero withheld is not
    // proof of an ACL problem on its own.
    if (chunks.length !== items.length) {
      logger.warn('[search/summary] withheld chunks whose parent document is not visible or whose text is empty', {
        withheld: items.length - chunks.length, returned: chunks.length
      });
    }

    const { summary, citations, reason, usage, estimatedCostCad } =
      await summarizer.summarize(keywords, chunks);

    // Hydrate ONLY the chunks the model actually cited, under the CALLER's access and never
    // systemAccess(). One read, not two: the documents are already in `docById`, which also makes
    // the 'Untitled Document' fallback below unreachable on this path.
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
