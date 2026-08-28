'use strict';

// Searches go to Azure AI Search. A KEYWORDLESS project list is a read, not a search, and comes
// from the Cosmos NoSQL repositories — see wiki Search-Query-Construction#project-reads-split-between-cosmos-and-the-index.
const { resolveAccess } = require('../helpers/access-sql');
const { redactForAccess, redactAllForAccess } = require('../vis/redact');
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

/** An Eagle ObjectId. DEMI project ids are Track integers or `eagle-<ObjectId>`, so this cannot collide. */
const EAGLE_OBJECT_ID = /^[0-9a-f]{24}$/i;

/**
 * Rewrite `&project=`/`&and[project]=` from Eagle ObjectIds into DEMI project ids.
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
    const project = await projectsRepo.getByEagleId(access, id);
    // No project row: keep the caller's own id. Either a ProjectNotification `_id` holding real
    // documents, or an id that matches nothing — which is the right answer for both.
    demiIds.push(project ? String(project.id) : id);
  }

  return eagleQuery.withProjectIds(query, demiIds);
}

/**
 * Recover the chunk filters the `chunks` index cannot express, by resolving them against `documents`.
 *
 * See wiki Search-Query-Construction#chunk-filters-resolved-through-documents.
 *
 * @returns {{scope: ?string, recovered: string[]}} `scope` is an OData clause to AND into the chunk
 *   filter, or null. `recovered` are the keys to REMOVE from the dropped report — everything else
 *   stays reported, the over-cap case included.
 */
async function recoverChunkFilters(query, dropped, acl, access) {
  if (!dropped.length) return { scope: null, recovered: [] };

  // Only the dropped keys the DOCUMENTS index can express, asked by building a filter from those
  // keys and seeing which survive — never a hardcoded list, which goes stale when an index widens.
  // Rebuilt in the WIRE shape: `dropped` holds base names (`type`), the query holds `and[type]`.
  const narrowed = {};
  // The caller's own project scope comes along, and it is what decides whether the rest fits: a
  // `type` filter resolved corpus-wide to 2,911 documents and was reported inexpressible, where the
  // project-scoped set is a handful. `project` is never in `dropped` here, so nothing offered it.
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
  if (Object.keys(narrowed).length === 0) return { scope: null, recovered: [] };

  const { filter: docFilter, dropped: stillDropped } =
    eagleQuery.buildFilter(narrowed, 'Document', acl, access);
  const recovered = dropped.filter(key => !stillDropped.includes(key));
  if (!recovered.length || !docFilter) return { scope: null, recovered: [] };

  const { ids, total, withinCap } = await aiSearch.documentIdsMatching(docFilter);
  if (!withinCap) {
    logger.warn('[search] chunk filter matches too many documents to scope', {
      keys: recovered, documents: total, cap: aiSearch.DOCUMENT_SCOPE_CAP
    });
    return { scope: null, recovered: [] };
  }

  // No matching document means no matching chunk, and that is a MEASUREMENT. Expressed as a clause
  // that cannot match rather than an early return, so count and ACL stay on one code path.
  if (ids.length === 0) return { scope: "documentId eq ''", recovered };

  // `quoteList` does quote-DOUBLING only (the comma-delimiter fallback is `access-odata.inClause`),
  // which is safe here because a document id is a GUID or an `eagle-<hex>` string.
  return { scope: `search.in(documentId, ${aiSearch.quoteList(ids)}, ',')`, recovered };
}

exports.search = async (req, res) => {
  try {
    const dataset = req.query.dataset;
    const keywords = req.query.keywords || req.query.q || '';
    // FORCED ON, and the wire value is deliberately ignored — see
    // wiki Search-Query-Construction#why-the-fuzzy-parameter-is-ignored. Still an ACCEPTED parameter,
    // because dropping it from unknownParams would 400 every saved URL.
    const fuzzy = true;
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
          ...(droppedKeys.filter.length || droppedKeys.sort.length ? { dropped: droppedKeys } : {})
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
            const { items, count } = await aiSearch.searchProjects({
              filter,
              orderby,
              skip,
              keywords,
              // No keywords means "every row the filter admits". Without it `runSearch`
              // short-circuits on an empty token list and the filtered search answers zero rows.
              matchAll: !keywords,
              fuzzy,
              top: pageSize
            });

            if (items.length > 0) {
              const searchResults = items.map(hit => {
                // Redact the INDEX row, then map, exactly as the Cosmos branch below does. The
                // catalog is keyed on INDEX field names because the data source renames columns
                // (docs/rbac-architecture.md §2 item 9).
                const doc = redactForAccess('index-projects', hit, access);
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
          return res.status(502).json({ error: 'Project search is unavailable' });
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
            // Cosmos field names again: `p.type` would be undefined on every row of the DEFAULT
            // view, the one a visitor lands on before typing a keyword.
            type: row.projectType || '',
            currentPhaseName: eagleQuery.ref(row.currentPhaseName?._id, row.currentPhaseName?.name),
            eacDecision: eagleQuery.ref(row.eacDecision?._id, row.eacDecision?.name),
            decisionDate: row.decisionDate || null,
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
        return res.status(502).json({ error: 'Project search is unavailable' });
      }
    } else if (dataset === 'Document') {
      // EVERY document read is answered by the index — NOT the Project rule, and the difference is
      // paging: the Cosmos read could not page past its 1000-row clamp, and there is no fallback
      // under this. See wiki Search-Query-Construction#every-document-read-goes-to-the-index.
      try {
        const acl = filterFor(access);
        // Projects are scoped on their own id; the same caller, a different index.
        const projectScope = filterFor(access, 'id');

        if (!acl.empty) {
          const { filter, dropped } = eagleQuery.buildFilter(filterQuery, dataset, acl, access);
          noteDropped('filter', dropped);
          // See the Project branch: `Boolean(keywords)` is what lets DEFAULT_ORDER give a
          // keywordless page a stable order instead of a constant relevance score.
          const { orderby, dropped: sortDropped } =
            eagleQuery.buildOrderBy(req.query.sortBy, dataset, Boolean(keywords), access);
          noteDropped('sort', sortDropped);

          const { items, count } = await aiSearch.searchDocuments({
            filter,
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
            top: pageSize
          });

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
        return res.status(502).json({ error: 'Document search is unavailable' });
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
        const acl = filterFor(access);

        // Fail-closed, and it MUST short-circuit here: OData has no `false` literal, so issuing the
        // request with no filter would return everything.
        if (acl.empty) {
          return res.json([{ searchResults: [], count: 0 }]);
        }

        const { filter, dropped } = eagleQuery.buildFilter(filterQuery, dataset, acl, access);

        // Document metadata resolved through the documents index, because a chunk cannot be
        // filtered on it. Reported only for what stayed dropped — a recovered key is one that worked.
        const { scope, recovered } = await recoverChunkFilters(filterQuery, dropped, acl, access);
        noteDropped('filter', dropped.filter(key => !recovered.includes(key)));
        // `filter` is UNDEFINED for an unscoped privileged caller — an unfiltered read, not an
        // empty one — and a bare template over it emits `(undefined) and …`, a 400 this route
        // answers as 502.
        const scopedFilter = scope
          ? (filter ? `(${filter}) and ${scope}` : scope)
          : filter;

        // A `sortBy` reaching this line is always dropped: every field in `chunks` is
        // `sortable: false`, so `buildOrderBy` is called for its drop list and nothing else. Not on
        // every request — the keywordless return above fires first and reports no `dropped` at all.
        noteDropped('sort', eagleQuery.buildOrderBy(req.query.sortBy, dataset, Boolean(keywords), access).dropped);

        // A PAGE OF DOCUMENTS COSTS A WINDOW OF CHUNKS, so the window is the paging unit too and
        // `pageSize` is a fetch knob for this dataset, not a row count. See
        // wiki Search-Query-Construction#chunk-paging-is-a-window.
        const chunkWindow = groupChunks.windowFor(pageSize, aiSearch.SERVICE_MAX_TOP);
        const { items, count } = await aiSearch.searchChunks({
          filter: scopedFilter,
          // No `orderby`: every field in `chunks` is `sortable: false`, the key included, and
          // naming a non-sortable field is a 400. Chunk pages are relevance-ordered with no
          // tiebreak, which makes a deep chunk page unstable.
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
    const { filter, empty } = filterFor(access);

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

    const chunks = items
      .map((item, i) => ({ item, row: fetched[i] }))
      .filter(({ item, row }) => row && row.content && docById.has(String(item.documentId)))
      .map(({ item, row }) => ({
        chunkId: String(item.chunkId),
        documentId: String(item.documentId || ''),
        projectId: String(item.projectId || ''),
        pageNumber: item.pageNumber ?? 0,
        content: row.content
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
