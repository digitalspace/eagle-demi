'use strict';

const Project = require('../models/project');
const Document = require('../models/document');
const { rolesFor, readFilter, withReadFilter } = require('../helpers/access');

// All three datasets search Azure AI Search. What remains Mongo-era is the KEYWORDLESS path —
// listing projects or documents is a read, not a search, and still goes to the models below. That
// half is on the Phase 8 port list (MIGRATION.md §B).
const { resolveAccess } = require('../helpers/access-sql');
const { filterFor } = require('../helpers/access-odata');
const aiSearch = require('../search/ai-search');
const documentsRepo = require('../repositories/documents');
const projectsRepo = require('../repositories/projects');

/**
 * Visibility context for the Mongo-era list path.
 *
 * Roles come from the verified token only (helpers/auth.js populates req.user; the X-Api-Key
 * service path sets the privileged roles there too). The search path does not use this — it
 * resolves its own context through `resolveAccess` and `filterFor`, so the two are derived from
 * the same roles rather than from each other.
 */
function getUserAccessContext(req) {
  const roles = rolesFor(req);
  return { roles, mongoFilter: readFilter(roles) };
}

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

    const accessContext = getUserAccessContext(req);

    const resultPageSize = Math.min(pageSize, 250);

    if (dataset === 'Project') {
      // Keywords go to AI Search; a bare list still comes from Cosmos below, because listing every
      // project is a read, not a search, and the index adds nothing to it.
      if (keywords) {
        try {
          const access = resolveAccess(req);
          // 'id', not 'projectId' — a project IS its own scope, and scoping on a field the index
          // does not have would match nothing while looking like an empty corpus.
          const { filter, empty } = filterFor(access, 'id');

          if (!empty) {
            const { items } = await aiSearch.searchProjects({
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
                isPublished: Array.isArray(doc.read) ? doc.read.includes('public') : true,
                sources: doc.sources || {},
                nrptiRecords: []
              }));

              return res.json([{ searchResults }]);
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
          console.error('[search] project search failed, falling back to Cosmos:', err.message);
        }
      }

      // Cosmos DB Fallback & Direct Search
      try {
        const allowNonTrack = req.query.includeNrpti === 'true' || req.query.includeSeeded === 'true';
        // Provenance filter — orthogonal to visibility, and never a substitute for it.
        const trackOnly = allowNonTrack ? null : { 'sources.track': { $exists: true, $ne: null } };
        const filter = withReadFilter(accessContext.roles, trackOnly);

        const projects = await Project.find(filter, { maxItemCount: pageSize, sort: { name: 1 } });
        const mapped = projects.map(p => ({
          _id: String(p._id),
          id: String(p.id || p._id),
          trackProjectId: p.trackProjectId || p._id,
          legacyEagleId: p.legacyEagleId || '',
          name: p.name || 'Unnamed Project',
          sector: p.sector || 'Other',
          status: p.status || 'Active',
          centroid: p.centroid ? (Array.isArray(p.centroid) ? p.centroid : p.centroid.coordinates) : [-125.0, 54.0],
          read: Array.isArray(p.read) && p.read.length > 0 ? p.read : ['public'],
          region: p.region || 'British Columbia',
          description: p.description || 'No project description provided.',
          proponent: { name: p.proponent?.name || p.proponentName || 'Proponent Organization' },
          // 'public' in the read ACL is what makes a record public; isPublished mirrors it.
          // The frontend derives its staged/admitted badge from this field.
          isPublished: Array.isArray(p.read) && p.read.length > 0
            ? p.read.includes('public')
            : p.isPublished === true,
          sources: p.sources || {},
          nrptiRecords: p.nrptiRecords || []
        }));

        return res.json([{ searchResults: mapped }]);
      } catch (cosmosErr) {
        console.error('[search] Cosmos DB fallback failed:', cosmosErr.message);
        return res.json([{ searchResults: [] }]);
      }
    } else if (dataset === 'Document') {
      if (keywords) {
        try {
          const access = resolveAccess(req);
          const { filter, empty } = filterFor(access);
          // Projects are scoped on their own id; the same caller, a different index.
          const projectScope = filterFor(access, 'id');

          if (!empty) {
            const { items } = await aiSearch.searchDocuments({
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
                description: doc.description || 'Official document extracted from central registry.'
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

              return res.json([{ searchResults: mappedDocs }]);
            }

            // See the project branch: no matches is an answer, not a reason to list the corpus.
            return res.json([{ searchResults: [] }]);
          }

          return res.json([{ searchResults: [] }]);
        } catch (err) {
          console.error('[search] document search failed, falling back to Cosmos:', err.message);
        }
      }

      // Cosmos DB Fallback & Direct Search
      try {
        const docs = await Document.find(withReadFilter(accessContext.roles), { maxItemCount: pageSize });
        const mappedDocs = docs.map(d => ({
          _id: String(d._id),
          displayName: d.displayName || 'Untitled Document',
          documentFileName: d.s3Key ? d.s3Key.split('/').pop() : 'document.pdf',
          documentType: 'PDF Document',
          project: String(d.project || ''),
          projectName: 'Associated Project',
          // Report the record's real ACL/publication state, not a hardcoded 'public'.
          read: Array.isArray(d.read) && d.read.length > 0 ? d.read : ['public'],
          isPublished: d.isPublished === true,
          description: 'Official document extracted from central registry.'
        }));
        return res.json([{ searchResults: mappedDocs }]);
      } catch (cosmosErr) {
        console.error('[search] Document Cosmos DB fallback failed:', cosmosErr.message);
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
        // resolveAccess, not the Mongo-era roles above: the visibility filter is evaluated BY THE
        // SERVICE alongside the match, so ranking is computed only over rows this caller may read.
        // Roles still come from the verified token only.
        const access = resolveAccess(req);
        const { filter, empty } = filterFor(access);

        // `empty` is the fail-closed branch and it MUST short-circuit here. OData has no `false`
        // literal, so "this caller may see nothing" cannot be expressed as a filter — issuing the
        // request with no filter would return everything.
        if (empty) {
          return res.json([{ searchResults: [] }]);
        }

        const { items } = await aiSearch.searchChunks({
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

        const mappedChunks = items.map(chunk => {
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
        return res.json([{ searchResults: mappedChunks }]);
      } catch (err) {
        // A bounded failure still has to be legible: an empty result caused by a fault is NOT the
        // same fact as "nothing matched". 200 rather than 5xx because the frontend retries 5xx
        // twice at 1s (registry-state.service.ts fetchWithRetry) and lands on an empty chunk list
        // regardless, so a status code only buys latency on every search.
        console.error('[search] chunk search failed:', err.message);
        return res.json([{ searchResults: [] }]);
      }
    } else {
      return res.status(400).json({ error: `Invalid or unsupported dataset: ${dataset}` });
    }
  } catch (err) {
    console.error('[demi-api search] Top-level search error:', err);
    return res.json([{ searchResults: [] }]);
  }
};
