'use strict';

const Project = require('../models/project');
const Document = require('../models/document');
const { rolesFor, readFilter, withReadFilter } = require('../helpers/access');

// The Project and Document branches read through the Mongo-era models. That is transitional —
// this file is on the Phase 8 port list (MIGRATION.md §B) and collapses onto the repositories
// there. The DocumentChunk branch has no backend at all until Azure AI Search lands (TODO.md §B).

/**
 * Once per process, not once per query: a chunk search that returns nothing because there is no
 * backend is a different fact from one that matched nothing, and the log is the only place that
 * distinction survives. Per-query it would be pure noise — the frontend fires this on every
 * keystroke-driven search.
 */
let chunkSearchWarned = false;
function warnChunkSearchUnavailable() {
  if (chunkSearchWarned) return;
  chunkSearchWarned = true;
  console.warn(
    '[search] DocumentChunk search has no backend: Cosmos full-text search was ruled out and ' +
    'Azure AI Search is not built yet (TODO.md §B). Returning empty results, NOT "no matches".'
  );
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
      // Deep Search over extracted document TEXT — NO BACKEND until Azure AI Search lands
      // (TODO.md §B). Cosmos native full-text search was built here and ruled out: fuzzy is a
      // silent no-op even with the preview enrolled, and the frontend sends fuzzy=true on every
      // Deep Search. The `chunks` container carries no full-text policy, so there is nothing left
      // here to query — the empty result is issued without touching Cosmos.
      //
      // 200 with an empty list, not 503: the frontend retries 5xx twice at 1s
      // (registry-state.service.ts fetchWithRetry) and lands on an empty chunk list either way,
      // so a status code only buys ~2s of latency on every search.
      //
      // NO fallback to another source. A fallback here is precisely how the deleted
      // `epic`-collection workarounds came to exist: it turns "no chunk search" into "silently
      // searched something else".
      if (keywords) {
        warnChunkSearchUnavailable();
      }
      return res.json([{ searchResults: [] }]);
    } else {
      return res.status(400).json({ error: `Invalid or unsupported dataset: ${dataset}` });
    }
  } catch (err) {
    console.error('[demi-api search] Top-level search error:', err);
    return res.json([{ searchResults: [] }]);
  }
};
