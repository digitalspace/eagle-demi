'use strict';

// Searches go to Azure AI Search. A KEYWORDLESS project list is a read, not a search, and comes
// from the Cosmos NoSQL repositories — see wiki Search-Query-Construction#project-reads-split-between-cosmos-and-the-index.
const { resolveAccess } = require('../helpers/access-sql');
const { redactForAccess } = require('../vis/redact');
const { logger } = require('../utils/logger');
const { filterFor } = require('../helpers/access-odata');
const aiSearch = require('../search/ai-search');
const eagleQuery = require('../search/eagle-query');
const { documentsAcl } = require('../search/document-query');
const chunkQuery = require('../search/chunk-query');
const groupChunks = require('../search/group-chunks');
const projectsRepo = require('../repositories/projects');
const { analyticsEvent } = require('../utils/audit');
const {
  geoPoint,
  labelWithProjectNames,
  staffProjectFields,
  staffFieldsByProjectId,
  withoutDialHidden,
  redactIndexProject,
  indexActiveWork,
  wireSector
} = require('./search/project-fields');
const {
  resolveProjectFilter,
  recoverChunkFilters,
  liveChunkFacets,
  documentIdScope
} = require('./search/index-filters');
const { COSMOS_DATASETS, COSMOS_DATASET_NAMES } = require('./search/datasets');
const {
  KEYWORD_INDEX_DATASETS,
  unappliedFilterKeys,
  warnKeywordFallback,
  resetKeywordFallbackWarnings
} = require('./search/keyword-index');
const { resetCountsCache, counts } = require('./search/counts');
const { summarize } = require('./search/summary');

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

exports.resetStaleChunkScopeCache = chunkQuery.resetStaleChunkScopeCache;

exports.COSMOS_DATASET_NAMES = COSMOS_DATASET_NAMES;
exports.resetKeywordFallbackWarnings = resetKeywordFallbackWarnings;
exports.warnKeywordFallback = warnKeywordFallback;

/** Every `dataset=` this route answers; any other name is a 400. */
const KNOWN_DATASETS = new Set(['Project', 'Document', 'DocumentChunk', ...COSMOS_DATASET_NAMES]);

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

    // Before the project filter: an unknown dataset with one must not answer an empty 200.
    if (!KNOWN_DATASETS.has(dataset)) {
      return res.status(400).json({ error: `Invalid or unsupported dataset: ${dataset}` });
    }

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
            // The catalog publishes only the enrichment summaries (`sources.wildfire`, `sources.nrpti`);
            // the raw Track and Eagle payloads here are traceability, not API surface.
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
    } else {
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
    }
  } catch (err) {
    // Nothing below reached an answer, so there is no result set — empty or otherwise — to report.
    // A 200 here would publish "no results" as a finding of the search that never ran.
    logger.error('[demi-api search] Top-level search error:', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Search failed' });
  }
};

exports.resetCountsCache = resetCountsCache;
exports.counts = counts;
exports.summarize = summarize;
