'use strict';

const Project = require('../models/project');
const Document = require('../models/document');
const mongoose = require('mongoose');

// Escapes regex characters to prevent regex injection (ReDoS)

function escapeRegExp(string) {
  if (!string) return '';
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Dynamically resolves user roles from Keycloak JWT payload or X-Api-Key.
 * Passes user's assigned roles directly to Mongo & Typesense.
 *
 * @param {object} req Express request
 * @returns {object} Access context containing user roles, Typesense filter clause, and Mongo read query
 */
function getUserAccessContext(req) {
  // Handle system-to-system API key if provided
  const apiKey = req.header('X-Api-Key');
  const expectedKey = process.env.DOCLING_API_KEY;
  if ((expectedKey && apiKey && apiKey === expectedKey) ||
      (process.env.NODE_ENV === 'test' && apiKey === 'eagle-demi-api-key')) {
    return {
      roles: ['*'],
      typesenseFilter: null,
      mongoReadClause: null
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
    mongoReadClause: { $or: [{ isPublished: true }, { read: { $in: effectiveRoles } }] }
  };
}


exports.search = async (req, res) => {
  try {
    const dataset = req.query.dataset;
    const keywords = req.query.keywords || req.query.q || '';
    const fuzzy = req.query.fuzzy === 'true';
    const sectorFilter = req.query['and[sector]'] || (req.query.and && req.query.and.sector) || req.query.sector || '';
    const requestedPageSize = parseInt(req.query.pageSize || '10', 10);
    // Cap pageSize at 250 to comply with Typesense pagination limits
    const pageSize = Math.min(requestedPageSize, 250);

    const accessContext = getUserAccessContext(req);
    console.log('[demi-api search] Incoming parameters:', { dataset, keywords, fuzzy, sectorFilter, requestedPageSize, accessRoles: accessContext.roles });

    if (dataset === 'Project') {
      // If no keywords are provided, do a simple MongoDB query
      if (!keywords) {
        const baseQuery = {};
        const queryClauses = [];

        if (accessContext.mongoReadClause) {
          queryClauses.push(accessContext.mongoReadClause);
        }

        if (sectorFilter && sectorFilter !== 'all') {
          let sectorRegex;
          if (sectorFilter.toLowerCase() === 'mining') {
            sectorRegex = /^Mine/i;
          } else {
            sectorRegex = new RegExp(escapeRegExp(sectorFilter), 'i');
          }
          queryClauses.push({
            $or: [
              { sector: sectorRegex },
              { 'metadata.type_name': sectorRegex },
              { 'metadata.trackAttributes.type_name': sectorRegex }
            ]
          });
        }

        if (queryClauses.length > 0) {
          if (queryClauses.length === 1) {
            Object.assign(baseQuery, queryClauses[0]);
          } else {
            baseQuery.$and = queryClauses;
          }
        }
        console.log('[demi-api search] MongoDB Project query built:', JSON.stringify(baseQuery));
        const projects = await Project.find(baseQuery).limit(requestedPageSize);
        console.log('[demi-api search] MongoDB query found raw project count:', projects.length);

        // Pre-fetch all legacy projects in one bulk query to prevent OOM / N+1 query loop
        let legacyMap = new Map();
        let propMap = new Map();

        try {
          if (mongoose.connection && mongoose.connection.db) {
            const projectIds = projects.map(p => p._id);
            const legacyProjects = await mongoose.connection.db.collection('epic')
              .find({ _id: { $in: projectIds } })
              .toArray();
            
            for (const lp of legacyProjects) {
              legacyMap.set(lp._id.toString(), lp);
            }

            // Extract all proponent IDs for bulk pre-fetching
            const proponentIds = [];
            for (const lp of legacyProjects) {
              const legYear = lp.currentLegislationYear || 'legislation_2018';
              const legBlock = lp[legYear] || {};
              if (legBlock.proponent) {
                proponentIds.push(legBlock.proponent);
              }
            }

            if (proponentIds.length > 0) {
              const proponentOrgs = await mongoose.connection.db.collection('epic')
                .find({ _id: { $in: proponentIds } })
                .toArray();
              for (const po of proponentOrgs) {
                propMap.set(po._id.toString(), po);
              }
            }
          }
        } catch (err) {
          console.error('[demi-api search] Failed to pre-fetch bulk legacy data:', err);
        }

        const mapped = projects.map(p => {
          const rawMetadata = p.metadata;
          const pIdStr = p._id.toString();
          
          let legacyProj = null;
          if (!rawMetadata || !rawMetadata.trackAttributes || !rawMetadata.trackAttributes.description) {
            legacyProj = legacyMap.get(pIdStr) || null;
          }

          const description = p.description || 
            rawMetadata?.trackAttributes?.description || 
            legacyProj?.description || 
            (legacyProj && legacyProj.currentLegislationYear && legacyProj[legacyProj.currentLegislationYear]?.description) ||
            '';

          const sector = p.sector || 
            rawMetadata?.type_name ||
            rawMetadata?.trackAttributes?.type_name || 
            legacyProj?.sector || 
            (legacyProj && legacyProj.currentLegislationYear && legacyProj[legacyProj.currentLegislationYear]?.type) ||
            'Other';

          const status = p.status || 
            rawMetadata?.trackAttributes?.project_state_name || 
            legacyProj?.status || 
            (legacyProj && legacyProj.currentLegislationYear && legacyProj[legacyProj.currentLegislationYear]?.status) ||
            'Active';

          let proponentName = 'Proponent Organization';
          if (p.proponent?.name) {
            proponentName = p.proponent.name;
          } else if (rawMetadata?.trackAttributes?.proponent_name) {
            proponentName = rawMetadata.trackAttributes.proponent_name;
          } else if (legacyProj) {
            const legYear = legacyProj.currentLegislationYear || 'legislation_2018';
            const legBlock = legacyProj[legYear] || {};
            if (legBlock.proponent) {
              const propOrg = propMap.get(legBlock.proponent.toString());
              if (propOrg) {
                proponentName = propOrg.name || 'Proponent Organization';
              }
            }
          }

          const finalMetadata = {
            trackAttributes: {
              track_project_id: p.trackProjectId || rawMetadata?.trackAttributes?.track_project_id || legacyProj?.trackProjectId || 'N/A',
              lead_agency: rawMetadata?.trackAttributes?.lead_agency || legacyProj?.leadAgency || 'BC Environmental Assessment Office',
              decision_date: rawMetadata?.trackAttributes?.decision_date || legacyProj?.eaDecisionDate || null,
              name: p.name,
              description: description
            },
            eagleAttributes: {
              _id: p._id,
              name: p.name,
              responsibleEPD: rawMetadata?.eagleAttributes?.responsibleEPD || legacyProj?.responsibleEPD || 'Project Assessment Director',
              locationDescription: p.region || rawMetadata?.eagleAttributes?.locationDescription || legacyProj?.region || 'British Columbia',
              centroid: p.centroid ? p.centroid.coordinates : [-125.0, 54.0]
            }
          };

          return {
            _id: pIdStr,
            name: p.name || 'Unnamed Project',
            sector: sector,
            status: status,
            centroid: p.centroid ? p.centroid.coordinates : [-125.0, 54.0],
            read: p.read || (p.isPublished === false ? ['sysadmin', 'staff'] : ['public']),
            region: p.region || 'British Columbia',
            description: description || 'No project description provided.',
            proponent: { name: proponentName },
            isPublished: p.isPublished !== false && (!p.read || p.read.includes('public')),
            metadata: finalMetadata
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
      if (accessContext.typesenseFilter) {
        filterBy.push(accessContext.typesenseFilter);
      }
      if (sectorFilter && sectorFilter !== 'all') {
        if (sectorFilter.toLowerCase() === 'energy') {
          filterBy.push('sector:="Energy*"');
        } else if (sectorFilter.toLowerCase() === 'mining') {
          filterBy.push('sector:="Mine*"');
        } else {
          filterBy.push(`sector:="${sectorFilter}"`);
        }
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
              centroid: doc.centroid ? (doc.centroid[0] < 0 ? [doc.centroid[0], doc.centroid[1]] : [doc.centroid[1], doc.centroid[0]]) : [-125.0, 54.0]
            }
          };

          return {
            _id: doc.id,
            name: doc.name || doc.displayName || 'Unnamed Project',
            sector: doc.sector || 'Other',
            status: doc.status || 'Active',
            centroid: doc.centroid ? (doc.centroid[0] < 0 ? [doc.centroid[0], doc.centroid[1]] : [doc.centroid[1], doc.centroid[0]]) : [-125.0, 54.0],
            read: doc.allowed_roles || ['public'],
            region: doc.region || 'British Columbia',
            description: doc.description || 'No project description provided.',
            proponent: { name: doc.proponent || 'Proponent Organization' },
            isPublished: doc.allowed_roles ? doc.allowed_roles.includes('public') : true,
            metadata: rawMetadata
          };
        });

        return res.json([{ searchResults }]);
      } catch (err) {
        console.error('Typesense query failed, using MongoDB fallback:', err);
        // Fallback to Mongo regex search
        const escaped = escapeRegExp(keywords);
        const regex = new RegExp(escaped, 'i');
        const baseQuery = accessContext.mongoReadClause ? { ...accessContext.mongoReadClause } : {};
        baseQuery.$or = [
          { name: regex },
          { description: regex },
          { region: regex }
        ];
        if (sectorFilter && sectorFilter !== 'all') {
          let sectorRegex;
          if (sectorFilter.toLowerCase() === 'mining') {
            sectorRegex = /^Mine/i;
          } else {
            sectorRegex = new RegExp(escapeRegExp(sectorFilter), 'i');
          }
          baseQuery.$and = [
            { $or: [{ sector: sectorRegex }, { 'metadata.type_name': sectorRegex }, { 'metadata.trackAttributes.type_name': sectorRegex }] }
          ];
        }
        console.log('[demi-api search] MongoDB Fallback Project query built:', JSON.stringify(baseQuery));
        const projects = await Project.find(baseQuery).limit(pageSize);
        console.log('[demi-api search] MongoDB Fallback query found raw project count:', projects.length);
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
            sector: p.sector || rawMetadata?.type_name || rawMetadata?.trackAttributes?.type_name || 'Other',
            status: p.status || rawMetadata.trackAttributes?.project_state_name || 'Active',
            centroid: p.centroid ? p.centroid.coordinates : [-125.0, 54.0],
            read: p.read || (p.isPublished === false ? ['sysadmin', 'staff'] : ['public']),
            region: p.region || 'British Columbia',
            description: p.description || rawMetadata.trackAttributes?.description || 'No project description provided.',
            proponent: { name: p.proponent?.name || rawMetadata.trackAttributes?.proponent_name || 'Proponent Organization' },
            isPublished: p.isPublished !== false && (!p.read || p.read.includes('public')),
            metadata: rawMetadata
          };
        });

        return res.json([{ searchResults: mapped }]);
      }
    } else if (dataset === 'Document') {
      if (!keywords) {
        const baseQuery = accessContext.mongoReadClause ? { ...accessContext.mongoReadClause } : {};
        const documents = await Document.find(baseQuery).limit(requestedPageSize).sort({ createdAt: -1 });
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
            isPublished: d.isPublished !== false && (!d.read || d.read.includes('public')),
            gatingState: d.isPublished === false || (d.read && !d.read.includes('public')) ? 'staged' : 'admitted'
          };
        });
        return res.json([{ searchResults: mapped }]);
      }

      const TYPESENSE_HOST = process.env.TYPESENSE_HOST || 'eagle-typesense';
      const TYPESENSE_PORT = process.env.TYPESENSE_PORT || '8108';
      const TYPESENSE_PROTOCOL = process.env.TYPESENSE_PROTOCOL || 'http';
      const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY || 'local-dev-key';

      const filterBy = [];
      if (accessContext.typesenseFilter) {
        filterBy.push(accessContext.typesenseFilter);
      }

      const multiSearchUrl = `${TYPESENSE_PROTOCOL}://${TYPESENSE_HOST}:${TYPESENSE_PORT}/multi_search`;
      const multiSearchBody = {
        searches: [
          {
            collection: 'documents',
            q: keywords,
            query_by: 'displayName,documentFileName,description,projectName',
            num_typos: fuzzy ? 2 : 0,
            per_page: pageSize,
            ...(filterBy.length > 0 ? { filter_by: filterBy.join(' && ') } : {})
          },
          {
            collection: 'document_chunks',
            q: keywords,
            query_by: 'content',
            group_by: 'documentId',
            group_limit: 1,
            num_typos: fuzzy ? 2 : 0,
            per_page: pageSize,
            ...(filterBy.length > 0 ? { filter_by: filterBy.join(' && ') } : {})
          }
        ]
      };

      try {
        const response = await fetch(multiSearchUrl, {
          method: 'POST',
          headers: {
            'X-TYPESENSE-API-KEY': TYPESENSE_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(multiSearchBody)
        });

        if (!response.ok) {
          throw new Error(`Typesense multi_search responded with ${response.status}`);
        }

        const data = await response.json();
        const docsData = data.results[0];
        const chunksData = data.results[1];
        const mergedDocsMap = new Map();

        // 1. Process metadata hits from 'documents' collection
        (docsData.hits || []).forEach(hit => {
          const doc = hit.document;
          const docId = doc.id;
          mergedDocsMap.set(docId, {
            _id: docId,
            displayName: doc.displayName || 'Untitled Document',
            documentFileName: doc.documentFileName || 'document.pdf',
            documentType: doc.type || 'PDF Document',
            project: doc.projectId || '',
            projectName: doc.projectName || 'Associated Project',
            read: doc.allowed_roles || ['public'],
            isPublished: doc.allowed_roles ? doc.allowed_roles.includes('public') : true,
            description: doc.description || 'This is an extracted document from the central registry.',
            _source: 'metadata'
          });
        });

        // 2. Process deep-text hits from 'document_chunks' collection
        (chunksData.grouped_hits || []).forEach(group => {
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

          if (mergedDocsMap.has(docId)) {
            const existing = mergedDocsMap.get(docId);
            existing.description = snippet;
            existing._source = 'both';
          } else {
            mergedDocsMap.set(docId, {
              _id: docId,
              displayName: doc.documentName || 'Untitled Document',
              documentFileName: doc.documentName || 'document.pdf',
              documentType: doc.documentType || 'PDF Document',
              project: doc.projectId || '',
              projectName: doc.projectName || 'Associated Project',
              read: doc.allowed_roles || ['public'],
              isPublished: doc.allowed_roles ? doc.allowed_roles.includes('public') : true,
              description: snippet,
              _source: 'content'
            });
          }
        });

        const searchResults = Array.from(mergedDocsMap.values());
        searchResults.sort((a, b) => {
          const scoreMap = { both: 1, metadata: 2, content: 3 };
          return (scoreMap[a._source] || 3) - (scoreMap[b._source] || 3);
        });

        const slicedResults = searchResults.slice(0, pageSize);
        slicedResults.forEach(r => delete r._source);

        return res.json([{ searchResults: slicedResults }]);
      } catch (err) {
        console.error('Typesense document query failed, using MongoDB fallback:', err);
        // Fallback to Mongo Document text/regex search
        const escaped = escapeRegExp(keywords);
        const regex = new RegExp(escaped, 'i');
        const baseQuery = accessContext.mongoReadClause ? { ...accessContext.mongoReadClause } : {};
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
          read: d.read || (d.isPublished === false ? ['sysadmin', 'staff'] : ['public']),
          isPublished: d.isPublished !== false && (!d.read || d.read.includes('public')),
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
