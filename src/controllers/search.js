'use strict';

const Project = require('../models/project');
const Document = require('../models/document');

// Helper to determine if the request is administrative / internal
function isAdmin(req) {
  const apiKey = req.header('X-Api-Key');
  const expectedKey = process.env.DOCLING_API_KEY || 'eagle-demi-api-key';
  return apiKey && apiKey === expectedKey;
}

exports.search = async (req, res) => {
  try {
    const dataset = req.query.dataset;
    const keywords = req.query.keywords || req.query.q || '';
    const fuzzy = req.query.fuzzy === 'true';
    const sectorFilter = req.query['and[sector]'] || '';
    // Cap pageSize at 250 to comply with Typesense pagination limits
    const pageSize = Math.min(parseInt(req.query.pageSize || '10', 10), 250);

    const isAuth = isAdmin(req);

    if (dataset === 'Project') {
      // If no keywords are provided, do a simple MongoDB query
      if (!keywords) {
        const baseQuery = isAuth ? {} : { isPublished: true };
        if (sectorFilter && sectorFilter !== 'all') {
          // Check both legacy "sector" field or metadata.trackAttributes.type_name
          baseQuery.$or = [
            { sector: sectorFilter },
            { 'metadata.trackAttributes.type_name': sectorFilter }
          ];
        }
        const projects = await Project.find(baseQuery).limit(pageSize);
        const mapped = projects.map(p => {
          const rawMetadata = p.metadata || {
            trackAttributes: {
              track_project_id: p.trackProjectId || p.id || 'N/A',
              lead_agency: p.leadAgency || 'BC Environmental Assessment Office',
              decision_date: p.eaDecisionDate || null,
              name: p.name,
              description: p.description
            },
            eagleAttributes: {
              _id: p._id,
              name: p.name,
              responsibleEPD: p.responsibleEPD || 'Project Assessment Director',
              locationDescription: p.region || 'British Columbia',
              centroid: p.centroid ? p.centroid.coordinates : [-125.0, 54.0]
            }
          };

          return {
            _id: p._id.toString(),
            name: p.name || 'Unnamed Project',
            sector: p.sector || rawMetadata.trackAttributes?.type_name || 'Other',
            status: p.status || rawMetadata.trackAttributes?.project_state_name || 'Active',
            centroid: p.centroid ? p.centroid.coordinates : [-125.0, 54.0],
            read: p.read || ['public'],
            region: p.region || 'British Columbia',
            description: p.description || rawMetadata.trackAttributes?.description || 'No project description provided.',
            proponent: { name: p.proponent?.name || rawMetadata.trackAttributes?.proponent_name || 'Proponent Organization' },
            metadata: rawMetadata
          };
        });

        return res.json([{ searchResults: mapped }]);
      }

      // If keywords ARE provided, query Typesense
      const TYPESENSE_HOST = process.env.TYPESENSE_HOST || 'eagle-typesense';
      const TYPESENSE_PORT = process.env.TYPESENSE_PORT || '8108';
      const TYPESENSE_PROTOCOL = process.env.TYPESENSE_PROTOCOL || 'http';
      const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY || 'local-dev-key';

      const filterBy = [];
      if (!isAuth) {
        if (process.env.NODE_ENV === 'production') {
          filterBy.push('allowed_roles:=[public]');
        } else {
          filterBy.push('allowed_roles:=[public, sysadmin, staff]');
        }
      }
      if (sectorFilter && sectorFilter !== 'all') {
        filterBy.push(`sector:="${sectorFilter}"`);
      }

      const typesenseUrl = `${TYPESENSE_PROTOCOL}://${TYPESENSE_HOST}:${TYPESENSE_PORT}/collections/projects/documents/search?q=${encodeURIComponent(keywords)}&query_by=name,displayName,description,proponent&num_typos=${fuzzy ? 2 : 0}&per_page=${pageSize}${filterBy.length > 0 ? '&filter_by=' + encodeURIComponent(filterBy.join(' && ')) : ''}`;

      try {
        const typesenseRes = await fetch(typesenseUrl, {
          headers: { 'X-TYPESENSE-API-KEY': TYPESENSE_API_KEY }
        });
        if (!typesenseRes.ok) {
          throw new Error(`Typesense responded with ${typesenseRes.status}`);
        }
        const data = await typesenseRes.json();
        const searchResults = (data.hits || []).map(hit => {
          const doc = hit.document;
          const rawMetadata = {
            trackAttributes: {
              track_project_id: doc.id,
              lead_agency: 'BC Environmental Assessment Office',
              name: doc.name || doc.displayName,
              description: doc.description,
              type_name: doc.sector
            },
            eagleAttributes: {
              _id: doc.id,
              name: doc.name || doc.displayName,
              locationDescription: doc.region,
              centroid: doc.centroid ? [doc.centroid[1], doc.centroid[0]] : [-125.0, 54.0]
            }
          };

          return {
            _id: doc.id,
            name: doc.name || doc.displayName || 'Unnamed Project',
            sector: doc.sector || 'Other',
            status: doc.status || 'Active',
            centroid: doc.centroid ? [doc.centroid[1], doc.centroid[0]] : [-125.0, 54.0], // Swap to [lng, lat]
            read: doc.allowed_roles || ['public'],
            region: doc.region || 'British Columbia',
            description: doc.description || 'No project description provided.',
            proponent: { name: doc.proponent || 'Proponent Organization' },
            metadata: rawMetadata
          };
        });

        return res.json([{ searchResults }]);
      } catch (err) {
        console.error('Typesense query failed, using MongoDB fallback:', err);
        // Fallback to Mongo regex search
        const regex = new RegExp(keywords, 'i');
        const baseQuery = isAuth ? {} : { isPublished: true };
        baseQuery.$or = [
          { name: regex },
          { description: regex },
          { region: regex }
        ];
        if (sectorFilter && sectorFilter !== 'all') {
          baseQuery.$and = [
            { $or: [{ sector: sectorFilter }, { 'metadata.trackAttributes.type_name': sectorFilter }] }
          ];
        }
        const projects = await Project.find(baseQuery).limit(pageSize);
        const mapped = projects.map(p => {
          const rawMetadata = p.metadata || {
            trackAttributes: {
              track_project_id: p.trackProjectId || p.id || 'N/A',
              lead_agency: p.leadAgency || 'BC Environmental Assessment Office',
              name: p.name,
              description: p.description
            },
            eagleAttributes: {
              _id: p._id,
              name: p.name,
              responsibleEPD: p.responsibleEPD || 'Project Assessment Director',
              locationDescription: p.region || 'British Columbia',
              centroid: p.centroid ? p.centroid.coordinates : [-125.0, 54.0]
            }
          };

          return {
            _id: p._id.toString(),
            name: p.name || 'Unnamed Project',
            sector: p.sector || rawMetadata.trackAttributes?.type_name || 'Other',
            status: p.status || rawMetadata.trackAttributes?.project_state_name || 'Active',
            centroid: p.centroid ? p.centroid.coordinates : [-125.0, 54.0],
            read: p.read || ['public'],
            region: p.region || 'British Columbia',
            description: p.description || rawMetadata.trackAttributes?.description || 'No project description provided.',
            proponent: { name: p.proponent?.name || rawMetadata.trackAttributes?.proponent_name || 'Proponent Organization' },
            metadata: rawMetadata
          };
        });

        return res.json([{ searchResults: mapped }]);
      }
    } else if (dataset === 'Document') {
      if (!keywords) {
        const baseQuery = isAuth ? {} : { isPublished: true };
        const documents = await Document.find(baseQuery).limit(pageSize).sort({ createdAt: -1 });
        const mapped = documents.map(d => {
          return {
            _id: d._id.toString(),
            displayName: d.displayName || 'Untitled Document',
            documentFileName: d.s3Key ? d.s3Key.split('/').pop() : 'document.pdf',
            documentType: 'PDF Document',
            orcsClassification: d.orcsClassification || '34800-20/MOCK',
            project: d.project ? d.project.toString() : '',
            projectName: d.displayName ? d.displayName.split(' - ')[0] : 'Associated Project',
            description: d.displayName || 'Registry Document',
            gatingState: 'admitted'
          };
        });
        return res.json([{ searchResults: mapped }]);
      }

      const TYPESENSE_HOST = process.env.TYPESENSE_HOST || 'eagle-typesense';
      const TYPESENSE_PORT = process.env.TYPESENSE_PORT || '8108';
      const TYPESENSE_PROTOCOL = process.env.TYPESENSE_PROTOCOL || 'http';
      const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY || 'local-dev-key';

      const filterBy = [];
      if (!isAuth) {
        if (process.env.NODE_ENV === 'production') {
          filterBy.push('allowed_roles:=[public]');
        } else {
          filterBy.push('allowed_roles:=[public, sysadmin, staff]');
        }
      }

      // Query document_chunks collection collapsing by documentId!
      const typesenseUrl = `${TYPESENSE_PROTOCOL}://${TYPESENSE_HOST}:${TYPESENSE_PORT}/collections/document_chunks/documents/search?q=${encodeURIComponent(keywords)}&query_by=content&group_by=documentId&group_limit=1&num_typos=${fuzzy ? 2 : 0}&per_page=${pageSize}${filterBy.length > 0 ? '&filter_by=' + encodeURIComponent(filterBy.join(' && ')) : ''}`;

      try {
        const typesenseRes = await fetch(typesenseUrl, {
          headers: { 'X-TYPESENSE-API-KEY': TYPESENSE_API_KEY }
        });
        if (!typesenseRes.ok) {
          throw new Error(`Typesense responded with ${typesenseRes.status}`);
        }
        const data = await typesenseRes.json();
        const searchResults = (data.grouped_hits || []).map(group => {
          const docId = group.group_key[0];
          const firstHit = group.hits[0];
          const doc = firstHit.document;

          let snippet = '';
          if (firstHit.highlights && firstHit.highlights.length > 0) {
            const contentHighlight = firstHit.highlights.find(h => h.field === 'content');
            if (contentHighlight) {
              snippet = contentHighlight.snippet || contentHighlight.value;
            }
          }
          if (!snippet) {
            snippet = doc.content ? doc.content.substring(0, 300) + '...' : '';
          }

          return {
            _id: docId,
            displayName: doc.documentName || 'Untitled Document',
            documentFileName: doc.documentName || 'document.pdf',
            documentType: doc.documentType || 'PDF Document',
            project: doc.projectId || '',
            projectName: doc.projectName || 'Associated Project',
            read: doc.allowed_roles || ['public'],
            description: snippet
          };
        });

        return res.json([{ searchResults }]);
      } catch (err) {
        console.error('Typesense document query failed, using MongoDB fallback:', err);
        // Fallback to Mongo Document text/regex search
        const regex = new RegExp(keywords, 'i');
        const baseQuery = isAuth ? {} : { isPublished: true };
        baseQuery.$or = [
          { displayName: regex },
          { orcsClassification: regex }
        ];
        const documents = await Document.find(baseQuery).limit(pageSize);
        const searchResults = documents.map(d => ({
          _id: d._id.toString(),
          displayName: d.displayName || 'Untitled Document',
          documentFileName: d.displayName || 'document.pdf',
          documentType: 'PDF Document',
          project: d.project ? d.project.toString() : '',
          projectName: 'Associated Project',
          read: d.isPublished ? ['public'] : ['sysadmin'],
          description: 'This is an extracted document from the central registry.'
        }));

        return res.json([{ searchResults }]);
      }
    } else {
      return res.status(400).json({ error: `Invalid or unsupported dataset: ${dataset}` });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
