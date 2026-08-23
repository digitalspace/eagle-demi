'use strict';

// All three datasets search Azure AI Search. The KEYWORDLESS path — listing projects or documents,
// which is a read rather than a search — goes to the Cosmos NoSQL repositories. It used to go to
// the Mongo-API models; that was the last data-layer split in this file and it is gone.
const { resolveAccess } = require('../helpers/access-sql');
const { logger } = require('../utils/logger');
const { filterFor } = require('../helpers/access-odata');
const aiSearch = require('../search/ai-search');
const eagleQuery = require('../search/eagle-query');
const groupChunks = require('../search/group-chunks');
const documentsRepo = require('../repositories/documents');
const projectsRepo = require('../repositories/projects');
const chunksRepo = require('../repositories/chunks');
const summarizer = require('../ai/summarize');
const { analyticsEvent } = require('../utils/audit');
const config = require('../config');

/**
 * A stored GeoJSON point as the frontend wants it: `[lng, lat]`.
 *
 * AI Search returns `{type: 'Point', coordinates: [lng, lat]}`, which is exactly how Cosmos stores
 * it, so nothing is swapped here. Typesense's geopoint type was lat-first, which is why this file
 * used to guess the orientation from the sign of the first number — a heuristic that worked only
 * because British Columbia is west of Greenwich. It is gone.
 */
function geoPoint(centroid) {
  const coords = Array.isArray(centroid) ? centroid : centroid && centroid.coordinates;
  if (!Array.isArray(coords) || coords.length !== 2) return [-125.0, 54.0];
  const [lng, lat] = coords.map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return [-125.0, 54.0];
  return [lng, lat];
}

/**
 * A `List` reference as eagle-public's templates want it: `{_id, name}`, or null.
 *
 * NULL, NOT `{}`, when the project has neither. 34 of the 382 projects in test carry no phase and
 * the same 34 carry no decision, so this is the common path, not an edge; the template guards with
 * `rowData.currentPhaseName?.name || '-'` and an object with an undefined `name` prints an empty
 * cell where a dash is what the column means.
 */
function listRef(id, name) {
  if (!id && !name) return null;
  return { _id: id ? String(id) : '', name: name || '' };
}

/**
 * Label document rows with their project, under the CALLER's access — never systemAccess(),
 * a label must not outlive the ACL of the row it describes.
 *
 * Rows arrive with `project` holding the DEMI project id and leave with the `{_id, name}` pair
 * eagle-public's templates bind — `rowData.project.name` and `[routerLink]="['/p',
 * rowData.project._id, …]"` in `search-document-table-rows.component.html:8-10`, which are the only
 * UNGUARDED object derefs in any of its row templates. `_id` is the EAGLE id, because that is what
 * eagle-api's `/api/project/{id}` route accepts; it comes from the same read that fetches the name,
 * so translating ids costs nothing beyond one more projected field.
 *
 * MISS CASE, and it is reachable: a project this caller cannot read, or one seeded with no Eagle
 * counterpart, yields `{_id: <DEMI id>, name: 'Associated Project'}`. The row still returns — this
 * is a label, not a gate (the gate for chunks is the parent DOCUMENT, below) — and the link points
 * at an id eagle-api will not resolve. A missing `project` object would throw inside Angular's
 * template evaluation and take out every render of the row instead.
 */
async function labelWithProjectNames(access, docs) {
  const projectIds = docs.map(d => d.project).filter(Boolean);
  if (projectIds.length === 0) return;
  const parents = await projectsRepo.listByIds(access, projectIds);
  const byId = new Map(parents.map(p => [String(p.id), p]));
  for (const doc of docs) {
    const parent = byId.get(String(doc.project));
    doc.projectName = (parent && parent.name) || 'Associated Project';
    // The DEMI project id, KEPT — `project` is about to stop carrying it. This is the row's Cosmos
    // partition key and the id-space DEMI's own frontend compares against `Project.id`
    // (`registry-state.service.ts:1268` feeds `filteredDocuments` at :446 and
    // `map-explorer.component.ts:562`); `project._id` below is the EAGLE ObjectId, because that is
    // what eagle-api's routes accept. Deriving one field from the other means one of those two
    // consumers is comparing across id-spaces and silently matching nothing — which is what
    // happened when `project` changed shape and DEMI's frontend followed it: the document counts
    // on the map explorer went to zero for every project.
    doc.projectId = String(doc.project);
    doc.project = eagleQuery.ref((parent && parent.eagleId) || doc.project, doc.projectName);
  }
}

/** An Eagle ObjectId. DEMI project ids are Track integers or `eagle-<ObjectId>`, so this cannot collide. */
const EAGLE_OBJECT_ID = /^[0-9a-f]{24}$/i;

/**
 * Rewrite `&project=`/`&and[project]=` from Eagle ObjectIds into DEMI project ids.
 *
 * The indexes hold DEMI project ids on documents and chunks, and comparing an Eagle ObjectId
 * against one matches nothing — which renders as an empty project tab rather than as an error. The
 * translation is a read rather than a rename, so it happens here and never inside `buildFilter`.
 *
 * NOT reindexed and NOT cached: the parent-project read that labels every row already runs on this
 * path, so the outgoing direction is free, and this incoming one is a single bounded query on the
 * requests that carry a project filter. A cached map would add a staleness window on a container
 * the Track sync writes to, in exchange for one query per filtered request.
 *
 * @returns {{query: object, resolved: boolean}} resolved false = the caller named a project that
 *   does not exist or that they may not read. The route must answer with NO rows: dropping an
 *   unresolvable project filter would answer the whole corpus to a request that asked for one
 *   project's documents.
 */
async function resolveProjectFilter(access, query) {
  const requested = eagleQuery.projectIdsFrom(query);
  if (requested.length === 0) return { query, resolved: true };

  const demiIds = [];
  for (const id of requested) {
    if (!EAGLE_OBJECT_ID.test(id)) {
      demiIds.push(id);
      continue;
    }
    const project = await projectsRepo.getByEagleId(access, id);
    if (!project) return { query, resolved: false };
    demiIds.push(String(project.id));
  }

  return { query: eagleQuery.withProjectIds(query, demiIds), resolved: true };
}

exports.search = async (req, res) => {
  try {
    const dataset = req.query.dataset;
    const keywords = req.query.keywords || req.query.q || '';
    // FORCED ON, and the wire value is deliberately ignored. eagle-public hard-codes `fuzzy=false`
    // on every search it sends (`services/search.service.ts:206` default, serialised at
    // `services/api.ts:196`) and eagle-search has always ignored that and fuzzed anyway
    // (`eagle-search/service/search/query-builder.js:12-14`), so honouring the parameter here made
    // demi answer a strictly smaller result set than the service it replaces: `keywords=caribou`
    // returned 1 project against demi and 3 against prod eagle-search, and the misspelling a fuzzy
    // search exists for returned 0 against 1.
    //
    // Safe because the fuzzy arm cannot outrank the exact one: `buildQuery` emits
    // `(term OR term~1^0.5)`, so the expansion only surfaces where nothing matched verbatim. The
    // parameter stays ACCEPTED — dropping it from unknownParams' list would 400 every saved URL —
    // it simply no longer decides anything.
    const fuzzy = true;
    const requestedPageSize = parseInt(req.query.pageSize || '10', 10);
    const pageSize = Math.min(requestedPageSize, 5000);

    // A parameter this endpoint does not read is refused, not ignored. `page=2` for `pageNum=1`,
    // or a filter key nobody parses, answers 200 with page one or the whole corpus — a wrong page
    // that looks completely fine. A filter key the INDEX cannot express is the other case and is
    // dropped-and-logged instead; see eagle-query.js.
    const unknown = eagleQuery.unknownParams(req.query);
    if (unknown.length > 0) {
      return res.status(400).json({ error: `Unsupported query parameter: ${unknown.join(', ')}` });
    }

    // Did the caller ask for a filter or a sort? Computed once, here, because it decides BOTH the
    // page-size ceiling below and which backend answers — see eagleQuery.hasCriteria for why
    // `project` is not in it.
    const criteria = eagleQuery.hasCriteria(req.query);

    // An INDEXED page larger than the search layer will assemble is REFUSED, not truncated.
    // `ai-search.runSearch` fills a page with consecutive 250-row requests up to MAX_PAGE_ROWS.
    // Beyond it the honest answers are a 400 or twenty round trips per keystroke against a 1-SU
    // service; the one answer that is NOT available is the one this replaces — 250 rows returned
    // under a total in the thousands, with nothing to tell the caller that the rest of the page
    // they asked for was dropped.
    //
    // `keywords &&` is load-bearing, and the reason is not that 500 is everyone's ceiling. It is
    // eagle-public's "Show All" ceiling for TABLE pages (`MAX_SHOW_ALL_ITEMS`), but two live
    // callers ask for a million rows outright — `storage.service.ts` and `projects.component.ts`
    // both call `getAllFull(1, 1000000)` for the projects map. Those are KEYWORDLESS, so they take
    // the Cosmos list path, which has its own cap, and this guard never sees them. A keyword search
    // at that size would be a different request with a different cost, which is why only that one
    // is refused. Do not "simplify" this by dropping the keyword test.
    //
    // `|| criteria` because a FILTERED keywordless search now takes the same path and inherits the
    // same ceiling. The keyword test still has to be there, and dropping it is still wrong: the two
    // million-row callers send no keywords AND no criteria (`storage.service.ts` and
    // `projects.component.ts` both call `getAllFull(1, 1000000)` with an empty `sortBy` twice over),
    // so they stay on the Cosmos list path and this guard still never sees them.
    if ((keywords || criteria) && requestedPageSize > aiSearch.MAX_PAGE_ROWS) {
      return res.status(400).json({
        error: `pageSize above ${aiSearch.MAX_PAGE_ROWS} is not supported for a filtered or keyword search`
      });
    }

    // 0-BASED on the wire, deliberately: eagle-public's `currentPage` is 1-based and `api.ts:173`
    // sends `pageNum - 1`. A bare `ProjectService.getAll()` sends `-1` outright, so this floors
    // rather than trusting it.
    const pageNum = Math.max(0, parseInt(req.query.pageNum || '0', 10) || 0);

    // One access context for the whole request. Both the AI Search filter and the Cosmos
    // predicate are derived from it, so the indexed and the unindexed path cannot disagree
    // about what this caller may see.
    const access = resolveAccess(req);

    // ONE unit for the whole request: rows, counted in the caller's own `pageSize`. This used to
    // skip by `min(pageSize, 250)` — the search service's per-request cap — while the client paged
    // in `pageSize`, so every page past the first was wrong for any page over 250: `pageSize=500,
    // pageNum=2` asked the index for row 250 where the client meant row 1000, and the rows in
    // between were served twice. Reachable from eagle-public's "Show All" (500), which is why the
    // cap now bounds a REFUSAL above and never the offset.
    const skip = pageNum * pageSize;

    // Usage analytics AND the eagle envelope, applied once by wrapping the response rather than at
    // each exit — this handler has a dozen `return res.json(...)` points and a call at every one of
    // them is a call that quietly stops happening the next time a branch is added. Only shapes that
    // look like a search answer are touched, so an error payload is not recorded as a zero-result
    // search: zero-result searches are the most useful thing in this table and must stay believable.
    //
    // `meta` is ADDITIVE. DEMI's own frontend reads `[0].searchResults` and `[0].count`
    // (registry-state.service.ts:1153-1176) and never iterates keys, so it does not see this;
    // eagle-public reads `res[0].data.meta[0].searchResultsTotal`. It USED to crash without it:
    // at eagle-public 7187eac, `project.service.ts` dereferenced `meta[0]` unguarded and the
    // TypeError was re-thrown through two catchErrors into `projects.component.ts`, navigating the
    // visitor off /projects to the home page. That deref is now optional-chained there, so this is
    // no longer load-bearing against a crash — but it stays, because the guard lives in the
    // consumer and this is the producer's own contract. Deployed eagle-public is still the
    // unguarded version until that change ships. So one meta object is emitted ALWAYS, including
    // on the empty branches — but `searchResultsTotal` inside it is emitted only where a total was
    // actually MEASURED. Absent means "not measured"; `searchResultsTotal: 0` alongside zero rows
    // is a claim about the index, and the page length is neither.
    //
    // THE PAGE LENGTH IS NEVER THE TOTAL. It used to be the fallback here, and DEMI's own frontend
    // is the caller that proved it: `registry-state.service.ts` asks for `pageSize=500` with no
    // `pageNum`, the Cosmos branches skipped their count for exactly that request shape, and a
    // corpus of any size reported 500. eagle-public divides this number by its own page size to
    // decide how many pages exist, so a page-length total says "one page" and makes every later
    // page unreachable. Every branch below now carries its own measured count; this guard is what
    // stops a future one from re-introducing the synthesis silently.
    const sendJson = res.json.bind(res);
    res.json = (payload) => {
      const first = Array.isArray(payload) ? payload[0] : null;
      // KNOWN LIMIT: this shape guard relocates the very problem the wrapper solves. A future
      // branch that answers with something other than `[{ searchResults }]` stops being counted
      // silently, exactly as a missed call site would. It is the lesser evil — an error payload
      // counted as a zero-result search would corrupt the one number this table is for — but if
      // the response shape ever varies, count on the way IN instead of on the way out.
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
          // the table as a zero-result one — the same ambiguity, one layer down. It is reachable
          // only if a branch stops reporting its count (every branch here reports one), and fixing
          // it properly means a nullable column in DemiEvents_CL, which is a schema change.
          resultCount: total,
          detail: { dataset, fuzzy, pageSize }
        });
        first.meta = [{
          ...(total === undefined ? {} : { searchResultsTotal: total }),
          // Chunk rows are PASSAGES, not documents: the total counts fragments and several can come
          // from one file. eagle-search flags it the same way so a caller cannot mistake the number
          // for a document count.
          ...(dataset === 'DocumentChunk'
            ? { countsPassages: true, documentsOnPage: first.searchResults.length }
            : {})
        }];
      }
      return sendJson(payload);
    };

    // Project filters arrive as Eagle ObjectIds and the indexes hold DEMI project ids. Resolved
    // once for every dataset, before any filter is built, because the translation is a read.
    const { query: filterQuery, resolved } = await resolveProjectFilter(access, req.query);
    if (!resolved) {
      // `count: 0` is a MEASUREMENT here, not a synthesis: the caller named a project that does not
      // exist or that they may not read, so no row can match it and nothing was left unqueried.
      return res.json([{ searchResults: [], count: 0 }]);
    }

    if (dataset === 'Project') {
      // Keywords OR criteria go to AI Search; a BARE list still comes from Cosmos below, because
      // listing every project in the repository's own order is a read, not a search, and the index
      // adds nothing to it. A filter or a sort is the opposite: Cosmos list criteria and order are
      // fixed, so answering one from there means answering the whole corpus.
      if (keywords || criteria) {
        try {
          // 'id', not 'projectId' — a project IS its own scope, and scoping on a field the index
          // does not have would match nothing while looking like an empty corpus.
          const acl = filterFor(access, 'id');

          if (!acl.empty) {
            // The caller's `and[...]` filters COMPOSED WITH the ACL clause, never instead of it —
            // buildFilter takes the whole `filterFor` result and refuses to run without it.
            const { filter, dropped } = eagleQuery.buildFilter(filterQuery, dataset, acl);
            eagleQuery.reportDropped(dataset, 'filter', dropped);
            // `Boolean(keywords)`, not `true`. With no keywords `search: '*'` has no relevance to
            // order by, and `search.score() desc` over a constant score leaves ties in whatever
            // order the service computed — which `$skip` paging then repeats and omits across
            // pages. Passing the truth here is what lets DEFAULT_ORDER supply the stable order it
            // exists for.
            const { orderby, dropped: sortDropped } =
              eagleQuery.buildOrderBy(req.query.sortBy, dataset, Boolean(keywords));
            eagleQuery.reportDropped(dataset, 'sort', sortDropped);

            // `count` is the index-wide total, not the page. The frontend shows it so a column
            // header stops reporting `pageSize` as though it were the number of matches, and
            // eagle-public pages against it.
            const { items, count } = await aiSearch.searchProjects({
              filter,
              orderby,
              skip,
              keywords,
              // No keywords means "every row the filter admits", which is what `search: '*'` is.
              // Without it `runSearch` short-circuits on an empty token list and the filtered
              // search answers zero rows — a filter that matches nothing, not a filter with
              // nothing to match.
              matchAll: !keywords,
              fuzzy,
              top: pageSize
            });

            if (items.length > 0) {
              const searchResults = items.map(doc => ({
                // THE EAGLE ObjectId, not the DEMI id. eagle-public routes `p/${_id}/project-details`
                // and then re-fetches the project from eagle-api by that id, so a DEMI Track id here
                // is a link that 404s. Falls back to the DEMI id for a project with no Eagle
                // counterpart — Track-only rows exist (`merge/project.js:171` writes null) and a row
                // with no `_id` at all would break the row template outright.
                _id: doc.legacyEagleId || String(doc.id),
                _schemaName: 'Project',
                id: String(doc.id),
                // Never carried by the old Typesense schema either, so this has always been the id.
                trackProjectId: doc.id,
                legacyEagleId: doc.legacyEagleId || '',
                name: doc.name || doc.displayName || 'Unnamed Project',
                sector: doc.sector || 'Other',
                status: doc.status || 'Active',
                // Cosmos stores GeoJSON [lng, lat] and the frontend wants [lng, lat], so the index
                // carries the point unchanged. The lat/lng swap that Typesense needed — and the
                // sign-sniffing that guessed at its orientation here — is simply gone.
                centroid: geoPoint(doc.centroid),
                region: doc.region || 'British Columbia',
                description: doc.description || 'No project description provided.',
                proponent: { name: doc.proponent || 'Proponent Organization' },
                // The three columns `project-list-table-rows.component.html:7-10` renders beside
                // name/proponent/region, and every one of them read '-' on every row until the
                // index carried them. `currentPhaseName` and `eacDecision` are rebuilt into the
                // `{_id, name}` shape the template binds (`.name`) and the filter panel sends
                // (`._id`) from the flat label/id pair the index stores — the same reconstruction
                // eagle-search does, so a saved filter URL means the same thing against either.
                type: doc.type || '',
                currentPhaseName: listRef(doc.currentPhaseNameId, doc.currentPhaseName),
                eacDecision: listRef(doc.eacDecisionId, doc.eacDecision),
                decisionDate: doc.decisionDate || null,
                // Pre-escaped display markup from the analyzer, keyed by INDEX field. `name` falls
                // back to `displayName` the same way the plain value above does, so the two never
                // disagree about which string the card is showing.
                highlighted: {
                  name: (doc.highlighted || {}).name || (doc.highlighted || {}).displayName || '',
                  description: (doc.highlighted || {}).description || ''
                },
                // `read[]` is NOT emitted, on this or any other row shape here. It is the caller's
                // own ACL restated — it decided which rows came back, and repeating it publishes
                // the internal role names of every restricted tier to anonymous callers for no
                // consumer: nothing in either frontend reads it. `isPublished` is the mirror the
                // frontends actually render, and it stays.
                isPublished: Array.isArray(doc.read) ? doc.read.includes('public') : true
                // No `sources` here. The `projects` index has no such field
                // (azure/search/indexes/projects.json), so the line that used to sit here
                // emitted `{}` on every hit and read as though the index carried the payload.
              }));

              return res.json([{ searchResults, count }]);
            }

            // No rows on THIS page, and `count` says whether that means an empty corpus or a page
            // past the end of a large one — a deep `skip` returns no rows against a five-figure
            // total, and reporting 0 there would collapse eagle-public's pager mid-session.
            // Answered here rather than by falling through to the keywordless Cosmos read below:
            // that path ignores the keywords entirely and returns an arbitrary page. Measured — an
            // anonymous search for a nonsense term returned 50 unrelated projects.
            return res.json([{ searchResults: [], count }]);
          }

          // Scoped to nothing. Fail closed, and do not let the unfiltered list answer instead.
          // 0 is measured: no filter can express this caller's visibility, so no row is reachable.
          return res.json([{ searchResults: [], count: 0 }]);
        } catch (err) {
          // A FAILED search is not an empty one, and it must not become the keywordless list
          // either. Falling through to Cosmos is what turned a single 400 — `and[centroid]=x` was
          // enough, see eagle-query.js TERM_TYPES — into "any anonymous caller can make any Project
          // keyword search answer an arbitrary page of the corpus". A non-2xx is the only answer
          // that is true: a 200 with an empty body asserts "0 results" to a visitor as a FACT, and
          // that assertion is false when the search never ran.
          //
          // What eagle-public does with the 502 today is not what an earlier version of this
          // comment claimed. There is no re-throw on this path. `api.searchKeywords` returns a
          // bare `this.http.get` with no `catchError` (eagle-public `api.ts:202`), and
          // `search.service.getSearchResults` swallows EVERY error into `of(null)`
          // (`search.service.ts:65-69`). So the 502 reaches the caller as `null`, and the caller
          // renders an empty table — for the Project dataset, `project.service.getAll`'s map
          // guarded that null and returned `{}`, which `getAllFull` read `.data` off as
          // `undefined` (eagle-public 7187eac, `project.service.ts:39-52` and `:101-111`).
          // The re-throw that DOES exist belongs to a different failure, and to an earlier line
          // than an earlier version of this comment claimed: for `res = []`, `getAll` calls
          // `utils.extractFromSearchResults(res)` FIRST, and at 7187eac that helper guarded
          // `!Array.isArray(results)` and then indexed `results[0].data` anyway — so an EMPTY
          // array threw there, one step before `meta[0]` was ever reached. Either way the same
          // `catchError` hands it to `api.handleError` (`api.ts:74-78`), whose re-throw is what
          // routes `projects.component.ts` home. An HTTP error never gets that far.
          //
          // So eagle-public needs a null guard of its own for this status; a sibling change is
          // adding one this round. Until that ships, a 502 on the DOCUMENT dataset reaches an
          // unguarded deref: `project.ts:192` reads `res[0].data.searchResults.length` inside a
          // `subscribe` whose only argument is a next handler, so `null` throws there with
          // nothing to catch it. The status stays 502 regardless — the frontend's handling of a
          // failure is not a reason for the API to report a fact it does not have.
          logger.error(`[search] project search failed: ${err.message}`);
          return res.status(502).json({ error: 'Project search is unavailable' });
        }
      }

      // Cosmos DB Fallback & Direct Search
      try {
        const allowNonTrack = req.query.includeSeeded === 'true';

        // Provenance filter — orthogonal to visibility, and never a substitute for it.
        // `sourceSystem = 'track'`, not the old `sources.track EXISTS AND != null`: an indexed
        // equality, and it sidesteps the Mongo/SQL disagreement over whether a missing field
        // matches $ne. buildCriteria in the repository owns that translation.
        //
        // ORDER BY c.name ASC comes from listVisible itself, so the sort survives the port.
        //
        // PAGED BY OVERFETCH-AND-SLICE, and that is a real ceiling: Cosmos pages with continuation
        // tokens, not offsets (`_sql.js:89-92` — page N would cost pages 1..N combined), and a
        // token cannot be reconstructed from a `pageNum` the client already forgot. So a page is
        // reachable only while `skip + pageSize` stays inside the repository's own 1000-row clamp.
        // That covers every project (382 of them, one page) and the first 1000 documents; beyond
        // that a page comes back empty with the real total beside it, rather than silently
        // repeating page one. Upgrade path if the corpus outgrows it: return the continuation token
        // in `meta` and have the client send it back, which is what the SDK is built for.
        // Only `project` can still be here: anything else is criteria and was routed to the index
        // above. It stays dropped-and-logged because it is genuinely inexpressible on this dataset
        // — the `projects` index has no project axis and `listVisible` has no project predicate.
        //
        // NO sortBy report any more, and the absence IS the fix: a `sortBy` naming anything at all
        // is criteria, so it never reaches this path to be ignored. What stays reachable is
        // `sortBy=&sortBy=` from eagle-public's double append, and there is nothing in that to
        // report as dropped.
        eagleQuery.reportDropped(dataset, 'filter', eagleQuery.filterKeysIn(req.query));

        const cosmosSkip = pageNum * pageSize;
        const { items: page } = await projectsRepo.listVisible(access, {
          trackOnly: !allowNonTrack,
          pageSize: cosmosSkip + pageSize
        });
        const projects = cosmosSkip > 0 ? page.slice(cosmosSkip) : page;

        // Counted on EVERY request. This used to run only when `pageNum` was present, on the
        // reasoning that a caller who is not paging does not render a total — and the response
        // wrapper then filled the gap with the page length. DEMI's own frontend is the request
        // shape that made that concrete: `registry-state.service.ts` asks for `pageSize=500` and no
        // `pageNum`, so a registry of any size answered "500". One aggregate query against the same
        // predicate as the read is the price of not asserting a number nobody measured; it is a
        // single-round-trip `VALUE COUNT(1)`, not a second scan of the page.
        const count = await projectsRepo.countVisible(access, { trackOnly: !allowNonTrack });

        // A NoSQL row has `id` and no `_id`. `_id` is kept in the RESPONSE because the frontend
        // still keys on it — dropping it here would empty the project list without any error.
        const mapped = projects.map(p => ({
          // The Eagle id, for the same reason as the AI Search branch above.
          _id: p.eagleId || String(p.id),
          _schemaName: 'Project',
          id: String(p.id),
          // STRING, matching the AI Search branch. Cosmos stores this as a Number
          // (`merge/project.js:170`, `Number(track.track_project_id)`) while the index has no such
          // field at all, so that branch falls back to the index KEY — declared `Edm.String` in
          // `azure/search/indexes/projects.json`, hence always a String. Only this side can differ,
          // which is why only this side coerces; a `String()` over there would be an inert line
          // pretending to do work.
          trackProjectId: String(p.trackProjectId || p.id),
          // COSMOS FIELD NAMES, not index field names. The two branches of this route read two
          // different shapes of the same record: the indexer's SELECT aliases the stored columns
          // (`azure/search/datasources/demi-projects-ds.json`: `c.projectState AS status`,
          // `c.eagleId AS legacyEagleId`), so an AI Search hit carries `status`/`legacyEagleId`
          // while the row this branch reads straight out of Cosmos carries `projectState`/`eagleId`
          // — the names `merge/project.js` writes (`:38` via TRACK_PRECEDENCE, `:171`/`:229`).
          //
          // Reading the aliases here was worse than a missing value: `p.status` was ALWAYS
          // undefined, so `|| 'Active'` fired on every row and this branch asserted that every
          // project in the registry is Active — including the completed and withdrawn ones — as
          // fact, with no way for the caller to tell it apart from a real reading. `legacyEagleId`
          // failed the same way but visibly, as a permanently empty string. `_id` above was already
          // correct, which is exactly why the defect survived review: the two fields sit three lines
          // apart and only one of them was reading the row it was handed.
          legacyEagleId: p.eagleId || '',
          name: p.name || 'Unnamed Project',
          sector: p.sector || 'Other',
          // BOTH names, because TWO WRITERS DISAGREE. `merge/project.js:38` stores `projectState`
          // (the sync path, and where the 393 rows in the registry come from), while
          // `controllers/nosql/project.js:87` `createProject` stores `status` and `updateProject`
          // spreads `...changes` verbatim, so anything created or edited through the API lands
          // under the index's alias instead. Reading only `projectState` fixed the sync rows and
          // broke the API-created ones — the same wrong answer arriving from the other direction.
          // Unifying the writers is its own change; until then this reads whichever the row has.
          status: p.projectState || p.status || 'Active',
          // Same helper as the AI Search branch — one definition of the fallback centroid, and
          // no second place to get the [lng, lat] orientation wrong.
          centroid: geoPoint(p.centroid),
          region: p.region || 'British Columbia',
          description: p.description || 'No project description provided.',
          proponent: { name: p.proponent?.name || p.proponentName || 'Proponent Organization' },
          // COSMOS FIELD NAMES again, for the reason the block above gives: the indexer aliases
          // `c.projectType AS type` and flattens the two List refs into a label/id pair, while the
          // row read straight out of Cosmos still carries `projectType` and the whole List object.
          // Reading `p.type` here would be undefined on every row and print '-' in the Type column
          // of the DEFAULT view — the one a visitor lands on, where no keyword has been typed yet.
          type: p.projectType || '',
          currentPhaseName: listRef(p.currentPhaseName?._id, p.currentPhaseName?.name),
          eacDecision: listRef(p.eacDecision?._id, p.eacDecision?.name),
          decisionDate: p.decisionDate || null,
          // 'public' in the read ACL is what makes a record public; isPublished mirrors it.
          // The frontend derives its staged/admitted badge from this field.
          isPublished: Array.isArray(p.read) && p.read.length > 0
            ? p.read.includes('public')
            : p.isPublished === true,
          // Only DEMI's own wildfire aggregate — the map explorer reads it. The raw Track and
          // Eagle payloads that share this field are traceability, not API surface; see
          // projectsRepo.publicView, which is the same rule stated once.
          sources: projectsRepo.publicView(p).sources || {}
        }));

        return res.json([{ searchResults: mapped, count }]);
      } catch (cosmosErr) {
        // See the keyword branch above: a search that FAILED is not a search that found nothing.
        // 200 with an empty array told every visitor of /projects that the EA registry contains no
        // projects, and told the analytics table the same thing as a zero-result search.
        logger.error(`[search] project list failed: ${cosmosErr.message}`);
        return res.status(502).json({ error: 'Project search is unavailable' });
      }
    } else if (dataset === 'Document') {
      // Same rule as Project: keywords OR criteria are answered by the index. This is the branch
      // the documents tab lands on — empty keywords, `and[milestone]=...`, `sortBy=-datePosted`
      // (`documents-tab.component.ts:47-56,177-190`) — and the Cosmos read below could express
      // neither, so it answered the whole corpus with a 200 and a log line nobody reads.
      if (keywords || criteria) {
        try {
          const acl = filterFor(access);
          // Projects are scoped on their own id; the same caller, a different index.
          const projectScope = filterFor(access, 'id');

          if (!acl.empty) {
            const { filter, dropped } = eagleQuery.buildFilter(filterQuery, dataset, acl);
            eagleQuery.reportDropped(dataset, 'filter', dropped);
            // See the Project branch: `Boolean(keywords)` is what lets DEFAULT_ORDER give a
            // keywordless page a stable order instead of a constant relevance score.
            const { orderby, dropped: sortDropped } =
              eagleQuery.buildOrderBy(req.query.sortBy, dataset, Boolean(keywords));
            eagleQuery.reportDropped(dataset, 'sort', sortDropped);

            const { items, count } = await aiSearch.searchDocuments({
              filter,
              orderby,
              // The SAME `skip` the keyword path uses — rows in the caller's own `pageSize`,
              // computed once above. The Cosmos list below derives its own offset because it pages
              // by overfetch-and-slice; re-deriving one here is how the two units drift apart.
              skip,
              // Passed so the project-name leg can run under the caller's project visibility.
              // Undefined would disable that leg entirely; null legitimately means "unrestricted".
              // The leg is skipped anyway under matchAll — a project-NAME match needs a name.
              projectFilter: projectScope.empty ? undefined : projectScope.filter,
              keywords,
              // See the Project branch: no keywords means every row the filter admits.
              matchAll: !keywords,
              fuzzy,
              top: pageSize
            });

            if (items.length > 0) {
              const mappedDocs = items.map(doc => ({
                // Already an Eagle ObjectId: documents are seeded keyed on it
                // (`seed/transform.js:84-87`), which is what makes eagle-api's download URL
                // `/api/public/document/{_id}/download/...` resolve.
                _id: String(doc.id),
                _schemaName: 'Document',
                displayName: doc.displayName || 'Untitled Document',
                documentFileName: doc.documentFileName || 'document.pdf',
                documentType: doc.type || 'PDF Document',
                // ~~No `type`/`milestone`/`projectPhase` ObjectIds.~~ There are now: the index
                // carries them and the seed keeps them, so eagle-public's `idToList()` has
                // something to resolve and its Type / Milestone / Date columns stop rendering '-'.
                // Sent as the ids the frontend expects, NOT the labels beside them — a label is
                // ambiguous across the 2002 and 2018 Acts (`Amendment` is two different List rows).
                type: doc.typeId || null,
                milestone: doc.milestoneId || null,
                projectPhase: doc.projectPhaseId || null,
                documentAuthorType: doc.documentAuthorTypeId || null,
                datePosted: doc.datePosted || null,
                project: String(doc.projectId || ''),
                // The index carries no projectName — a Cosmos document row does not have one, and
                // an indexer reads a single container. Both label and `{_id, name}` shape below.
                projectName: 'Associated Project',
                isPublished: Array.isArray(doc.read) ? doc.read.includes('public') : true,
                description: doc.description || 'Official document extracted from central registry.',
                // Pre-escaped display markup from the analyzer. Empty when the field itself is
                // empty, in which case the frontend falls back to the default text above — that
                // default is ours, not the user's, so there is nothing to highlight in it.
                highlighted: doc.highlighted
              }));

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
          // Same rule as the project branch, same reason: the fall-through to the keywordless
          // Cosmos read answered a FAILED keyword search with an arbitrary page of the corpus.
          logger.error(`[search] document search failed: ${err.message}`);
          return res.status(502).json({ error: 'Document search is unavailable' });
        }
      }

      // Cosmos DB Fallback & Direct Search
      try {
        // THE RESOLVED PROJECT IDS, applied. `filterQuery` carries them already translated from
        // Eagle ObjectIds (`resolveProjectFilter`), and this path used to drop them on the floor:
        // a request for one project's documents was answered with the whole corpus AND a
        // corpus-wide total — the exact failure `resolveProjectFilter`'s docstring warns about,
        // landing on the branch where the project WAS resolvable rather than the one where it was
        // not. `projectId` is the container's partition key, so one id turns this into a
        // single-partition read; the repository takes a list because `project=a,b` is one request.
        const demiProjectIds = eagleQuery.projectIdsFrom(filterQuery);

        // NOTHING IS DROPPED ON THIS PATH ANY MORE, so nothing is reported. `project` is applied
        // just above, and every other filter key — and every real sort key — is criteria, which
        // routed to the index before ever reaching here. The report that used to sit here named
        // the keys this route had silently ignored; they are honoured now, and a report that can
        // never fire is a comment pretending to be a check.

        // Same overfetch-and-slice paging as the project list above, same 1000-row ceiling.
        const cosmosSkip = pageNum * pageSize;
        const { items: docPage } = await documentsRepo.listVisible(access, {
          projectId: demiProjectIds,
          pageSize: cosmosSkip + pageSize
        });
        const docs = cosmosSkip > 0 ? docPage.slice(cosmosSkip) : docPage;
        // Unconditional, and under the SAME project scope as the read — see the project list for
        // why the `pageNum` condition had to go. A count built from a wider predicate than the read
        // would report the whole corpus as the size of one project's document list.
        const count = await documentsRepo.countVisible(access, { projectId: demiProjectIds });

        // `projectId`, not the Mongo-era `project` — the NoSQL row's partition key. Reading the
        // old field name would leave every result unlinked to a project and unlabelled below,
        // which looks like missing data rather than a wrong field.
        const mappedDocs = docs.map(d => ({
          _id: String(d.id),
          _schemaName: 'Document',
          displayName: d.displayName || 'Untitled Document',
          documentFileName: d.documentFileName || (d.s3Key ? d.s3Key.split('/').pop() : 'document.pdf'),
          documentType: d.type || 'PDF Document',
          // Same five as the AI Search branch above, and for the same reason — the Cosmos row
          // carries them since the backfill. Two mappers answering the same dataset must not
          // disagree about which columns exist, or a filter changes what a row renders.
          type: d.typeId || null,
          milestone: d.milestoneId || null,
          projectPhase: d.projectPhaseId || null,
          documentAuthorType: d.documentAuthorTypeId || null,
          datePosted: d.datePosted || null,
          project: String(d.projectId || ''),
          projectName: 'Associated Project',
          // Report the record's real publication state, not a hardcoded 'public'.
          isPublished: Array.isArray(d.read) ? d.read.includes('public') : d.isPublished === true,
          description: d.description || 'Official document extracted from central registry.'
        }));

        // Label the results the same way the AI Search branch does, under the CALLER's access.
        // The Mongo path left every row reading 'Associated Project'; that difference is exactly
        // how a silent degradation to the fallback stayed invisible.
        await labelWithProjectNames(access, mappedDocs);

        return res.json([{ searchResults: mappedDocs, count }]);
      } catch (cosmosErr) {
        logger.error(`[search] document list failed: ${cosmosErr.message}`);
        return res.status(502).json({ error: 'Document search is unavailable' });
      }
    } else if (dataset === 'DocumentChunk') {
      // Deep Search over extracted document TEXT, served by Azure AI Search.
      //
      // NO fallback to another source on an empty result. A fallback that fires on zero rows is
      // precisely how the deleted `epic`-collection workarounds came to exist: it turns
      // "extraction has not run" into "silently searched something else". Empty means empty.
      if (!keywords) {
        // Nothing was asked, so nothing matched: 0 is the measured answer to the query that was
        // actually issued, which is none.
        return res.json([{ searchResults: [], count: 0 }]);
      }

      try {
        // The visibility filter is evaluated BY THE SERVICE alongside the match, so ranking is
        // computed only over rows this caller may read. Roles come from the verified token only.
        const acl = filterFor(access);

        // `empty` is the fail-closed branch and it MUST short-circuit here. OData has no `false`
        // literal, so "this caller may see nothing" cannot be expressed as a filter — issuing the
        // request with no filter would return everything.
        if (acl.empty) {
          return res.json([{ searchResults: [], count: 0 }]);
        }

        const { filter, dropped } = eagleQuery.buildFilter(filterQuery, dataset, acl);
        eagleQuery.reportDropped(dataset, 'filter', dropped);

        // A PAGE OF DOCUMENTS COSTS A WINDOW OF CHUNKS. Rows are grouped by parent document below,
        // so `pageSize` chunks would yield far fewer than `pageSize` documents — measured on the
        // eagle-search side, ten chunk hits for one query covered four distinct files. The window
        // is the fetch unit and therefore the paging unit too, as
        // `eagle-search/service/index.js:355-356` does it.
        //
        // `skip` and `top` MUST BE THE SAME UNIT or matches become unreachable: consecutive pages
        // have to cover consecutive chunk ranges with no gap. So the window is capped at what ONE
        // request actually returns — a window larger than the fetch leaves the tail of every window
        // unrequested while `skip` still advances past it.
        //
        // SERVICE_MAX_TOP, not MAX_PAGE_ROWS: this query runs on every debounced keystroke against
        // a Basic 1-SU service, and `runSearch` fills anything larger with a SECOND request. One
        // page, one request — the multiplier ai-search.js says `pageSize` must never become.
        //
        // `pageSize` is therefore a fetch knob for this dataset, not a row count: a page carries
        // every document its window covered, between 1 and `window` rows.
        const chunkWindow = groupChunks.windowFor(pageSize, aiSearch.SERVICE_MAX_TOP);
        const { items, count } = await aiSearch.searchChunks({
          filter,
          // No `orderby`: every field in `chunks` is sortable:false, the key included, so
          // there is nothing to name — and naming a non-sortable field is a 400. Chunk pages are
          // relevance-ordered with no tiebreak, which makes a deep chunk page unstable.
          // ~~eagle-public has no chunk UI at all~~ — CORRECTED 2026-08-23: it does, at
          // `/search/content` (`app.routes.ts:87-90`), and that card is what the grouping below
          // exists for. It still never sorts this dataset.
          skip: pageNum * chunkWindow,
          keywords,
          fuzzy,
          top: chunkWindow
        });

        if (items.length === 0) {
          // `count` rather than a bare empty answer: a page past the end of a large result set
          // returns no rows too, and 0 there would tell the caller the index holds nothing.
          return res.json([{ searchResults: [], count }]);
        }

        // Chunks carry ids, not labels. Hydrate the parent document and project names in two
        // bounded reads under the CALLER's access — never systemAccess(), which would let a name
        // leak past the ACL that governs the row it describes.
        const documentIds = items.map(c => c.documentId);
        const projectIds = items.map(c => c.projectId);
        const [parentDocs, parentProjects] = await Promise.all([
          documentsRepo.listByIds(access, documentIds, projectIds),
          projectsRepo.listByIds(access, projectIds)
        ]);
        const docById = new Map(parentDocs.map(d => [String(d.id), d]));
        const projById = new Map(parentProjects.map(p => [String(p.id), p]));

        // THE GATE, not a label lookup. A chunk is a fragment of its document: a caller who cannot
        // see the document cannot see its text. `listByIds` above is ACL-enforcing and unbounded
        // (`fetchAll`, no maxItemCount), so a miss means DENIED, not truncated.
        //
        // This is a backstop as well as a fix. The chunk's own `read[]` is a snapshot taken at
        // ingest, so it can lag its document; deriving visibility from the parent means a stale
        // chunk ACL cannot leak text on its own. Before this, a chunk whose parent was withheld was
        // still returned — with its `snippet`, which is the real extracted text — and labelled
        // 'Untitled Document'.
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
            // The DEMI project id, for the same reason as the document rows: it is the Cosmos
            // partition key DEMI's frontend passes back to `GET /documents/{id}?project=`, and
            // `project._id` below is the EAGLE ObjectId. One field per id-space, never one derived
            // from the other.
            projectId: String(chunk.projectId || ''),
            // Same `{_id, name}` shape and same miss case as labelWithProjectNames — a chunk whose
            // parent PROJECT is unreadable still returns (the gate is the parent DOCUMENT, above)
            // and carries the DEMI id it was indexed with.
            project: eagleQuery.ref(
              (project && project.eagleId) || String(chunk.projectId || ''),
              projectName
            ),
            projectName,
            documentName:
              (parent && (parent.displayName || parent.documentFileName)) || 'Untitled Document',
            documentType: (parent && parent.type) || 'PDF Document',
            pageNumber: chunk.pageNumber ?? 0,
            // Empty by design: `content` is not retrievable from the index, so the API never
            // ships whole chunks. The UI renders `snippet` and only falls back to `content`
            // when there is no snippet.
            content: '',
            // Already escaped, with only the <mark> tags this layer added — chunk text comes from
            // arbitrary uploaded PDFs and the UI renders it with [innerHTML].
            snippet: chunk.snippet || ''
          };
        });
        // `count` is the index-wide total for this query, not the page size — the service already
        // computes it and this layer used to discard it. It is the only way to see how many chunks
        // Azure AI Search actually holds: the data plane is private-endpoint-only, and the
        // `indexProgress` in /db/stats reports COSMOS index-build percent, which says nothing
        // about whether the PT5M indexer has pulled anything. Added deliberately only to the
        // success path — the empty returns above omit it, because absent means "not measured"
        // while a 0 would be a claim about the index.
        //
        // Reported net of what this page withheld. The index-wide figure would tell an anonymous
        // caller that more matches exist than they were shown, which is a small disclosure about
        // content they may not see — but reporting the PAGE length as the total is worse: `count`
        // is the whole-corpus figure the frontend shows as "N results" and pages against, so a
        // single withheld chunk would collapse it to at most one page.
        // GROUPED AFTER THE GATE, never before: a withheld chunk must not contribute a snippet or
        // a match to the document row, and grouping first would hide which rows the ACL removed.
        const grouped = groupChunks.groupByDocument(mappedChunks);

        const withheld = items.length - visible.length;
        return res.json([{
          searchResults: grouped,
          // Still the PASSAGE total — `meta.countsPassages` says so, and the rows are documents.
          // Floored at the number of chunks that survived the gate. `visible.length` rather than
          // `grouped.length`: a floor at the ROW count would report fewer matches than this page
          // alone demonstrably contains, since one row can carry a dozen of them.
          // (`mappedChunks.length` was the same number — a pure map of `visible` — so naming
          // `visible` changes nothing at runtime and says which quantity is meant.)
          count: withheld > 0 ? Math.max(count - withheld, visible.length) : count
        }]);
      } catch (err) {
        // An empty result caused by a fault is NOT the same fact as "nothing matched", and the
        // status code is the only place that difference can be said. This branch used to answer
        // 200 with `[]` to buy latency — the frontend retries a 5xx twice at 1s
        // (registry-state.service.ts fetchWithRetry) and lands on an empty chunk list anyway — but
        // the response envelope then asserted `searchResultsTotal: 0`, which is a claim about the
        // index that nothing measured. DEMI's chunk leg reads `res.ok ? json : null` and renders
        // the count as unknown, so a non-2xx is also the shape its UI already handles; three
        // requests on a failing search is the price.
        logger.error(`[search] chunk search failed: ${err.message}`);
        return res.status(502).json({ error: 'Deep Search is unavailable' });
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

/**
 * `GET /api/search/summary?keywords=…` — step 5 of the pipeline. See wiki ADR-006.
 *
 * PRIVILEGED ONLY. Mounted on `authMiddleware`, not `passiveAuthMiddleware`: anonymous callers get
 * a 401 and never reach this function. That is deliberate for v1 — a <mark> fragment discloses a
 * phrase, a synthesised cross-chunk paraphrase discloses substance, so the first version is gated
 * to a small known population while cost and abuse are measured. `GET /api/search` is untouched and
 * stays public.
 *
 * Retrieval here is the SAME BM25 call the results columns already made. Nothing about ranking,
 * query construction or the ACL changes; this endpoint adds a step after them.
 */
exports.summarize = async (req, res) => {
  const keywords = req.query.keywords || req.query.q || '';
  if (!keywords) {
    return res.json({ summary: null, citations: [], reason: 'no_query' });
  }

  try {
    const access = resolveAccess(req);
    const { filter, empty } = filterFor(access);

    // Same fail-closed branch as the chunk search, for the same reason: OData has no `false`
    // literal, so a caller who may see nothing cannot be expressed as a filter. Issuing the request
    // without one would summarise the entire corpus.
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

    // The index cannot supply the text — `content` is retrievable:false — so it comes from Cosmos.
    // `getById` takes the caller's access and re-applies the ACL at the database. The search filter
    // above already excluded anything unreadable; this is the second of two load-bearing gates, not
    // a belt-and-braces one, and a null here means the row moved out of reach between the two reads.
    const fetched = await Promise.all(
      items.map(c => chunksRepo.getById(access, String(c.chunkId), String(c.documentId)))
    );

    const chunks = items
      .map((item, i) => ({ item, row: fetched[i] }))
      .filter(({ row }) => row && row.content)
      .map(({ item, row }) => ({
        chunkId: String(item.chunkId),
        documentId: String(item.documentId || ''),
        projectId: String(item.projectId || ''),
        pageNumber: item.pageNumber ?? 0,
        content: row.content
      }));

    const { summary, citations, reason, usage, estimatedCostCad } =
      await summarizer.summarize(keywords, chunks);

    // Hydrate ONLY the chunks the model actually cited — at most a handful, and usually fewer than
    // were sent. Two bounded reads under the CALLER's access, never systemAccess(): a name is a
    // disclosure about the row it describes, so it must not outlive the ACL that governs the row.
    // Same pair of calls the chunk-search branch makes above.
    const cited = citations.map(i => chunks[i]);
    const [citedDocs, citedProjects] = cited.length > 0
      ? await Promise.all([
        documentsRepo.listByIds(access, cited.map(c => c.documentId), cited.map(c => c.projectId)),
        projectsRepo.listByIds(access, cited.map(c => c.projectId))
      ])
      : [[], []];
    const docById = new Map(citedDocs.map(d => [String(d.id), d]));
    const projById = new Map(citedProjects.map(p => [String(p.id), p]));

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
      // Returned so the page can show what the answer cost. An ESTIMATE from reported tokens and
      // configured list rates — see estimateCostCad. Null when the model was never called.
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
