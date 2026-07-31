'use strict';

const Project = require('../models/project');
const Document = require('../models/document');
const { rolesFor, readFilter, withReadFilter } = require('../helpers/access');

// The DocumentChunk branch runs on the NoSQL layer; the Project and Document branches above it
// still read through the Mongo-era models. That split is transitional — this file is on the
// Phase 8 port list (MIGRATION.md §B) and both halves collapse onto the repositories there.
const { resolveAccess } = require('../helpers/access-sql');
const chunksRepo = require('../repositories/chunks');
const documentsRepo = require('../repositories/documents');
const projectsRepo = require('../repositories/projects');

/** Characters that would otherwise let stored document text inject markup into the snippet. */
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

const SNIPPET_RADIUS = 150;

/**
 * The matched span of a chunk, with the search terms marked.
 *
 * Cosmos full-text search returns no highlights, so this replaces what Typesense used to supply.
 * The result is rendered with [innerHTML], so the document text is escaped FIRST and the <mark>
 * tags are added afterwards — chunk content is extracted from arbitrary uploaded PDFs and must
 * never reach the DOM as markup.
 *
 * Falls back to the head of the chunk when no term matches literally, which happens legitimately:
 * Cosmos matches on stems and fuzzy edits, so "assessed" is a hit for "assess".
 */
function buildSnippet(content, terms) {
  const text = String(content || '');
  if (!text || terms.length === 0) return escapeHtml(text.slice(0, SNIPPET_RADIUS * 2));

  const pattern = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const finder = new RegExp(pattern, 'iu');
  const hit = text.search(finder);

  const start = hit < 0 ? 0 : Math.max(0, hit - SNIPPET_RADIUS);
  const window = text.slice(start, start + SNIPPET_RADIUS * 2);

  // Split on a CAPTURING group so matches land on odd indices, then escape each piece
  // individually. Escaping the whole window first and marking afterwards would let a term like
  // "amp" match inside an `&amp;` entity and break it.
  const marked = window
    .split(new RegExp(`(${pattern})`, 'giu'))
    .map((part, i) => (i % 2 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part)))
    .join('');

  return (start > 0 ? '…' : '') + marked + (start + SNIPPET_RADIUS * 2 < text.length ? '…' : '');
}

function getTypesenseBaseUrl() {
  if (process.env.TYPESENSE_URL) {
    return process.env.TYPESENSE_URL.replace(/\/$/, '');
  }
  const host = process.env.TYPESENSE_HOST || 'eagle-typesense';
  const port = process.env.TYPESENSE_PORT || '8108';
  const protocol = process.env.TYPESENSE_PROTOCOL || 'http';
  return `${protocol}://${host}:${port}`;
}

/**
 * Visibility context for this request.
 *
 * Roles come from the verified token only (helpers/auth.js populates req.user; the
 * X-Api-Key service path sets the privileged roles there too). Both the Typesense filter
 * and the Mongo filter are derived from the SAME role list, so the two search backends
 * can no longer disagree about what a caller may see.
 */
function getUserAccessContext(req) {
  const roles = rolesFor(req);
  const mongoFilter = readFilter(roles);
  const isPrivileged = Object.keys(mongoFilter).length === 0;

  return {
    roles,
    // Privileged callers get no filter_by, matching the unfiltered Mongo read.
    typesenseFilter: isPrivileged ? null : `allowed_roles:=[${roles.join(', ')}]`,
    mongoFilter
  };
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
      // Query Typesense when search keywords are present. When listing without keywords, query Cosmos DB directly to return all database projects.
      if (keywords) {
        const TYPESENSE_BASE_URL = getTypesenseBaseUrl();
        const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY || 'local-dev-key';

        const filterBy = [];
        if (accessContext.typesenseFilter) {
          filterBy.push(accessContext.typesenseFilter);
        }

        const q = keywords;
        const typesenseUrl = `${TYPESENSE_BASE_URL}/collections/projects/documents/search?q=${encodeURIComponent(q)}&query_by=name,displayName,description,proponent&num_typos=${fuzzy ? 2 : 0}&prefix=true&per_page=${resultPageSize}${filterBy.length > 0 ? '&filter_by=' + encodeURIComponent(filterBy.join(' && ')) : ''}`;

        try {
          const typesenseRes = await fetch(typesenseUrl, {
            headers: { 'X-TYPESENSE-API-KEY': TYPESENSE_API_KEY }
          });
          if (typesenseRes.ok) {
            const data = await typesenseRes.json();
            const hits = data.hits || [];
            if (hits.length > 0) {
              const searchResults = hits.map(hit => {
                const doc = hit.document;
                return {
                  _id: String(doc.id),
                  id: String(doc.id),
                  trackProjectId: doc.trackProjectId || doc.id,
                  legacyEagleId: doc.legacyEagleId || doc.eagleId || '',
                  name: doc.name || doc.displayName || 'Unnamed Project',
                  sector: doc.sector || 'Other',
                  status: doc.status || 'Active',
                  centroid: doc.centroid ? (doc.centroid[0] < 0 ? [doc.centroid[0], doc.centroid[1]] : [doc.centroid[1], doc.centroid[0]]) : [-125.0, 54.0],
                  read: doc.allowed_roles || ['public'],
                  region: doc.region || 'British Columbia',
                  description: doc.description || 'No project description provided.',
                  proponent: { name: doc.proponent || 'Proponent Organization' },
                  isPublished: doc.allowed_roles ? doc.allowed_roles.includes('public') : true,
                  sources: doc.sources || { nrpti: { recordCount: doc.nrptiRecords ? doc.nrptiRecords.length : 0 } },
                  nrptiRecords: doc.nrptiRecords || []
                };
              });

              return res.json([{ searchResults }]);
            }
          } else {
            console.warn(`[search] Typesense project search HTTP ${typesenseRes.status}, falling back to Cosmos DB`);
          }
        } catch (err) {
          console.error('[search] Typesense query failed, falling back to Cosmos DB:', err.message);
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
        const TYPESENSE_BASE_URL = getTypesenseBaseUrl();
        const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY || 'local-dev-key';

        const filterBy = [];
        if (accessContext.typesenseFilter) {
          filterBy.push(accessContext.typesenseFilter);
        }

        const q = keywords;
        const typesenseUrl = `${TYPESENSE_BASE_URL}/collections/documents/documents/search?q=${encodeURIComponent(q)}&query_by=displayName,documentFileName,description,projectName&num_typos=${fuzzy ? 2 : 0}&prefix=true&per_page=${resultPageSize}${filterBy.length > 0 ? '&filter_by=' + encodeURIComponent(filterBy.join(' && ')) : ''}`;

        try {
          const typesenseRes = await fetch(typesenseUrl, {
            headers: { 'X-TYPESENSE-API-KEY': TYPESENSE_API_KEY }
          });
          if (typesenseRes.ok) {
            const data = await typesenseRes.json();
            const hits = data.hits || [];
            if (hits.length > 0) {
              const mappedDocs = hits.map(hit => {
                const doc = hit.document;
                return {
                  _id: String(doc.id),
                  displayName: doc.displayName || 'Untitled Document',
                  documentFileName: doc.documentFileName || 'document.pdf',
                  documentType: doc.type || 'PDF Document',
                  project: String(doc.projectId || ''),
                  projectName: doc.projectName || 'Associated Project',
                  read: doc.allowed_roles || ['public'],
                  isPublished: doc.allowed_roles ? doc.allowed_roles.includes('public') : true,
                  description: doc.description || 'Official document extracted from central registry.'
                };
              });
              return res.json([{ searchResults: mappedDocs }]);
            }
          } else {
            console.warn(`[search] Typesense document search HTTP ${typesenseRes.status}, falling back to Cosmos DB`);
          }
        } catch (err) {
          console.error('[search] Document Typesense query failed, falling back to Cosmos DB:', err.message);
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
      // Deep Search over extracted document TEXT — served from Cosmos DB native full-text search.
      //
      // The chunk corpus is 2.92M rows / 8.61 GB of indexed text, which needs 17-26 GB of RAM in
      // Typesense against an 8 GiB Container Apps Consumption ceiling. The text already lives in
      // Cosmos, so it is searched where it is (MIGRATION.md §F).
      //
      // NO fallback to another source on an empty result. A fallback that fires on zero rows is
      // precisely how the deleted `epic`-collection workarounds came to exist: it turns
      // "extraction has not run" into "silently searched something else". An empty result here
      // means no chunks matched, and says so.
      if (!keywords) {
        return res.json([{ searchResults: [] }]);
      }

      try {
        // resolveAccess, not the Mongo-era roles above: the visibility predicate is composed into
        // the same WHERE clause as the full-text match, so ranking is computed only over rows this
        // caller may read. Roles still come from the verified token only.
        const access = resolveAccess(req);
        const { items } = await chunksRepo.searchText(access, {
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

        const terms = chunksRepo.tokenize(keywords);
        const mappedChunks = items.map(chunk => {
          const parent = docById.get(String(chunk.documentId));
          const project = projById.get(String(chunk.projectId));
          return {
            _id: String(chunk.id),
            documentId: String(chunk.documentId || ''),
            project: String(chunk.projectId || ''),
            projectName: (project && project.name) || 'Associated Project',
            documentName:
              (parent && (parent.displayName || parent.documentFileName)) || 'Untitled Document',
            documentType: (parent && parent.type) || 'PDF Document',
            pageNumber: chunk.pageNumber ?? 0,
            content: chunk.content || '',
            // The matched span, so the UI can show why this hit matched without re-searching.
            snippet: buildSnippet(chunk.content, terms),
            read: Array.isArray(chunk.read) && chunk.read.length > 0 ? chunk.read : ['public']
          };
        });
        return res.json([{ searchResults: mappedChunks }]);
      } catch (err) {
        console.error('[search] Chunk full-text query failed:', err.message);
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
