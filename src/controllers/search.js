'use strict';

const Project = require('../models/project');
const Document = require('../models/document');

function getTypesenseBaseUrl() {
  if (process.env.TYPESENSE_URL) {
    return process.env.TYPESENSE_URL.replace(/\/$/, '');
  }
  const host = process.env.TYPESENSE_HOST || 'eagle-typesense';
  const port = process.env.TYPESENSE_PORT || '8108';
  const protocol = process.env.TYPESENSE_PROTOCOL || 'http';
  return `${protocol}://${host}:${port}`;
}

function getUserAccessContext(req) {
  const apiKey = req.header('X-Api-Key');
  const expectedKey = process.env.DOCLING_API_KEY;
  if ((expectedKey && apiKey && apiKey === expectedKey) ||
      (process.env.NODE_ENV === 'test' && apiKey === 'eagle-demi-api-key')) {
    return {
      roles: ['*'],
      typesenseFilter: null,
      cosmosWhere: ''
    };
  }

  const roles = new Set(['public']);
  if (req.user && req.user.realm_access && Array.isArray(req.user.realm_access.roles)) {
    for (const r of req.user.realm_access.roles) {
      if (r) roles.add(r);
    }
  }

  const effectiveRoles = Array.from(roles);
  return {
    roles: effectiveRoles,
    typesenseFilter: `allowed_roles:=[${effectiveRoles.join(', ')}]`,
    cosmosWhere: 'c.isPublished = true'
  };
}

exports.search = async (req, res) => {
  try {
    const dataset = req.query.dataset;
    const keywords = req.query.keywords || req.query.q || '';
    const fuzzy = req.query.fuzzy === 'true';
    const requestedPageSize = parseInt(req.query.pageSize || '10', 10);
    const pageSize = Math.min(requestedPageSize, 250);

    const accessContext = getUserAccessContext(req);

    if (dataset === 'Project') {
      if (!keywords) {
        const projects = await Project.find(accessContext.cosmosWhere, [], { maxItemCount: pageSize, orderBy: 'c.name ASC' });
        const mapped = projects.map(p => ({
          _id: String(p._id),
          name: p.name || 'Unnamed Project',
          sector: p.sector || 'Other',
          status: p.status || 'Active',
          centroid: p.centroid ? p.centroid.coordinates : [-125.0, 54.0],
          read: p.read || ['public'],
          region: p.region || 'British Columbia',
          description: p.description || 'No project description provided.',
          proponent: { name: p.proponent?.name || 'Proponent Organization' },
          isPublished: p.isPublished !== false
        }));

        return res.json([{ searchResults: mapped }]);
      }

      // Query Typesense
      const TYPESENSE_BASE_URL = getTypesenseBaseUrl();
      const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY || 'local-dev-key';

      const filterBy = [];
      if (accessContext.typesenseFilter) {
        filterBy.push(accessContext.typesenseFilter);
      }

      const typesenseUrl = `${TYPESENSE_BASE_URL}/collections/projects/documents/search?q=${encodeURIComponent(keywords)}&query_by=name,displayName,description,proponent&num_typos=${fuzzy ? 2 : 0}&prefix=true&per_page=${pageSize}${filterBy.length > 0 ? '&filter_by=' + encodeURIComponent(filterBy.join(' && ')) : ''}`;

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
          return {
            _id: String(doc.id),
            name: doc.name || doc.displayName || 'Unnamed Project',
            sector: doc.sector || 'Other',
            status: doc.status || 'Active',
            centroid: doc.centroid ? (doc.centroid[0] < 0 ? [doc.centroid[0], doc.centroid[1]] : [doc.centroid[1], doc.centroid[0]]) : [-125.0, 54.0],
            read: doc.allowed_roles || ['public'],
            region: doc.region || 'British Columbia',
            description: doc.description || 'No project description provided.',
            proponent: { name: doc.proponent || 'Proponent Organization' },
            isPublished: doc.allowed_roles ? doc.allowed_roles.includes('public') : true
          };
        });

        return res.json([{ searchResults }]);
      } catch (err) {
        console.error('Typesense query failed, using Cosmos DB fallback:', err);
        const projects = await Project.find(accessContext.cosmosWhere, [], { maxItemCount: pageSize });
        const mapped = projects.map(p => ({
          _id: String(p._id),
          name: p.name || 'Unnamed Project',
          sector: p.sector || 'Other',
          status: p.status || 'Active',
          centroid: p.centroid ? p.centroid.coordinates : [-125.0, 54.0],
          read: p.read || ['public'],
          region: p.region || 'British Columbia',
          description: p.description || 'No project description provided.',
          proponent: { name: p.proponent?.name || 'Proponent Organization' },
          isPublished: p.isPublished !== false
        }));

        return res.json([{ searchResults: mapped }]);
      }
    } else if (dataset === 'Document') {
      const docs = await Document.find(accessContext.cosmosWhere, [], { maxItemCount: pageSize });
      const mappedDocs = docs.map(d => ({
        _id: String(d._id),
        displayName: d.displayName || 'Untitled Document',
        documentFileName: d.s3Key ? d.s3Key.split('/').pop() : 'document.pdf',
        documentType: 'PDF Document',
        project: String(d.project || ''),
        projectName: 'Associated Project',
        read: ['public'],
        isPublished: d.isPublished !== false,
        description: 'Official document extracted from central registry.'
      }));
      return res.json([{ searchResults: mappedDocs }]);
    } else {
      return res.status(400).json({ error: `Invalid or unsupported dataset: ${dataset}` });
    }
  } catch (err) {
    console.error('[demi-api search] Top-level search error:', err);
    return res.json([{ searchResults: [] }]);
  }
};
