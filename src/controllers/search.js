'use strict';

// All three datasets search Azure AI Search. The KEYWORDLESS path — listing projects or documents,
// which is a read rather than a search — goes to the Cosmos NoSQL repositories. It used to go to
// the Mongo-API models; that was the last data-layer split in this file and it is gone.
const { resolveAccess } = require('../helpers/access-sql');
const { logger } = require('../utils/logger');
const { filterFor } = require('../helpers/access-odata');
const aiSearch = require('../search/ai-search');
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

exports.search = async (req, res) => {
  try {
    const dataset = req.query.dataset;
    const keywords = req.query.keywords || req.query.q || '';
    const fuzzy = req.query.fuzzy === 'true';
    const requestedPageSize = parseInt(req.query.pageSize || '10', 10);
    const pageSize = Math.min(requestedPageSize, 5000);

    // One access context for the whole request. Both the AI Search filter and the Cosmos
    // predicate are derived from it, so the indexed and the unindexed path cannot disagree
    // about what this caller may see.
    const access = resolveAccess(req);

    const resultPageSize = Math.min(pageSize, 250);

    // Usage analytics, recorded once by wrapping the response rather than at each exit — this
    // handler has a dozen `return res.json(...)` points and a call at every one of them is a call
    // that quietly stops happening the next time a branch is added. Only shapes that look like a
    // search answer are counted, so an error payload is not recorded as a zero-result search:
    // zero-result searches are the most useful thing in this table and must stay believable.
    const sendJson = res.json.bind(res);
    res.json = (payload) => {
      const first = Array.isArray(payload) ? payload[0] : null;
      if (first && Array.isArray(first.searchResults)) {
        analyticsEvent(req, {
          eventName: 'search',
          searchTerm: keywords,
          resultCount: Number.isFinite(first.count) ? first.count : first.searchResults.length,
          detail: { dataset, fuzzy, pageSize }
        });
      }
      return sendJson(payload);
    };

    if (dataset === 'Project') {
      // Keywords go to AI Search; a bare list still comes from Cosmos below, because listing every
      // project is a read, not a search, and the index adds nothing to it.
      if (keywords) {
        try {
          // 'id', not 'projectId' — a project IS its own scope, and scoping on a field the index
          // does not have would match nothing while looking like an empty corpus.
          const { filter, empty } = filterFor(access, 'id');

          if (!empty) {
            // `count` is the index-wide total, not the page. The frontend shows it so a column
            // header stops reporting `pageSize` as though it were the number of matches.
            const { items, count } = await aiSearch.searchProjects({
              filter,
              keywords,
              fuzzy,
              top: resultPageSize
            });

            if (items.length > 0) {
              const searchResults = items.map(doc => ({
                _id: String(doc.id),
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
                read: Array.isArray(doc.read) && doc.read.length > 0 ? doc.read : ['public'],
                region: doc.region || 'British Columbia',
                description: doc.description || 'No project description provided.',
                proponent: { name: doc.proponent || 'Proponent Organization' },
                // Pre-escaped display markup from the analyzer, keyed by INDEX field. `name` falls
                // back to `displayName` the same way the plain value above does, so the two never
                // disagree about which string the card is showing.
                highlighted: {
                  name: (doc.highlighted || {}).name || (doc.highlighted || {}).displayName || '',
                  description: (doc.highlighted || {}).description || ''
                },
                isPublished: Array.isArray(doc.read) ? doc.read.includes('public') : true
                // No `sources` here. The `demi-projects` index has no such field
                // (azure/search/indexes/demi-projects.json), so the line that used to sit here
                // emitted `{}` on every hit and read as though the index carried the payload.
              }));

              return res.json([{ searchResults, count }]);
            }

            // Nothing matched. Answer that, rather than falling through to the keywordless Cosmos
            // read below — that path ignores the keywords entirely and returns an arbitrary page.
            // Measured: an anonymous search for a nonsense term returned 50 unrelated projects,
            // and the same fallback masked a 400 that had broken project search outright.
            return res.json([{ searchResults: [] }]);
          }

          // Scoped to nothing. Fail closed, and do not let the unfiltered list answer instead.
          return res.json([{ searchResults: [] }]);
        } catch (err) {
          // A backend FAULT is different from no matches, and is the one case still worth the
          // database's answer — logged loudly, because an empty page and a broken search look
          // identical from outside.
          logger.error(`[search] project search failed, falling back to Cosmos: ${err.message}`);
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
        const { items: projects } = await projectsRepo.listVisible(access, {
          trackOnly: !allowNonTrack,
          pageSize
        });

        // A NoSQL row has `id` and no `_id`. `_id` is kept in the RESPONSE because the frontend
        // still keys on it — dropping it here would empty the project list without any error.
        const mapped = projects.map(p => ({
          _id: String(p.id),
          id: String(p.id),
          trackProjectId: p.trackProjectId || p.id,
          legacyEagleId: p.legacyEagleId || '',
          name: p.name || 'Unnamed Project',
          sector: p.sector || 'Other',
          status: p.status || 'Active',
          // Same helper as the AI Search branch — one definition of the fallback centroid, and
          // no second place to get the [lng, lat] orientation wrong.
          centroid: geoPoint(p.centroid),
          read: Array.isArray(p.read) && p.read.length > 0 ? p.read : ['public'],
          region: p.region || 'British Columbia',
          description: p.description || 'No project description provided.',
          proponent: { name: p.proponent?.name || p.proponentName || 'Proponent Organization' },
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

        return res.json([{ searchResults: mapped }]);
      } catch (cosmosErr) {
        logger.error(`[search] Cosmos DB fallback failed: ${cosmosErr.message}`);
        return res.json([{ searchResults: [] }]);
      }
    } else if (dataset === 'Document') {
      if (keywords) {
        try {
          const { filter, empty } = filterFor(access);
          // Projects are scoped on their own id; the same caller, a different index.
          const projectScope = filterFor(access, 'id');

          if (!empty) {
            const { items, count } = await aiSearch.searchDocuments({
              filter,
              // Passed so the project-name leg can run under the caller's project visibility.
              // Undefined would disable that leg entirely; null legitimately means "unrestricted".
              projectFilter: projectScope.empty ? undefined : projectScope.filter,
              keywords,
              fuzzy,
              top: resultPageSize
            });

            if (items.length > 0) {
              const mappedDocs = items.map(doc => ({
                _id: String(doc.id),
                displayName: doc.displayName || 'Untitled Document',
                documentFileName: doc.documentFileName || 'document.pdf',
                documentType: doc.type || 'PDF Document',
                project: String(doc.projectId || ''),
                // The index carries no projectName — a Cosmos document row does not have one, and
                // an indexer reads a single container. The label is resolved below.
                projectName: 'Associated Project',
                read: Array.isArray(doc.read) && doc.read.length > 0 ? doc.read : ['public'],
                isPublished: Array.isArray(doc.read) ? doc.read.includes('public') : true,
                description: doc.description || 'Official document extracted from central registry.',
                // Pre-escaped display markup from the analyzer. Empty when the field itself is
                // empty, in which case the frontend falls back to the default text above — that
                // default is ours, not the user's, so there is nothing to highlight in it.
                highlighted: doc.highlighted
              }));

              // Hydrate project names under the CALLER's access — never systemAccess(), which
              // would let a label leak past the ACL governing the row it describes. Same shape the
              // chunk branch uses.
              const projectIds = mappedDocs.map(d => d.project).filter(Boolean);
              if (projectIds.length > 0) {
                const parents = await projectsRepo.listByIds(access, projectIds);
                const nameById = new Map(parents.map(p => [String(p.id), p.name]));
                for (const doc of mappedDocs) {
                  doc.projectName = nameById.get(doc.project) || 'Associated Project';
                }
              }

              return res.json([{ searchResults: mappedDocs, count }]);
            }

            // See the project branch: no matches is an answer, not a reason to list the corpus.
            return res.json([{ searchResults: [] }]);
          }

          return res.json([{ searchResults: [] }]);
        } catch (err) {
          logger.error(`[search] document search failed, falling back to Cosmos: ${err.message}`);
        }
      }

      // Cosmos DB Fallback & Direct Search
      try {
        const { items: docs } = await documentsRepo.listVisible(access, { pageSize });

        // `projectId`, not the Mongo-era `project` — the NoSQL row's partition key. Reading the
        // old field name would leave every result unlinked to a project and unlabelled below,
        // which looks like missing data rather than a wrong field.
        const mappedDocs = docs.map(d => ({
          _id: String(d.id),
          displayName: d.displayName || 'Untitled Document',
          documentFileName: d.documentFileName || (d.s3Key ? d.s3Key.split('/').pop() : 'document.pdf'),
          documentType: d.type || 'PDF Document',
          project: String(d.projectId || ''),
          projectName: 'Associated Project',
          // Report the record's real ACL/publication state, not a hardcoded 'public'.
          read: Array.isArray(d.read) && d.read.length > 0 ? d.read : ['public'],
          isPublished: Array.isArray(d.read) ? d.read.includes('public') : d.isPublished === true,
          description: d.description || 'Official document extracted from central registry.'
        }));

        // Label the results the same way the AI Search branch does, under the CALLER's access.
        // The Mongo path left every row reading 'Associated Project'; that difference is exactly
        // how a silent degradation to the fallback stayed invisible.
        const projectIds = mappedDocs.map(d => d.project).filter(Boolean);
        if (projectIds.length > 0) {
          const parents = await projectsRepo.listByIds(access, projectIds);
          const nameById = new Map(parents.map(p => [String(p.id), p.name]));
          for (const doc of mappedDocs) {
            doc.projectName = nameById.get(doc.project) || 'Associated Project';
          }
        }

        return res.json([{ searchResults: mappedDocs }]);
      } catch (cosmosErr) {
        logger.error(`[search] Document Cosmos DB fallback failed: ${cosmosErr.message}`);
        return res.json([{ searchResults: [] }]);
      }
    } else if (dataset === 'DocumentChunk') {
      // Deep Search over extracted document TEXT, served by Azure AI Search.
      //
      // NO fallback to another source on an empty result. A fallback that fires on zero rows is
      // precisely how the deleted `epic`-collection workarounds came to exist: it turns
      // "extraction has not run" into "silently searched something else". Empty means empty.
      if (!keywords) {
        return res.json([{ searchResults: [] }]);
      }

      try {
        // The visibility filter is evaluated BY THE SERVICE alongside the match, so ranking is
        // computed only over rows this caller may read. Roles come from the verified token only.
        const { filter, empty } = filterFor(access);

        // `empty` is the fail-closed branch and it MUST short-circuit here. OData has no `false`
        // literal, so "this caller may see nothing" cannot be expressed as a filter — issuing the
        // request with no filter would return everything.
        if (empty) {
          return res.json([{ searchResults: [] }]);
        }

        const { items, count } = await aiSearch.searchChunks({
          filter,
          keywords,
          fuzzy,
          top: resultPageSize
        });

        if (items.length === 0) {
          return res.json([{ searchResults: [] }]);
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
          return {
            _id: String(chunk.chunkId),
            documentId: String(chunk.documentId || ''),
            project: String(chunk.projectId || ''),
            projectName: (project && project.name) || 'Associated Project',
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
            snippet: chunk.snippet || '',
            read: Array.isArray(chunk.read) && chunk.read.length > 0 ? chunk.read : ['public']
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
        // single withheld chunk would collapse it to at most `resultPageSize`.
        const withheld = items.length - visible.length;
        return res.json([{
          searchResults: mappedChunks,
          count: withheld > 0 ? Math.max(count - withheld, mappedChunks.length) : count
        }]);
      } catch (err) {
        // A bounded failure still has to be legible: an empty result caused by a fault is NOT the
        // same fact as "nothing matched". 200 rather than 5xx because the frontend retries 5xx
        // twice at 1s (registry-state.service.ts fetchWithRetry) and lands on an empty chunk list
        // regardless, so a status code only buys latency on every search.
        logger.error(`[search] chunk search failed: ${err.message}`);
        return res.json([{ searchResults: [] }]);
      }
    } else {
      return res.status(400).json({ error: `Invalid or unsupported dataset: ${dataset}` });
    }
  } catch (err) {
    logger.error('[demi-api search] Top-level search error:', { error: err.message, stack: err.stack });
    return res.json([{ searchResults: [] }]);
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
